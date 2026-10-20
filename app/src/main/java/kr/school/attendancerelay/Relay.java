package kr.school.attendancerelay;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 걸러진 메시지를 선생님의 Apps Script 웹 앱으로만 보낸다. 다른 서버로는 아무것도 보내지 않는다. */
final class Relay {
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final Object LOCK = new Object();
    private static final long MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000; // 3일 넘게 못 보낸 건 폐기

    private Relay() {}

    static final class Result {
        final boolean ok;
        final String message;
        Result(boolean ok, String message) { this.ok = ok; this.message = message; }
    }

    /** 대기열에 넣고 백그라운드에서 전송 시도 */
    static void enqueue(Context ctx, String app, String sender, String text, long ts) {
        final Context app_ = ctx.getApplicationContext();
        EXEC.execute(() -> {
            synchronized (LOCK) {
                try {
                    Prefs p = new Prefs(app_);
                    JSONArray q = p.queue();
                    JSONObject o = new JSONObject();
                    o.put("app", app);
                    o.put("sender", sender);
                    o.put("text", text);
                    o.put("ts", ts);
                    q.put(o);
                    p.setQueue(q);
                } catch (Exception ignored) {
                }
            }
            flushNow(app_);
        });
    }

    /** 대기열 재전송 (앱 화면을 열 때, 새 알림이 올 때 호출) */
    static void flush(Context ctx) {
        final Context app_ = ctx.getApplicationContext();
        EXEC.execute(() -> flushNow(app_));
    }

    private static void flushNow(Context ctx) {
        synchronized (LOCK) {
            Prefs p = new Prefs(ctx);
            if (!p.isConfigured()) return;
            JSONArray q = p.queue();
            JSONArray remain = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < q.length(); i++) {
                JSONObject o = q.optJSONObject(i);
                if (o == null) continue;
                long ts = o.optLong("ts", now);
                String sender = o.optString("sender");
                if (now - ts > MAX_AGE_MS) {
                    p.addLog(stamp(ts) + "  " + sender + "  → 3일 동안 전송 실패, 폐기");
                    continue;
                }
                Result r = post(p.url(), p.secret(), o.optString("app"), sender, o.optString("text"), ts, false);
                if (r.ok) {
                    p.addLog(stamp(ts) + "  " + sender + "  → 전송됨");
                } else {
                    remain.put(o);
                    p.addLog(stamp(ts) + "  " + sender + "  → 대기 (" + r.message + ")");
                }
            }
            p.setQueue(remain);
        }
    }

    /** 설정 화면의 '연결 테스트' 버튼용 (메인 스레드에서 부르지 말 것) */
    static Result testConnection(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (!p.isConfigured()) return new Result(false, "URL·비밀키·패턴을 먼저 저장하세요.");
        return post(p.url(), p.secret(), "테스트", "연결 테스트", "앱 연결 테스트", System.currentTimeMillis(), true);
    }

    private static Result post(String url, String secret, String app, String sender,
                               String text, long ts, boolean test) {
        HttpURLConnection c = null;
        try {
            String body = "secret=" + enc(secret)
                    + "&app=" + enc(app)
                    + "&sender=" + enc(sender)
                    + "&text=" + enc(text)
                    + "&ts=" + ts
                    + (test ? "&test=1" : "");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);

            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setInstanceFollowRedirects(true); // Apps Script는 실행 후 결과 페이지로 리다이렉트함
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }

            int code = c.getResponseCode();
            String resp = read(code < 400 ? c.getInputStream() : c.getErrorStream());
            if (resp.contains("\"ok\":true")) return new Result(true, "성공");
            if (resp.contains("\"error\":\"auth\"")) return new Result(false, "비밀키 불일치");
            if (code >= 300 && code < 400) return new Result(true, "성공(리다이렉트)");
            return new Result(false, "HTTP " + code);
        } catch (Exception e) {
            return new Result(false, "네트워크 오류");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s == null ? "" : s, "UTF-8");
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        try (InputStream is = in) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0 && bos.size() < 65536) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        }
    }

    static String stamp(long ts) {
        return new SimpleDateFormat("MM/dd HH:mm", Locale.KOREA).format(new Date(ts));
    }
}
