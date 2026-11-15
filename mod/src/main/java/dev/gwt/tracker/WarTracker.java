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

    public enum Source { CHAT, TITLE, SUBTITLE, ACTIONBAR }
    public enum Kind { START, WIN, LOSS }

    public record Match(Kind kind, String territory, String pattern) {}

    /** 업로드 대상 (Uploader가 구현) */
    public interface Sink {
        void post(String path, Map<String, Object> body);
    }

    private record Compiled(List<Pattern> start, List<Pattern> win, List<Pattern> loss, List<String> errors) {}

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

    public WarTracker(GwtConfig config, Sink sink) {
        this.sink = sink;
        reload(config);
    }

    public void reload(GwtConfig cfg) {
        List<String> errors = new ArrayList<>();
        Compiled c = new Compiled(
                compile(cfg.startPatterns, "startPatterns", errors),
                compile(cfg.winPatterns, "winPatterns", errors),
                compile(cfg.lossPatterns, "lossPatterns", errors),
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
                errors.add(name + "[" + i + "] 정규식 오류: " + e.getDescription());
            }
        }
        return out;
    }

    /** 결과 메시지를 먼저 검사한다 (시작 패턴이 넓게 잡혀도 승패가 우선). */
    public Match match(String text) {
        Compiled c = compiled;
        Match m = find(text, c.win(), Kind.WIN);
        if (m == null) m = find(text, c.loss(), Kind.LOSS);
        if (m == null) m = find(text, c.start(), Kind.START);
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
            GwtLog.info("전쟁 결과 없이 " + cfg.warTimeoutMinutes + "분 경과: " + active.territory + " (서버에서 이탈 처리)");
            active = null;
        }

        Match m = match(text);
        if (m == null) return null;
        String uuid = playerUuid.toString();

        switch (m.kind()) {
            case START -> {
                if (active != null
                        && active.playerUuid.equals(uuid)
                        && sameTerritory(active.territory, m.territory())
                        && now - active.startedAt < cfg.startDedupSeconds * 1000L) {
                    return null; // 같은 전쟁의 반복 메시지
                }
                String previous = active != null ? active.territory : null;
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

                String t = war.territory != null ? war.territory : "알 수 없는 영토";
                return previous != null
                        ? "전쟁 참여 기록: " + t + " (이전 전쟁은 이탈 처리)"
                        : "전쟁 참여 기록: " + t;
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

                String t = war.territory != null ? war.territory : "알 수 없는 영토";
                return (m.kind() == Kind.WIN ? "전쟁 승리 기록: " : "전쟁 패배 기록: ") + t;
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
