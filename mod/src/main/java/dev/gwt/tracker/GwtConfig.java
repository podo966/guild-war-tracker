package dev.gwt.tracker;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * config/guildwartracker.json
 * 전쟁 감지 정규식은 실제 로그를 측정한 뒤 여기서 바꾸면 된다 (게임 안에서 /gwt reload).
 */
public final class GwtConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    public String _readme = "정규식은 Java 문법. (?<territory>...) 이름 그룹이 있으면 영토 이름으로 저장됨. "
            + "메시지가 바뀌면 /gwt capture on 으로 실제 메시지를 확인한 뒤 수정하고 /gwt reload 하세요.";

    /** 기본 Worker 주소. 설정 파일에서 비워 두면 이 주소를 사용 */
    public static final String DEFAULT_SERVER_URL = "https://guild-war-tracker.wartracker.workers.dev";

    /** Cloudflare Worker 주소 (다른 서버를 쓸 때만 변경) */
    public String serverUrl = DEFAULT_SERVER_URL;
    /** Worker에 설정한 API_KEY 비밀값 */
    public String apiKey = "";
    /** 비워 두면 서버가 Wynncraft API로 소속 길드를 조회한다. 값을 넣으면 이 길드명으로 고정. */
    public String guildNameOverride = "";

    /** Wynncraft 서버에 접속했을 때만 감지 */
    public boolean onlyOnWynncraft = true;
    /** 기록될 때 채팅창에 알림 표시 */
    public boolean chatFeedback = true;
    /** 액션바 메시지도 정규식 검사 대상에 포함 (보통 필요 없음) */
    public boolean matchActionbar = false;
    /** 캡처 모드에서 액션바도 파일에 기록 (매우 많으니 기본 끔) */
    public boolean captureActionbar = false;

    /** 같은 영토의 시작 메시지가 이 시간 안에 반복되면 중복으로 무시 (카운트다운 메시지 대비) */
    public int startDedupSeconds = 180;
    /** 시작 후 이 시간 동안 결과가 없으면 이탈 처리 (서버도 같은 규칙 적용) */
    public int warTimeoutMinutes = 30;

    /** 설정 형식 버전. 낮으면 감지 패턴을 새 기본값으로 교체 */
    public static final int CURRENT_VERSION = 4;
    public int configVersion = 0; // 파일에 없으면 0 → 예전 설정으로 보고 패턴 갱신

    /** 전쟁 대기열 메시지: 기록하지 않고 영토 이름만 기억해 둠 */
    public List<String> queuePatterns = defaultQueue();
    /** 전쟁 참여(전투 시작)로 볼 메시지. territory 그룹이 없으면 대기열에서 기억한 영토를 씀 */
    public List<String> startPatterns = defaultStart();
    /** 승리로 볼 메시지 */
    public List<String> winPatterns = defaultWin();
    /** 패배로 볼 메시지 */
    public List<String> lossPatterns = defaultLoss();
    /** 전장 보스바에서 영토 이름을 읽는 패턴 (가장 정확한 영토 정보) */
    public List<String> bossbarPatterns = defaultBoss();

    // 2026-11-16 실제 Wynncraft 로그 기준
    static List<String> defaultQueue() {
        return new ArrayList<>(List.of("^The war for (?<territory>.+?) will start in "));
    }
    static List<String> defaultStart() {
        return new ArrayList<>(List.of("^The battle has begun!?$"));
    }
    static List<String> defaultWin() {
        return new ArrayList<>(List.of("^You have taken control of (?<territory>.+?) from "));
    }
    static List<String> defaultBoss() {
        // 실제 예: "[ETKW] Entrance to Almuj Tower - ❤ 390000 (10.0%) - ☠ 1300-1949 (0.5x)"
        // " Tower - ❤"까지 요구해서 이름에 Tower가 들어간 몹 보스바와 구분
        return new ArrayList<>(List.of("^(?:\\[[A-Za-z0-9]{2,4}\\] )?(?<territory>.+?) Tower - ❤"));
    }
    static List<String> defaultLoss() {
        return new ArrayList<>(List.of("^Your guild has lost the war for (?<territory>.+?)[.!]?$"));
    }

    public static GwtConfig load(Path file) {
        try {
            if (Files.notExists(file)) {
                GwtConfig def = new GwtConfig();
                def.configVersion = CURRENT_VERSION;
                def.save(file);
                GwtLog.info("기본 설정 파일 생성: " + file);
                return def;
            }
            String json = Files.readString(file, StandardCharsets.UTF_8);
            GwtConfig cfg = GSON.fromJson(json, GwtConfig.class);
            if (cfg == null) cfg = new GwtConfig();
            if (cfg.configVersion < CURRENT_VERSION) {
                // 예전 추정 패턴을 실제 로그 기반 패턴으로 교체 (서버 주소 등 다른 값은 유지)
                cfg.queuePatterns = defaultQueue();
                cfg.startPatterns = defaultStart();
                cfg.winPatterns = defaultWin();
                cfg.lossPatterns = defaultLoss();
                cfg.bossbarPatterns = defaultBoss();
                cfg.configVersion = CURRENT_VERSION;
                cfg.normalize();
                cfg.save(file);
                GwtLog.info("감지 패턴을 새 기본값으로 업데이트했습니다.");
                return cfg;
            }
            cfg.normalize();
            return cfg;
        } catch (Exception e) {
            GwtLog.error("설정 파일을 읽지 못했습니다 (기본값 사용, 파일은 그대로 둠): " + e);
            return new GwtConfig();
        }
    }

    public void save(Path file) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, GSON.toJson(this), StandardCharsets.UTF_8);
    }

    void normalize() {
        if (serverUrl == null) serverUrl = "";
        serverUrl = serverUrl.trim();
        while (serverUrl.endsWith("/")) serverUrl = serverUrl.substring(0, serverUrl.length() - 1);
        if (serverUrl.isEmpty()) serverUrl = DEFAULT_SERVER_URL;
        if (apiKey == null) apiKey = "";
        apiKey = apiKey.trim();
        if (guildNameOverride == null) guildNameOverride = "";
        guildNameOverride = guildNameOverride.trim();
        if (queuePatterns == null) queuePatterns = new ArrayList<>();
        if (startPatterns == null) startPatterns = new ArrayList<>();
        if (winPatterns == null) winPatterns = new ArrayList<>();
        if (lossPatterns == null) lossPatterns = new ArrayList<>();
        if (bossbarPatterns == null) bossbarPatterns = new ArrayList<>();
        if (startDedupSeconds < 0) startDedupSeconds = 0;
        if (warTimeoutMinutes <= 0) warTimeoutMinutes = 30;
    }
}
