package kr.school.attendancerelay;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;

/** 설정값과 작은 상태(전송 대기열, 중복 방지 목록, 전송 기록)를 기기 안에만 저장한다. */
final class Prefs {
    static final String PKG_SAMSUNG_MSG = "com.samsung.android.messaging";
    static final String PKG_GOOGLE_MSG = "com.google.android.apps.messaging";
    static final String PKG_KAKAO = "com.kakao.talk";

    private static final String NAME = "relay";
    private static final String K_URL = "url";
    private static final String K_SECRET = "secret";
    private static final String K_PREFIX = "prefix";
    private static final String K_APPS = "apps";
    private static final String K_QUEUE = "queue";
    private static final String K_SEEN = "seen";
    private static final String K_LOG = "log";

    private final SharedPreferences sp;

    Prefs(Context c) {
        sp = c.getApplicationContext().getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    String url() { return sp.getString(K_URL, ""); }
    String secret() { return sp.getString(K_SECRET, ""); }
    /**
     * 발신자 이름 패턴(정규식). 공백을 지운 이름에 적용.
     * 기본값: 학생 2630201권민준 / 학부모 #30201권민준어머니 형식
     * (26=연도, 3=학년, 02=반, 01=번호)
     */
    static final String DEFAULT_PATTERN = "^(26302|#302)\\d{2}";

    String prefix() { return sp.getString(K_PREFIX, DEFAULT_PATTERN); }

    Set<String> apps() {
        Set<String> def = new HashSet<>();
        def.add(PKG_SAMSUNG_MSG);
        def.add(PKG_GOOGLE_MSG);
        def.add(PKG_KAKAO);
        return new HashSet<>(sp.getStringSet(K_APPS, def));
    }

    boolean isConfigured() {
        return url().startsWith("https://") && !secret().isEmpty() && compile(prefix()) != null;
    }

    /** 패턴이 잘못되었으면 null (null이면 아무것도 전달하지 않음) */
    static java.util.regex.Pattern compile(String pattern) {
        if (pattern == null || pattern.trim().isEmpty()) return null;
        try {
            return java.util.regex.Pattern.compile(pattern.trim());
        } catch (Exception e) {
            return null;
        }
    }

    void save(String url, String secret, String prefix, Set<String> apps) {
        sp.edit()
                .putString(K_URL, url.trim())
                .putString(K_SECRET, secret.trim())
                .putString(K_PREFIX, prefix.trim())
                .putStringSet(K_APPS, new HashSet<>(apps))
                .apply();
    }

    /* ---- 전송 대기열 (전송 성공 시 즉시 삭제) ---- */

    JSONArray queue() { return readArray(K_QUEUE); }

    /** 디스크에 즉시 기록 (프로세스가 바로 종료돼도 대기열이 남도록) */
    void setQueueNow(JSONArray a) { sp.edit().putString(K_QUEUE, a.toString()).commit(); }

    /* ---- 중복 방지: 메시지 해시만 저장, 내용은 저장하지 않음 ---- */

    synchronized boolean markSeen(String key) {
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        JSONArray a = readArray(K_SEEN);
        for (int i = 0; i < a.length(); i++) seen.add(a.optString(i));
        if (seen.contains(key)) return false;
        seen.add(key);
        JSONArray out = new JSONArray();
        int skip = Math.max(0, seen.size() - 300);
        int i = 0;
        for (String s : seen) {
            if (i++ >= skip) out.put(s);
        }
        sp.edit().putString(K_SEEN, out.toString()).apply();
        return true;
    }

    /* ---- 화면에 보여줄 전송 기록: 시각·발신자·결과만 (메시지 내용 없음) ---- */

    synchronized void addLog(String line) {
        JSONArray a = readArray(K_LOG);
        JSONArray out = new JSONArray();
        out.put(line);
        for (int i = 0; i < a.length() && i < 29; i++) out.put(a.optString(i));
        sp.edit().putString(K_LOG, out.toString()).apply();
    }

    String logText() {
        JSONArray a = readArray(K_LOG);
        if (a.length() == 0) return "아직 전송 기록이 없습니다.";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length(); i++) sb.append(a.optString(i)).append('\n');
        return sb.toString();
    }

    private JSONArray readArray(String key) {
        try {
            return new JSONArray(sp.getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
