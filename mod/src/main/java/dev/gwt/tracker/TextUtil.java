package dev.gwt.tracker;

/** 서버에서 받은 문자열을 정규식 비교용 평문으로 정리한다. */
public final class TextUtil {
    private TextUtil() {}

    /**
     * - § 색상/서식 코드 제거
     * - Wynncraft가 배지/아이콘에 쓰는 사용자 정의 폰트 글리프(Private Use Area) 제거
     * - 줄바꿈·제어문자를 공백으로 바꾸고 연속 공백을 하나로 합침
     */
    public static String clean(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(raw.length());
        int i = 0;
        int len = raw.length();
        while (i < len) {
            int cp = raw.codePointAt(i);
            int n = Character.charCount(cp);
            if (cp == '§') {
                // 서식 코드 문자까지 같이 건너뜀
                i += n;
                if (i < len) i += Character.charCount(raw.codePointAt(i));
                continue;
            }
            if (isPrivateUse(cp)) {
                i += n;
                continue;
            }
            if (Character.isISOControl(cp) || Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                sb.append(' ');
            } else {
                sb.appendCodePoint(cp);
            }
            i += n;
        }
        return sb.toString().replaceAll(" {2,}", " ").trim();
    }

    private static boolean isPrivateUse(int cp) {
        return (cp >= 0xE000 && cp <= 0xF8FF)
                || (cp >= 0xF0000 && cp <= 0xFFFFD)
                || (cp >= 0x100000 && cp <= 0x10FFFD);
    }
}
