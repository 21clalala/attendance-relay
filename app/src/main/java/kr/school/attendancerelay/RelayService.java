package kr.school.attendancerelay;

import android.app.Notification;
import android.app.Person;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * 안드로이드가 모든 알림을 이 서비스에 전달한다.
 * 여기서 (1) 지정한 앱이 아니면 버리고, (2) 발신자 이름이 접두어로 시작하지 않으면 버린다.
 * 버린 알림은 어디에도 저장하거나 보내지 않는다.
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

        String pkg = sbn.getPackageName();
        if (!p.apps().contains(pkg)) return;                     // (1) 앱 필터

        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle ex = n.extras;
        if (ex == null) return;

        java.util.regex.Pattern prefix = Prefs.compile(p.prefix());
        if (prefix == null) return;
        String appLabel = labelOf(pkg);
        long now = System.currentTimeMillis();

        // 메시지형 알림: 한 알림에 여러 메시지·여러 발신자가 들어 있을 수 있음 (단체방 포함)
        Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs != null && msgs.length > 0) {
            for (Parcelable item : msgs) {
                if (!(item instanceof Bundle)) continue;
                Bundle m = (Bundle) item;
                String sender = senderOf(m);
                String text = str(m.getCharSequence("text"));
                long ts = m.getLong("time", sbn.getPostTime());
                if (sender.isEmpty() || text.isEmpty()) continue;       // 내가 보낸 메시지 등
                if (!startsWithPrefix(sender, prefix)) continue;         // (2) 발신자 필터
                if (now - ts > MAX_MSG_AGE_MS) continue;
                if (p.markSeen(hash(pkg, sender, text, ts))) {
                    Relay.enqueue(this, appLabel, sender, text, ts);
                }
            }
            return; // 메시지형 알림은 위에서 메시지 단위로 모두 처리함
        }

        // 일반 알림: 제목 = 발신자, 본문 = 메시지
        String sender = str(ex.getCharSequence(Notification.EXTRA_TITLE));
        CharSequence big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
        String text = str(big != null ? big : ex.getCharSequence(Notification.EXTRA_TEXT));
        if (sender.isEmpty() || text.isEmpty()) return;
        if (!startsWithPrefix(sender, prefix)) return;                   // (2) 발신자 필터
        long ts = sbn.getPostTime();
        // 일반 알림은 10분 단위로 중복 판단 (같은 알림이 갱신되어 다시 오는 경우 대비)
        if (p.markSeen(hash(pkg, sender, text, ts / (10 * 60 * 1000L)))) {
            Relay.enqueue(this, appLabel, sender, text, ts);
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

    /** 공백을 지운 발신자 이름이 패턴과 맞는지 (정규식 find: '^'로 시작 위치 고정) */
    static boolean startsWithPrefix(String sender, java.util.regex.Pattern pattern) {
        String s = sender.replaceAll("\\s+", "");
        return pattern.matcher(s).find();
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
