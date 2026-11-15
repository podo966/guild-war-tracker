package dev.gwt.tracker;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 메시지를 보고 전쟁 시작/승리/패배를 판정한다. (마인크래프트 의존 없음)
 * 이탈 판정(30분 초과, 새 전쟁 참여)은 서버가 최종적으로 처리한다.
 */
public final class WarTracker {

    public enum Source { CHAT, TITLE, SUBTITLE, ACTIONBAR, BOSSBAR }
    public enum Kind { QUEUE, START, WIN, LOSS, TERRITORY }

    public record Match(Kind kind, String territory, String pattern) {}

    /** 업로드 대상 (Uploader가 구현) */
    public interface Sink {
        void post(String path, Map<String, Object> body);
    }

    private record Compiled(List<Pattern> queue, List<Pattern> start, List<Pattern> win, List<Pattern> loss, List<Pattern> boss, List<String> errors) {}

    public static final class ActiveWar {
        public final String id;
        public final String territory;
        public final long startedAt;
        public final String playerUuid;

        ActiveWar(String id, String territory, long startedAt, String playerUuid) {
            this.id = id;
            this.territory = territory;
            this.startedAt = startedAt;
            this.playerUuid = playerUuid;
        }
    }

    private final Sink sink;
    private volatile GwtConfig config;
    private volatile Compiled compiled;
    private ActiveWar active; // 메인 스레드에서만 접근
    private String queuedTerritory; // 대기열 메시지에서 기억한 영토
    private long queuedAt;
    private static final long QUEUE_MEMORY_MS = 10 * 60_000L;
    private String bossTerritory; // 보스바에서 읽은 영토 (전장 안에서만 보임)
    private long bossAt;
    private static final long BOSS_MEMORY_MS = 2 * 60_000L;
    private static final long BOSS_FIX_WINDOW_MS = 5 * 60_000L;

    public WarTracker(GwtConfig config, Sink sink) {
        this.sink = sink;
        reload(config);
    }

    public void reload(GwtConfig cfg) {
        List<String> errors = new ArrayList<>();
        Compiled c = new Compiled(
                compile(cfg.queuePatterns, "queuePatterns", errors),
                compile(cfg.startPatterns, "startPatterns", errors),
                compile(cfg.winPatterns, "winPatterns", errors),
                compile(cfg.lossPatterns, "lossPatterns", errors),
                compile(cfg.bossbarPatterns, "bossbarPatterns", errors),
                List.copyOf(errors));
        for (String e : errors) GwtLog.warn(e);
        this.config = cfg;
        this.compiled = c;
    }

    public List<String> patternErrors() { return compiled.errors(); }

    public ActiveWar active() { return active; }

    private static List<Pattern> compile(List<String> src, String name, List<String> errors) {
        List<Pattern> out = new ArrayList<>();
        for (int i = 0; i < src.size(); i++) {
            String p = src.get(i);
            if (p == null || p.isBlank()) continue;
            try {
                out.add(Pattern.compile(p));
            } catch (PatternSyntaxException e) {
                errors.add(name + "[" + i + "] invalid regex: " + e.getDescription());
            }
        }
        return out;
    }

    private Match matchChat(String text) {
        Compiled c = compiled;
        Match m = find(text, c.win(), Kind.WIN);
        if (m == null) m = find(text, c.loss(), Kind.LOSS);
        if (m == null) m = find(text, c.start(), Kind.START);
        if (m == null) m = find(text, c.queue(), Kind.QUEUE);
        return m;
    }

    /** /gwt test용: 모든 패턴 검사. 결과 메시지를 먼저 본다. */
    public Match match(String text) {
        Compiled c = compiled;
        Match m = find(text, c.win(), Kind.WIN);
        if (m == null) m = find(text, c.loss(), Kind.LOSS);
        if (m == null) m = find(text, c.start(), Kind.START);
        if (m == null) m = find(text, c.queue(), Kind.QUEUE);
        if (m == null) m = find(text, c.boss(), Kind.TERRITORY);
        return m;
    }

    private static Match find(String text, List<Pattern> patterns, Kind kind) {
        for (Pattern p : patterns) {
            Matcher m = p.matcher(text);
            if (m.find()) {
                String territory = null;
                try {
                    territory = m.group("territory");
                } catch (IllegalArgumentException ignored) {
                    // territory 그룹이 없는 패턴
                }
                if (territory != null) {
                    territory = territory.trim();
                    if (territory.isEmpty()) territory = null;
                }
                return new Match(kind, territory, p.pattern());
            }
        }
        return null;
    }

    /**
     * @return 채팅 알림용 설명 (아무 일도 없으면 null)
     */
    public String onMessage(Source src, String text, long now, UUID playerUuid, String playerName) {
        GwtConfig cfg = config;
        long timeoutMs = cfg.warTimeoutMinutes * 60_000L;

        if (active != null && now - active.startedAt > timeoutMs) {
            GwtLog.info("No result after " + cfg.warTimeoutMinutes + " min: " + active.territory + " (server marks it as left)");
            active = null;
        }

        // 보스바는 보스바 패턴으로만, 채팅 등은 채팅 패턴으로만 검사
        Match m = src == Source.BOSSBAR ? find(text, compiled.boss(), Kind.TERRITORY) : matchChat(text);
        if (m == null) return null;
        String uuid = playerUuid.toString();

        switch (m.kind()) {
            case TERRITORY -> {
                if (m.territory() == null) return null;
                bossTerritory = m.territory();
                bossAt = now;
                // 전투 시작 직후 보스바로 영토가 확인되면, 대기열로 추정한 영토를 바로잡음
                if (active != null && active.playerUuid.equals(uuid)
                        && now - active.startedAt <= BOSS_FIX_WINDOW_MS
                        && !sameTerritory(active.territory, m.territory())) {
                    active = new ActiveWar(active.id, m.territory(), active.startedAt, active.playerUuid);
                    Map<String, Object> body = new LinkedHashMap<>();
                    body.put("id", active.id);
                    body.put("uuid", uuid);
                    body.put("territory", active.territory);
                    sink.post("/api/war/territory", body);
                    GwtLog.info("War territory corrected from boss bar: " + active.territory);
                    return null; // 채팅 알림 없음 (참여/승리/패배만 표시)
                }
                return null;
            }
            case QUEUE -> {
                queuedTerritory = m.territory();
                queuedAt = now;
                return null;
            }
            case START -> {
                // 영토 우선순위: 시작 메시지 자체 > 최근 보스바 > 대기열 메시지
                String territory = m.territory();
                if (territory == null && bossTerritory != null && now - bossAt <= BOSS_MEMORY_MS) {
                    territory = bossTerritory;
                }
                if (territory == null && queuedTerritory != null && now - queuedAt <= QUEUE_MEMORY_MS) {
                    territory = queuedTerritory;
                }
                queuedTerritory = null;
                m = new Match(Kind.START, territory, m.pattern());
                if (active != null
                        && active.playerUuid.equals(uuid)
                        && sameTerritory(active.territory, m.territory())
                        && now - active.startedAt < cfg.startDedupSeconds * 1000L) {
                    return null; // 같은 전쟁의 반복 메시지
                }
                ActiveWar war = new ActiveWar(UUID.randomUUID().toString(), m.territory(), now, uuid);
                active = war;

                Map<String, Object> body = new LinkedHashMap<>();
                body.put("id", war.id);
                body.put("uuid", uuid);
                body.put("name", playerName);
                body.put("territory", war.territory);
                body.put("startedAt", now);
                if (!cfg.guildNameOverride.isEmpty()) body.put("guild", cfg.guildNameOverride);
                sink.post("/api/war/start", body);

                String t = war.territory != null ? war.territory : "Unknown territory";
                return "War joined: " + t;
            }
            case WIN, LOSS -> {
                if (active == null) return null; // 내가 참여하지 않은 전쟁 (길드 알림 등)
                if (!active.playerUuid.equals(uuid)) return null;
                if (m.territory() != null && active.territory != null
                        && !normalize(m.territory()).equals(normalize(active.territory))) {
                    return null; // 다른 영토의 결과 메시지
                }
                ActiveWar war = active;
                active = null;

                Map<String, Object> body = new LinkedHashMap<>();
                body.put("id", war.id);
                body.put("uuid", uuid);
                body.put("result", m.kind() == Kind.WIN ? "win" : "loss");
                body.put("endedAt", now);
                sink.post("/api/war/end", body);

                String t = war.territory != null ? war.territory : "Unknown territory";
                return (m.kind() == Kind.WIN ? "War won: " : "War lost: ") + t;
            }
        }
        return null;
    }

    private static boolean sameTerritory(String a, String b) {
        if (a == null || b == null) return a == null && b == null;
        return normalize(a).equals(normalize(b));
    }

    private static String normalize(String s) {
        return s.trim().toLowerCase(Locale.ROOT);
    }
}
