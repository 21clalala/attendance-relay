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
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 선생님의 Apps Script 웹 앱으로만 통신한다. 다른 서버로는 아무것도 보내지 않는다.
 * 대기열 항목 종류
 *   kind=msg : 걸러진 메시지 전달
 *   kind=set : 담임이 고른 유형·사유 저장
 */
final class Relay {
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final Object LOCK = new Object();
    private static final long MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000; // 3일 넘게 못 보낸 건 폐기

    private Relay() {}

    static final class Result {
        final boolean ok;
        final String message;
        final JSONObject json;
        Result(boolean ok, String message, JSONObject json) {
            this.ok = ok; this.message = message; this.json = json;
        }
    }

    /** 걸러진 메시지를 대기열에 넣고 전송 시도 */
    static void enqueue(Context ctx, String app, String sender, String text, long ts) {
        try {
            JSONObject o = new JSONObject();
            o.put("kind", "msg");
            o.put("app", app);
            o.put("sender", sender);
            o.put("text", text);
            o.put("ts", ts);
            add(ctx, o);
        } catch (Exception ignored) {
        }
    }

    /** 담임이 고른 유형·사유를 대기열에 넣고 전송 시도 */
    static void enqueueType(Context ctx, String id, String type, String reason, String who, String text) {
        enqueueType(ctx, id, type, reason, who, text, null);
    }

    static void enqueueType(Context ctx, String id, String type, String reason, String who, String text,
                            Runnable done) {
        try {
            JSONObject o = new JSONObject();
            o.put("kind", "set");
            o.put("id", id);
            o.put("type", type);
            o.put("reason", reason);
            o.put("who", who);
            o.put("text", text);
            o.put("ts", System.currentTimeMillis());
            add(ctx, o, done);
        } catch (Exception e) {
            if (done != null) done.run();
        }
    }

    private static void add(Context ctx, JSONObject o) {
        add(ctx, o, null);
    }

    /**
     * 대기열에 먼저 '디스크에' 기록한 뒤 전송은 백그라운드로 (앱이 곧바로 종료돼도 다음에 재전송됨).
     * LOCK은 대기열 읽기/쓰기에만 잡고, 네트워크 통신 중에는 잡지 않는다 (알림 처리 스레드가 멈추지 않게).
     */
    private static void add(Context ctx, JSONObject o, Runnable done) {
        final Context app = ctx.getApplicationContext();
        try {
            o.put("qid", java.util.UUID.randomUUID().toString());
        } catch (Exception ignored) {
        }
        synchronized (LOCK) {
            Prefs p = new Prefs(app);
            JSONArray q = p.queue();
            q.put(o);
            p.setQueueNow(q);
        }
        flush(app, done);
    }

    /** 대기열 재전송 (앱 화면을 열 때, 알림 서비스가 연결될 때 호출) */
    static void flush(Context ctx) {
        flush(ctx, null);
    }

    /** 전송이 끝나면 done 실행 (알림 버튼 처리에서 프로세스를 그때까지 살려 두기 위해) */
    static void flush(Context ctx, Runnable done) {
        final Context app = ctx.getApplicationContext();
        EXEC.execute(() -> {
            try {
                flushNow(app);
            } finally {
                if (done != null) done.run();
            }
        });
    }

    /** 단일 스레드(EXEC)에서만 실행되므로 동시에 두 번 돌지 않는다 */
    private static void flushNow(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (!p.isConfigured()) return;
        JSONArray q;
        synchronized (LOCK) {
            q = p.queue();
        }
        java.util.Set<String> done = new java.util.HashSet<>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o == null) continue;
            String qid = o.optString("qid");
            long ts = o.optLong("ts", now);
            boolean isSet = "set".equals(o.optString("kind"));
            String who = isSet ? o.optString("who") : o.optString("sender");
            if (now - ts > MAX_AGE_MS) {
                p.addLog(stamp(ts) + "  " + who + "  → 3일 동안 전송 실패, 폐기");
                done.add(qid);
                continue;
            }
            {

                Result r;
                if (isSet) {
                    Map<String, String> f = new LinkedHashMap<>();
                    f.put("action", "settype");
                    f.put("ids", o.optString("id"));
                    f.put("type", o.optString("type"));
                    f.put("reason", o.optString("reason"));
                    r = post(p, f);
                } else {
                    Map<String, String> f = new LinkedHashMap<>();
                    f.put("app", o.optString("app"));
                    f.put("sender", o.optString("sender"));
                    f.put("text", o.optString("text"));
                    f.put("ts", String.valueOf(ts));
                    r = post(p, f);
                }

                if (r.ok) {
                    done.add(qid);
                    if (isSet) {
                        String t = o.optString("type") + (o.optString("reason").isEmpty() ? "" : "·" + o.optString("reason"));
                        p.addLog(stamp(now) + "  " + who + "  → " + t + " 저장");
                        Notifier.showSaved(ctx, o.optString("id"), who, t);
                    } else {
                        JSONObject j = r.json;
                        // att=false: 출결과 무관해 보이는 대화 → 기록만 하고 알림은 띄우지 않음
                        // (att 값이 없는 예전 Apps Script면 기존처럼 알림)
                        boolean att = j == null || j.optBoolean("att", true);
                        p.addLog(stamp(ts) + "  " + who + "  → 전송됨" + (att ? "" : " (기타 대화)"));
                        if (att && j != null && j.optBoolean("stored") && !j.optString("id").isEmpty()) {
                            Notifier.showAsk(ctx, j.optString("id"), j.optInt("no"), j.optString("name"),
                                    j.optString("rel"), j.optString("type"), o.optString("text"),
                                    j.optString("date"), j.optString("recvDate"));
                        }
                    }
                } else {
                    p.addLog(stamp(ts) + "  " + who + "  → 대기 (" + r.message + ")");
                }
            }
        }
        if (done.isEmpty()) return;
        // 처리하는 동안 새로 들어온 항목은 그대로 두고, 끝난 항목만 제거
        synchronized (LOCK) {
            JSONArray cur = p.queue();
            JSONArray remain = new JSONArray();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject o = cur.optJSONObject(i);
                if (o != null && !done.contains(o.optString("qid"))) remain.put(o);
            }
            p.setQueueNow(remain);
        }
    }

    /** 설정 화면의 '연결 테스트' 버튼용 (메인 스레드에서 부르지 말 것) */
    static Result testConnection(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (!p.isConfigured()) return new Result(false, "URL·비밀키·패턴을 먼저 저장하세요.", null);
        Map<String, String> f = new LinkedHashMap<>();
        f.put("test", "1");
        return post(p, f);
    }

    private static Result post(Prefs p, Map<String, String> fields) {
        HttpURLConnection c = null;
        try {
            StringBuilder sb = new StringBuilder("secret=").append(enc(p.secret()));
            for (Map.Entry<String, String> e : fields.entrySet()) {
                sb.append('&').append(e.getKey()).append('=').append(enc(e.getValue()));
            }
            byte[] bytes = sb.toString().getBytes(StandardCharsets.UTF_8);

            c = (HttpURLConnection) new URL(p.url()).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }

            int code = c.getResponseCode();
            // Apps Script는 doPost 실행 후 결과를 다른 주소로 302 리다이렉트함 → 그 주소를 GET으로 읽음
            for (int hop = 0; hop < 3 && code >= 300 && code < 400; hop++) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) break;
                c = (HttpURLConnection) new URL(new URL(p.url()), loc).openConnection();
                c.setRequestMethod("GET");
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(false);
                code = c.getResponseCode();
            }
            String resp = read(code < 400 ? c.getInputStream() : c.getErrorStream());
            JSONObject j = null;
            try { j = new JSONObject(resp); } catch (Exception ignored) { }
            if (j != null && j.optBoolean("ok")) return new Result(true, "성공", j);
            if (j != null && "auth".equals(j.optString("error"))) return new Result(false, "비밀키 불일치", j);
            if (j != null) return new Result(false, j.optString("error", "오류"), j);
            if (code == 200) return new Result(false, "응답이 JSON이 아님 — Apps Script를 '새 버전'으로 배포했는지 확인", null);
            if (code == 401 || code == 403) return new Result(false, "HTTP " + code + " — 배포 '액세스: 모든 사용자', '실행: 나' 확인", null);
            if (code == 404) return new Result(false, "HTTP 404 — 웹 앱 URL(…/exec) 확인", null);
            return new Result(false, "HTTP " + code, null);
        } catch (Exception e) {
            return new Result(false, "네트워크 오류", null);
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
