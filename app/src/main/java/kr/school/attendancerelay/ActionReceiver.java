package kr.school.attendancerelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 알림의 결석/지각/조퇴 버튼 처리 (사유는 비워 둠 — 나중에 입력창이나 패널에서 지정 가능) */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        String id = i.getStringExtra(Notifier.EXTRA_ID);
        String type = i.getStringExtra(Notifier.EXTRA_TYPE);
        if (id == null || type == null) return;
        // 전송이 끝날 때까지 시스템이 프로세스를 정리하지 않도록 유지
        final PendingResult pending = goAsync();
        Relay.enqueueType(ctx, id, type, "",
                i.getStringExtra(Notifier.EXTRA_WHO), i.getStringExtra(Notifier.EXTRA_TEXT),
                pending::finish);
    }
}
