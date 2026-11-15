package dev.gwt.tracker;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.User;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.util.Locale;

public final class GuildWarTrackerClient implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("GuildWarTracker");
    private static volatile GuildWarTrackerClient instance;

    private Path configFile;
    private volatile GwtConfig config;
    private WarTracker tracker;
    private Uploader uploader;
    private CaptureLog capture;

    public static GuildWarTrackerClient get() { return instance; }

    @Override
    public void onInitializeClient() {
        GwtLog.setSink((level, msg) -> {
            switch (level) {
                case "WARN" -> LOGGER.warn(msg);
                case "ERROR" -> LOGGER.error(msg);
                default -> LOGGER.info(msg);
            }
        });

        Path dir = FabricLoader.getInstance().getConfigDir();
        configFile = dir.resolve("guildwartracker.json");
        config = GwtConfig.load(configFile);
        uploader = new Uploader(dir.resolve("guildwartracker-queue.json"), () -> config);
        tracker = new WarTracker(config, uploader);
        capture = new CaptureLog(dir.resolve("guildwartracker-capture.log"));

        ClientCommandRegistrationCallback.EVENT.register(
                (dispatcher, registryAccess) -> GwtCommands.register(dispatcher, this));
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> uploader.shutdown());

        instance = this;
        LOGGER.info("Guild War Tracker 로드됨 (서버 설정: {})", config.serverUrl.isEmpty() ? "없음" : config.serverUrl);
    }

    /** 메인 스레드에서 호출 */
    void onMessage(WarTracker.Source src, String text, long ts) {
        if (capture.enabled() && (src != WarTracker.Source.ACTIONBAR || config.captureActionbar)) {
            capture.write(src, text, ts);
        }
        if (src == WarTracker.Source.ACTIONBAR && !config.matchActionbar) return;
        if (config.onlyOnWynncraft && !isOnWynncraft()) return;

        User user = Minecraft.getInstance().getUser();
        if (user == null || user.getProfileId() == null) return;

        String note = tracker.onMessage(src, text, ts, user.getProfileId(), user.getName());
        if (note != null) {
            LOGGER.info(note);
            if (config.chatFeedback) feedback(note);
        }
    }

    boolean wantsActionbar() {
        GwtConfig c = config;
        return c.matchActionbar || (capture != null && capture.enabled() && c.captureActionbar);
    }

    static boolean isOnWynncraft() {
        ServerData sd = Minecraft.getInstance().getCurrentServer();
        return sd != null && sd.ip != null && sd.ip.toLowerCase(Locale.ROOT).contains("wynncraft");
    }

    static void feedback(String msg) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.gui == null) return;
        mc.gui.getChat().addMessage(prefix().append(Component.literal(msg).withStyle(ChatFormatting.WHITE)));
    }

    static net.minecraft.network.chat.MutableComponent prefix() {
        return Component.literal("[GWT] ").withStyle(ChatFormatting.GOLD);
    }

    /** 설정 파일 다시 읽기. 성공하면 정규식 오류 목록(없으면 빈 목록) 반환 */
    java.util.List<String> reload() {
        config = GwtConfig.load(configFile);
        tracker.reload(config);
        uploader.flush();
        return tracker.patternErrors();
    }

    /** 게임 안 명령어로 설정 값을 바꾸고 파일에 저장 */
    synchronized void updateConfig(java.util.function.Consumer<GwtConfig> edit) throws java.io.IOException {
        GwtConfig c = GwtConfig.load(configFile);
        edit.accept(c);
        c.normalize();
        c.save(configFile);
        config = c;
        tracker.reload(c);
        uploader.flush();
    }

    GwtConfig config() { return config; }
    WarTracker tracker() { return tracker; }
    Uploader uploader() { return uploader; }
    CaptureLog capture() { return capture; }
}
