package dev.gwt.tracker;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;

import java.util.List;

import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.argument;
import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.literal;

/**
 * /gwt status          현재 상태
 * /gwt capture on|off  받은 메시지를 config/guildwartracker-capture.log 에 기록
 * /gwt reload          설정 파일 다시 읽기
 * /gwt seturl <주소>    Worker 주소 변경 (default = 기본 주소)
 * /gwt setkey <키>      API 키 저장
 * /gwt setguild <이름>  길드명 고정 (auto = 자동 조회)
 * /gwt flush           미전송 이벤트 즉시 재전송
 * /gwt test <문장>     문장이 어떤 패턴에 걸리는지 확인 (전송 안 함)
 */
final class GwtCommands {
    private GwtCommands() {}

    static void register(CommandDispatcher<FabricClientCommandSource> d, GuildWarTrackerClient mod) {
        d.register(literal("gwt")
                .executes(ctx -> status(ctx, mod))
                .then(literal("status").executes(ctx -> status(ctx, mod)))
                .then(literal("capture")
                        .then(literal("on").executes(ctx -> {
                            mod.capture().setEnabled(true);
                            send(ctx, "캡처 시작 → " + mod.capture().file().getFileName()
                                    + " (전쟁 한 판 끝나면 /gwt capture off)");
                            return 1;
                        }))
                        .then(literal("off").executes(ctx -> {
                            mod.capture().setEnabled(false);
                            send(ctx, "캡처 종료. 파일: config/" + mod.capture().file().getFileName());
                            return 1;
                        })))
                .then(literal("reload").executes(ctx -> {
                    List<String> errors = mod.reload();
                    if (errors.isEmpty()) {
                        send(ctx, "설정을 다시 읽었습니다.");
                    } else {
                        send(ctx, "설정을 읽었지만 정규식 오류가 있습니다:");
                        errors.forEach(e -> sendWarn(ctx, " - " + e));
                    }
                    return 1;
                }))
                .then(literal("seturl")
                        .then(argument("url", StringArgumentType.greedyString()).executes(ctx -> {
                            String input = StringArgumentType.getString(ctx, "url").trim();
                            String url = input.equalsIgnoreCase("default") ? GwtConfig.DEFAULT_SERVER_URL : input;
                            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                                sendWarn(ctx, "주소는 https:// 로 시작해야 합니다.");
                                return 0;
                            }
                            return save(ctx, mod, c -> c.serverUrl = url, "서버 주소 저장: " + url);
                        })))
                .then(literal("setkey")
                        .then(argument("key", StringArgumentType.greedyString()).executes(ctx -> {
                            String key = StringArgumentType.getString(ctx, "key").trim();
                            return save(ctx, mod, c -> c.apiKey = key, "API 키 저장 완료");
                        })))
                .then(literal("setguild")
                        .then(argument("name", StringArgumentType.greedyString()).executes(ctx -> {
                            String name = StringArgumentType.getString(ctx, "name").trim();
                            boolean auto = name.equals("-") || name.equalsIgnoreCase("auto");
                            return save(ctx, mod, c -> c.guildNameOverride = auto ? "" : name,
                                    auto ? "길드: 자동 조회로 설정" : "길드 고정: " + name);
                        })))
                .then(literal("flush").executes(ctx -> {
                    mod.uploader().flush();
                    send(ctx, "재전송 요청함 (대기 " + mod.uploader().pendingCount() + "건)");
                    return 1;
                }))
                .then(literal("test")
                        .then(argument("text", StringArgumentType.greedyString()).executes(ctx -> {
                            String text = TextUtil.clean(StringArgumentType.getString(ctx, "text"));
                            WarTracker.Match m = mod.tracker().match(text);
                            if (m == null) {
                                sendWarn(ctx, "어떤 패턴에도 걸리지 않음");
                            } else {
                                send(ctx, "판정: " + m.kind() + " / 영토: "
                                        + (m.territory() != null ? m.territory() : "(없음)"));
                                send(ctx, "패턴: " + m.pattern());
                            }
                            return 1;
                        }))));
    }

    private static int status(CommandContext<FabricClientCommandSource> ctx, GuildWarTrackerClient mod) {
        GwtConfig c = mod.config();
        send(ctx, "서버: " + (c.serverUrl.isEmpty() ? "미설정" : c.serverUrl)
                + " / API 키: " + (c.apiKey.isEmpty() ? "없음(키 없이 전송)" : "설정됨"));
        WarTracker.ActiveWar w = mod.tracker().active();
        if (w == null) {
            send(ctx, "진행 중인 전쟁: 없음");
        } else {
            long min = (System.currentTimeMillis() - w.startedAt) / 60_000;
            send(ctx, "진행 중인 전쟁: " + (w.territory != null ? w.territory : "알 수 없는 영토")
                    + " (" + min + "분 경과)");
        }
        send(ctx, "전송 대기: " + mod.uploader().pendingCount() + "건 / 최근 상태: " + mod.uploader().lastStatus());
        send(ctx, "캡처: " + (mod.capture().enabled() ? "켜짐" : "꺼짐")
                + " / Wynncraft 접속: " + (GuildWarTrackerClient.isOnWynncraft() ? "예" : "아니오"));
        for (String e : mod.tracker().patternErrors()) sendWarn(ctx, e);
        return 1;
    }

    private static int save(CommandContext<FabricClientCommandSource> ctx, GuildWarTrackerClient mod,
                            java.util.function.Consumer<GwtConfig> edit, String okMsg) {
        try {
            mod.updateConfig(edit);
            send(ctx, okMsg);
            return 1;
        } catch (Exception e) {
            sendWarn(ctx, "설정 저장 실패: " + e.getMessage());
            return 0;
        }
    }

    private static void send(CommandContext<FabricClientCommandSource> ctx, String msg) {
        ctx.getSource().sendFeedback(GuildWarTrackerClient.prefix().append(Component.literal(msg)));
    }

    private static void sendWarn(CommandContext<FabricClientCommandSource> ctx, String msg) {
        ctx.getSource().sendFeedback(GuildWarTrackerClient.prefix()
                .append(Component.literal(msg).withStyle(ChatFormatting.RED)));
    }
}
