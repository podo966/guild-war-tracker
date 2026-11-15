package dev.gwt.tracker;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * 이벤트를 순서대로 Worker에 전송한다.
 * 실패하면 파일에 보관해 두고 재시도하므로 게임을 껐다 켜도 기록이 사라지지 않는다.
 */
public final class Uploader implements WarTracker.Sink {
    private static final Gson GSON = new Gson();
    private static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    private static final long MIN_BACKOFF_MS = 15_000;
    private static final long MAX_BACKOFF_MS = 5 * 60_000;

    static final class Event {
        String path;
        String json;
        long createdAt;

        Event() {}

        Event(String path, String json, long createdAt) {
            this.path = path;
            this.json = json;
            this.createdAt = createdAt;
        }
    }

    private final Path queueFile;
    private final Supplier<GwtConfig> config;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "GuildWarTracker-Uploader");
        t.setDaemon(true);
        return t;
    });

    // 아래 필드는 exec 스레드에서만 접근
    private final Deque<Event> queue = new ArrayDeque<>();
    private boolean retryScheduled = false;
    private long backoffMs = MIN_BACKOFF_MS;

    private final AtomicInteger pending = new AtomicInteger();
    private volatile String lastStatus = "nothing sent yet";

    public Uploader(Path queueFile, Supplier<GwtConfig> config) {
        this.queueFile = queueFile;
        this.config = config;
        exec.execute(() -> {
            load();
            drain();
        });
    }

    @Override
    public void post(String path, Map<String, Object> body) {
        Event ev = new Event(path, GSON.toJson(body), System.currentTimeMillis());
        exec.execute(() -> {
            queue.addLast(ev);
            pending.set(queue.size());
            persist();
            drain();
        });
    }

    /** 대기 중인 이벤트를 즉시 재전송 */
    public void flush() {
        exec.execute(() -> {
            backoffMs = MIN_BACKOFF_MS;
            drain();
        });
    }

    public int pendingCount() { return pending.get(); }

    public String lastStatus() { return lastStatus; }

    public void shutdown() {
        exec.execute(this::persist);
        exec.shutdown();
        try {
            exec.awaitTermination(3, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void drain() {
        while (!queue.isEmpty()) {
            GwtConfig cfg = config.get();
            if (cfg.serverUrl.isEmpty()) {
                lastStatus = "server URL not set - " + queue.size() + " event(s) kept";
                return;
            }
            Event ev = queue.peekFirst();
            if (System.currentTimeMillis() - ev.createdAt > MAX_AGE_MS) {
                GwtLog.warn("Dropping event older than 7 days: " + ev.path);
                removeHead();
                continue;
            }

            int status;
            String body;
            try {
                HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(cfg.serverUrl + ev.path))
                        .timeout(Duration.ofSeconds(15))
                        .header("Content-Type", "application/json")
                        .header("User-Agent", "GuildWarTracker/1.0")
                        .POST(HttpRequest.BodyPublishers.ofString(ev.json, StandardCharsets.UTF_8));
                // 서버에 API_KEY를 등록한 경우에만 필요
                if (!cfg.apiKey.isEmpty()) rb.header("Authorization", "Bearer " + cfg.apiKey);
                HttpRequest req = rb.build();
                HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
                status = res.statusCode();
                body = res.body();
            } catch (Exception e) {
                lastStatus = "send failed (network): " + e.getClass().getSimpleName() + " - " + queue.size() + " pending";
                scheduleRetry();
                return;
            }

            if (status >= 200 && status < 300) {
                lastStatus = "sent (" + ev.path + ")";
                backoffMs = MIN_BACKOFF_MS;
                removeHead();
            } else if (status == 401 || status == 403) {
                // 키가 틀린 경우: 버리지 않고 보관. 설정의 apiKey 수정 후 게임 재시작
                lastStatus = "auth failed (" + status + ") - check apiKey in config and restart";
                GwtLog.warn(lastStatus);
                return;
            } else if (status >= 400 && status < 500 && status != 408 && status != 429) {
                lastStatus = "rejected by server (" + status + "): " + truncate(body);
                GwtLog.warn(lastStatus + " / dropped event: " + ev.json);
                removeHead();
            } else {
                lastStatus = "server error (" + status + ") - " + queue.size() + " pending";
                scheduleRetry();
                return;
            }
        }
    }

    private void removeHead() {
        queue.pollFirst();
        pending.set(queue.size());
        persist();
    }

    private void scheduleRetry() {
        if (retryScheduled) return;
        retryScheduled = true;
        long delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        exec.schedule(() -> {
            retryScheduled = false;
            drain();
        }, delay, TimeUnit.MILLISECONDS);
    }

    private void load() {
        try {
            if (Files.exists(queueFile)) {
                List<Event> list = GSON.fromJson(Files.readString(queueFile, StandardCharsets.UTF_8),
                        new TypeToken<List<Event>>() {}.getType());
                if (list != null) {
                    for (Event e : list) {
                        if (e != null && e.path != null && e.json != null) queue.addLast(e);
                    }
                }
                pending.set(queue.size());
                if (!queue.isEmpty()) GwtLog.info("Loaded " + queue.size() + " unsent event(s)");
            }
        } catch (Exception e) {
            GwtLog.error("Failed to read upload queue: " + e);
        }
    }

    private void persist() {
        try {
            Files.createDirectories(queueFile.getParent());
            Path tmp = queueFile.resolveSibling(queueFile.getFileName() + ".tmp");
            Files.writeString(tmp, GSON.toJson(new ArrayList<>(queue)), StandardCharsets.UTF_8);
            Files.move(tmp, queueFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            GwtLog.error("Failed to save upload queue: " + e);
        }
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() > 200 ? s.substring(0, 200) + "…" : s;
    }
}
