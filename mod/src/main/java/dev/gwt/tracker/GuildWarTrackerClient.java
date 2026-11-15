package dev.gwt.tracker;

import net.fabricmc.api.ClientModInitializer;
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

/**
 * 명령어 없음. 설정은 config/guildwartracker.json (게임 시작 시 1회 읽음).
 * 채팅 알림은 전쟁 참여 / 승리 / 패배 세 가지만 표시한다.
 */
public final class GuildWarTrackerClient implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("GuildWarTracker");
    private static volatile GuildWarTrackerClient instance;

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
        config = GwtConfig.load(dir.resolve("guildwartracker.json"));
        uploader = new Uploader(dir.resolve("guildwartracker-queue.json"), () -> config);
        tracker = new WarTracker(config, uploader);
        capture = new CaptureLog(dir.resolve("guildwartracker-capture.log"));
        if (config.captureMessages) capture.setEnabled(true);

        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> uploader.shutdown());

        instance = this;
        LOGGER.info("Guild War Tracker loaded (server: {})", config.serverUrl);
    }

    /** Called on the main thread */
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
        mc.gui.getChat().addMessage(Component.literal("[GWT] ").withStyle(ChatFormatting.GOLD)
                .append(Component.literal(msg).withStyle(ChatFormatting.WHITE)));
    }
}
