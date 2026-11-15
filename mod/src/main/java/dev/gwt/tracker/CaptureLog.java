package dev.gwt.tracker;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * /gwt capture on 상태에서 받은 채팅·타이틀·서브타이틀을 파일에 그대로 남긴다.
 * 전쟁 메시지 패턴을 찾을 때 쓴다. (latest.log에는 타이틀이 안 남기 때문)
 */
public final class CaptureLog {
    private static final DateTimeFormatter FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private final Path file;
    private volatile boolean enabled;

    public CaptureLog(Path file) {
        this.file = file;
    }

    public Path file() { return file; }

    public boolean enabled() { return enabled; }

    public void setEnabled(boolean on) {
        enabled = on;
        write(null, on ? "===== capture started =====" : "===== capture stopped =====", System.currentTimeMillis(), true);
    }

    public void write(WarTracker.Source src, String text, long ts) {
        write(src, text, ts, false);
    }

    private void write(WarTracker.Source src, String text, long ts, boolean force) {
        if (!enabled && !force) return;
        String line = "[" + FMT.format(Instant.ofEpochMilli(ts)) + "] "
                + (src != null ? "[" + src + "] " : "") + text + System.lineSeparator();
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception e) {
            GwtLog.error("Failed to write capture log: " + e);
        }
    }
}
