package dev.gwt.tracker;

import java.util.function.BiConsumer;

/** 마인크래프트 의존 없는 간단한 로그 래퍼. 모드 초기화 시 SLF4J로 연결된다. */
public final class GwtLog {
    private static volatile BiConsumer<String, String> sink =
            (level, msg) -> System.out.println("[GuildWarTracker/" + level + "] " + msg);

    private GwtLog() {}

    public static void setSink(BiConsumer<String, String> s) { sink = s; }

    public static void info(String msg) { sink.accept("INFO", msg); }
    public static void warn(String msg) { sink.accept("WARN", msg); }
    public static void error(String msg) { sink.accept("ERROR", msg); }
}
