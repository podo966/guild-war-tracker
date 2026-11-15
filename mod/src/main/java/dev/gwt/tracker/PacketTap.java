package dev.gwt.tracker;

import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBundlePacket;
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;

/** 네트워크 스레드에서 호출됨. 텍스트만 뽑아서 메인 스레드로 넘긴다. */
public final class PacketTap {
    private PacketTap() {}

    public static void onPacket(Packet<?> packet) {
        try {
            if (packet instanceof ClientboundBundlePacket bundle) {
                for (Packet<?> p : bundle.subPackets()) onPacket(p);
            } else if (packet instanceof ClientboundSystemChatPacket p) {
                dispatch(p.overlay() ? WarTracker.Source.ACTIONBAR : WarTracker.Source.CHAT, p.content());
            } else if (packet instanceof ClientboundSetTitleTextPacket p) {
                dispatch(WarTracker.Source.TITLE, p.text());
            } else if (packet instanceof ClientboundSetSubtitleTextPacket p) {
                dispatch(WarTracker.Source.SUBTITLE, p.text());
            } else if (packet instanceof ClientboundSetActionBarTextPacket p) {
                dispatch(WarTracker.Source.ACTIONBAR, p.text());
            }
        } catch (Throwable t) {
            GwtLog.error("패킷 처리 중 오류: " + t);
        }
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
