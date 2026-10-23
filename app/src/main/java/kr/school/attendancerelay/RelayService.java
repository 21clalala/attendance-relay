package kr.school.attendancerelay;

import android.app.Notification;
import android.app.Person;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.text.Normalizer;
import java.util.regex.Pattern;

/**
 * 안드로이드가 모든 알림을 이 서비스에 전달한다.
 * 여기서 (1) 지정한 앱이 아니면 버리고, (2) 발신자 이름이 우리반 패턴이 아니면 버린다.
 * 버린 알림의 내용은 어디에도 저장하거나 보내지 않는다.
 * (진단 기록이 켜져 있으면 문자 앱 알림이 걸러진 경우 '발신자 이름'만 이 폰의 전송 기록에 남김)
 */
public class RelayService extends NotificationListenerService {

    private static final long MAX_MSG_AGE_MS = 12L * 60 * 60 * 1000; // 12시간 넘은 메시지는 무시

    @Override
    public void onListenerConnected() {
        Relay.flush(this);
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Throwable ignored) {
            // 알림 하나 처리 실패로 서비스가 죽지 않게 함
        }
    }

    private void handle(StatusBarNotification sbn) {
        Prefs p = new Prefs(this);
        if (!p.isConfigured()) return;
        Pattern pattern = Prefs.compile(p.prefix());
        if (pattern == null) return;

        String pkg = sbn.getPackageName();
        Notification n = sbn.getNotification();
        if (n == null || n.extras == null) return;
        Bundle ex = n.extras;
        String title = str(ex.getCharSequence(Notification.EXTRA_TITLE));
        String convTitle = str(ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE));

        if (!p.apps().contains(pkg)) {                            // (1) 앱 필터
            // 진단: 감시하지 않는 앱인데 알림 제목이 우리반 이름이면 기록 (문자 앱이 다른 경우 찾기용)
            if (p.diag() && !title.isEmpty() && matches(title, pattern)
                    && p.markSeen("diagpkg|" + pkg)) {
                p.addLog(Relay.stamp(System.currentTimeMillis()) + "  " + title
                        + "  → 감시하지 않는 앱의 알림 (" + pkg + ")");
            }
            return;
        }
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

        String appLabel = labelOf(pkg);
        long now = System.currentTimeMillis();
        boolean isSms = !Prefs.PKG_KAKAO.equals(pkg);
        int sent = 0;

        // 메시지형 알림: 한 알림에 여러 메시지·여러 발신자가 들어 있을 수 있음 (단체방 포함)
        Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
        StringBuilder seenSenders = new StringBuilder();
        if (msgs != null && msgs.length > 0) {
            Bundle last = null;
            for (Parcelable item : msgs) {
                if (!(item instanceof Bundle)) continue;
                Bundle m = (Bundle) item;
                String sender = senderOf(m);
                String text = str(m.getCharSequence("text"));
                long ts = m.getLong("time", sbn.getPostTime());
                if (!sender.isEmpty() && seenSenders.indexOf(sender) < 0) {
                    if (seenSenders.length() > 0) seenSenders.append(", ");
                    seenSenders.append(sender);
                }
                if (!text.isEmpty() && !sender.isEmpty()) last = m;
                if (sender.isEmpty() || text.isEmpty()) continue;       // 내가 보낸 메시지 등
                if (!matches(sender, pattern)) continue;                 // (2) 발신자 필터
                if (now - ts > MAX_MSG_AGE_MS) continue;
                sent++;
                if (p.markSeen(hash(pkg, sender, text, ts))) {
                    Relay.enqueue(this, appLabel, clean(sender), text, ts);
                }
            }
            // 메시지 안의 발신자 이름이 연락처 이름이 아닌 경우(일부 문자 앱): 1:1 대화면 알림 제목으로 다시 확인
            boolean group = ex.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false);
            String head = !convTitle.isEmpty() ? convTitle : title;
            if (sent == 0 && !group && last != null && matches(head, pattern)) {
                String text = str(last.getCharSequence("text"));
                long ts = last.getLong("time", sbn.getPostTime());
                if (now - ts <= MAX_MSG_AGE_MS) {
                    sent++;
                    if (p.markSeen(hash(pkg, head, text, ts))) {
                        Relay.enqueue(this, appLabel, clean(head), text, ts);
                    }
                }
            }
        } else {
            // 일반 알림: 제목 = 발신자, 본문 = 메시지
            CharSequence big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
            String text = str(big != null ? big : ex.getCharSequence(Notification.EXTRA_TEXT));
            if (!title.isEmpty() && !text.isEmpty() && matches(title, pattern)) {
                long ts = sbn.getPostTime();
                sent++;
                // 일반 알림은 10분 단위로 중복 판단 (같은 알림이 갱신되어 다시 오는 경우 대비)
                if (p.markSeen(hash(pkg, title, text, ts / (10 * 60 * 1000L)))) {
                    Relay.enqueue(this, appLabel, clean(title), text, ts);
                }
            }
        }

        // 진단: 문자 앱 알림이 왔는데 아무것도 못 보낸 경우, 왜 걸러졌는지 발신자 이름만 기록 (내용은 기록 안 함)
        if (sent == 0 && isSms && p.diag()) {
            String shown = !title.isEmpty() ? title : convTitle;
            String why = msgs != null && msgs.length > 0
                    ? "메시지 속 발신자: " + (seenSenders.length() > 0 ? seenSenders : "없음")
                    : (str(ex.getCharSequence(Notification.EXTRA_TEXT)).isEmpty() ? "내용 없음(미리보기 숨김?)" : "이름이 패턴과 다름");
            if (p.markSeen("diag|" + pkg + "|" + shown + "|" + (sbn.getPostTime() / 60000))) {
                p.addLog(Relay.stamp(sbn.getPostTime()) + "  " + (shown.isEmpty() ? "(제목 없음)" : shown)
                        + "  → 걸러짐 [" + appLabel + "] " + why + oddChars(shown));
            }
        }
    }

    private static String senderOf(Bundle m) {
        if (Build.VERSION.SDK_INT >= 28) {
            Object person = m.get("sender_person");
            if (person instanceof Person) {
                CharSequence name = ((Person) person).getName();
                if (name != null && name.length() > 0) return name.toString().trim();
            }
        }
        return str(m.getCharSequence("sender"));
    }

    /**
     * 이름 정리: 전각 문자(＃, ０-９)를 보통 문자로 바꾸고(NFKC), 공백과 '보이지 않는 글자'를 모두 지움.
     * 일부 문자 앱은 '#'·숫자로 시작하는 이름 앞뒤에 글자 방향 표시용 투명 문자(U+2068 등)를 붙여서,
     * 눈에는 같아 보여도 패턴과 안 맞는 경우가 있음.
     */
    static String clean(String name) {
        if (name == null) return "";
        String t = Normalizer.normalize(name, Normalizer.Form.NFKC);
        return t.replaceAll("[\\s\\p{Z}\\p{Cf}]", "");
    }

    /** 정리한 이름이 패턴과 맞는지 (정규식 find: '^'로 시작 위치 고정) */
    static boolean matches(String name, Pattern pattern) {
        String c = clean(name);
        return !c.isEmpty() && pattern.matcher(c).find();
    }

    /** 진단용: 이름에 보이지 않는 글자·전각 문자가 섞여 있으면 그 코드값을 보여 줌 */
    private static String oddChars(String name) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < name.length() && sb.length() < 40; i++) {
            char ch = name.charAt(i);
            int type = Character.getType(ch);
            if (type == Character.FORMAT || ch == '\uFF03' || (ch >= '\uFF10' && ch <= '\uFF19') || Character.isSpaceChar(ch)) {
                sb.append(String.format(" U+%04X", (int) ch));
            }
        }
        return sb.length() == 0 ? "" : " (특수문자:" + sb + ")";
    }

    private static String labelOf(String pkg) {
        switch (pkg) {
            case Prefs.PKG_KAKAO: return "카카오톡";
            case Prefs.PKG_SAMSUNG_MSG: return "문자(삼성)";
            case Prefs.PKG_GOOGLE_MSG: return "문자(구글)";
            default: return pkg;
        }
    }

    private static String hash(String pkg, String sender, String text, long t) {
        return Integer.toHexString((pkg + "|" + sender + "|" + text + "|" + t).hashCode())
                + Integer.toHexString((text + "#" + t).hashCode());
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }
}
