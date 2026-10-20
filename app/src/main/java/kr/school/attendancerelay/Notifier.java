package kr.school.attendancerelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 출결 메시지가 시트에 저장되면 '유형 입력' 알림을 띄운다.
 *  - 버튼: 결석 / 지각 / 조퇴 (한 번에 저장)
 *  - 알림 본문을 누르면 입력창(유형 + 사유)이 열림
 */
final class Notifier {
    static final String CHANNEL = "ask_type";
    static final String EXTRA_ID = "id";
    static final String EXTRA_WHO = "who";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_GUESS = "guess";
    static final String EXTRA_TYPE = "type";
    static final String EXTRA_NOTIF = "notif";

    private Notifier() {}

    static void ensureChannel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "출결 유형 입력", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("우리반 출결 연락이 오면 결석·지각·조퇴를 바로 고를 수 있게 알려 줍니다.");
            ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(ch);
        }
    }

    static int notifId(String id) {
        return 1000 + (id.hashCode() & 0x0fffffff);
    }

    static void showAsk(Context ctx, String id, int no, String name, String rel, String guess, String text,
                        String date, String recvDate) {
        ensureChannel(ctx);
        String who = no + "번 " + name + ("학생".equals(rel) ? "" : " (" + rel + ")");
        int nid = notifId(id);
        // 받은 날과 다른 날짜로 추정되면(예: '내일 결석') 제목에 적용 날짜 표시
        String when = "";
        if (date != null && date.length() == 10 && !date.equals(recvDate)) {
            when = " · " + Integer.parseInt(date.substring(5, 7)) + "/" + Integer.parseInt(date.substring(8, 10)) + " 예정";
        }

        Intent open = new Intent(ctx, ClassifyActivity.class)
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_WHO, who).putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_GUESS, guess).putExtra(EXTRA_NOTIF, nid)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent openPi = PendingIntent.getActivity(ctx, nid, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String guessLine = "확인필요".equals(guess) || guess.isEmpty() ? "유형을 골라 주세요" : "추정: " + guess;

        Notification.Builder b = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_agenda)
                .setContentTitle(who + " · " + guessLine + when)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text
                        + "\n\n누르면 사유까지 입력할 수 있습니다. 날짜·메모는 엣지 패널에서 고칠 수 있습니다."))
                .setContentIntent(openPi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PRIVATE);

        for (String t : new String[]{"결석", "지각", "조퇴"}) {
            Intent a = new Intent(ctx, ActionReceiver.class)
                    .putExtra(EXTRA_ID, id).putExtra(EXTRA_WHO, who).putExtra(EXTRA_TEXT, text)
                    .putExtra(EXTRA_TYPE, t).putExtra(EXTRA_NOTIF, nid);
            PendingIntent api = PendingIntent.getBroadcast(ctx, (nid + t).hashCode(), a,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(new Notification.Action.Builder(null, t, api).build());
        }
        notify(ctx, nid, b.build());
    }

    /** 저장 완료 표시 (같은 알림을 '저장됨'으로 바꿈) */
    static void showSaved(Context ctx, String id, String who, String summary) {
        ensureChannel(ctx);
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.checkbox_on_background)
                .setContentTitle(who + " · " + summary + " 저장됨")
                .setContentText("사이드 패널과 시트에 반영되었습니다.")
                .setAutoCancel(true)
                .setTimeoutAfter(15000)
                .setOnlyAlertOnce(true)
                .build();
        notify(ctx, notifId(id), n);
    }

    private static void notify(Context ctx, int nid, Notification n) {
        try {
            ctx.getSystemService(NotificationManager.class).notify(nid, n);
        } catch (SecurityException ignored) {
            // 알림 권한이 없으면 조용히 넘어감 (전달은 계속 동작)
        }
    }

    static boolean canPost(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ctx.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }
}
