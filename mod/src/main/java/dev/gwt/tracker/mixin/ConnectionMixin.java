package dev.gwt.tracker.mixin;

import dev.gwt.tracker.PacketTap;
import io.netty.channel.ChannelHandlerContext;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.Packet;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 패킷이 처리되기 전(네트워크 스레드)에서 메시지를 엿본다.
 * Wynntils 등 다른 모드가 채팅을 숨기거나 바꿔도 원본 메시지를 볼 수 있다.
 * 패킷을 취소하거나 바꾸지 않으므로 다른 모드 동작에 영향이 없다.
 */
@Mixin(Connection.class)
public abstract class ConnectionMixin {
    @Inject(
            method = "channelRead0(Lio/netty/channel/ChannelHandlerContext;Lnet/minecraft/network/protocol/Packet;)V",
            at = @At("HEAD")
    )
    private void guildwartracker$onPacket(ChannelHandlerContext ctx, Packet<?> packet, CallbackInfo ci) {
        PacketTap.onPacket(packet);
    }
}
