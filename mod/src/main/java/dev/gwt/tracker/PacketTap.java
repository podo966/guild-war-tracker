package dev.gwt.tracker;

import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBossEventPacket;
import net.minecraft.network.protocol.game.ClientboundBundlePacket;
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.world.BossEvent;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 네트워크 스레드에서 호출됨. 텍스트만 뽑아서 메인 스레드로 넘긴다. */
public final class PacketTap {
    private PacketTap() {}

    /** 보스바별 마지막 문구 (숫자를 #으로 바꾼 값). 체력만 바뀌는 갱신은 건너뜀 */
    private static final Map<UUID, String> LAST_BOSSBAR = new ConcurrentHashMap<>();

    private static final ClientboundBossEventPacket.Handler BOSS_HANDLER = new ClientboundBossEventPacket.Handler() {
        @Override
        public void add(UUID id, Component name, float progress, BossEvent.BossBarColor color,
                        BossEvent.BossBarOverlay overlay, boolean darkenScreen, boolean playMusic,
                        boolean createWorldFog) {
            bossbar(id, name);
        }

        @Override
        public void updateName(UUID id, Component name) {
            bossbar(id, name);
        }

        @Override
        public void remove(UUID id) {
            LAST_BOSSBAR.remove(id);
        }
    };

    public static void onPacket(Packet<?> packet) {
        try {
            if (packet instanceof ClientboundBundlePacket bundle) {
                for (Packet<?> p : bundle.subPackets()) onPacket(p);
            } else if (packet instanceof ClientboundSystemChatPacket p) {
                dispatch(p.overlay() ? WarTracker.Source.ACTIONBAR : WarTracker.Source.CHAT, p.content());
            } else if (packet instanceof ClientboundBossEventPacket p) {
                p.dispatch(BOSS_HANDLER);
            } else if (packet instanceof ClientboundSetTitleTextPacket p) {
                dispatch(WarTracker.Source.TITLE, p.text());
            } else if (packet instanceof ClientboundSetSubtitleTextPacket p) {
                dispatch(WarTracker.Source.SUBTITLE, p.text());
            } else if (packet instanceof ClientboundSetActionBarTextPacket p) {
                dispatch(WarTracker.Source.ACTIONBAR, p.text());
            }
        } catch (Throwable t) {
            GwtLog.error("Error while reading packet: " + t);
        }
    }

    private static void bossbar(UUID id, Component name) {
        if (name == null) return;
        String text = TextUtil.clean(name.getString());
        if (text.isEmpty()) return;
        String key = text.replaceAll("[0-9][0-9,.]*", "#");
        if (key.equals(LAST_BOSSBAR.put(id, key))) return;
        dispatch(WarTracker.Source.BOSSBAR, name);
    }

    private static void dispatch(WarTracker.Source src, Component component) {
        GuildWarTrackerClient mod = GuildWarTrackerClient.get();
        if (mod == null || component == null) return;
        if (src == WarTracker.Source.ACTIONBAR && !mod.wantsActionbar()) return;

        String text = TextUtil.clean(component.getString());
        if (text.isEmpty()) return;
        long now = System.currentTimeMillis();
        Minecraft.getInstance().execute(() -> mod.onMessage(src, text, now));
    }
}
