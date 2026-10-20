package kr.school.attendancerelay;

import android.app.Activity;
import android.app.NotificationManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** 알림을 누르면 열리는 입력창: 유형 + 사유를 골라 저장 */
public class ClassifyActivity extends Activity {

    private static final String[] TYPES = {"결석", "지각", "조퇴", "결과", "해당없음"};
    private static final String[] REASONS = {"질병", "미인정", "기타", "출석인정", "미정"};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final String id = getIntent().getStringExtra(Notifier.EXTRA_ID);
        final String who = nz(getIntent().getStringExtra(Notifier.EXTRA_WHO));
        final String text = nz(getIntent().getStringExtra(Notifier.EXTRA_TEXT));
        final String guess = nz(getIntent().getStringExtra(Notifier.EXTRA_GUESS));
        final int nid = getIntent().getIntExtra(Notifier.EXTRA_NOTIF, 0);
        if (id == null) { finish(); return; }
        setTitle("출결 유형 입력");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(who);
        title.setTextSize(19);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView msg = new TextView(this);
        msg.setText(text);
        msg.setTextSize(15);
        msg.setPadding(dp(12), dp(10), dp(12), dp(10));
        msg.setBackgroundColor(Color.argb(24, 128, 128, 128));
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.topMargin = dp(10);
        root.addView(msg, mlp);

        if (!guess.isEmpty() && !"확인필요".equals(guess)) {
            TextView g = new TextView(this);
            g.setText("자동 추정: " + guess);
            g.setTextColor(Color.GRAY);
            g.setPadding(0, dp(6), 0, 0);
            root.addView(g);
        }

        root.addView(section("유형"));
        final RadioGroup typeGroup = choices(TYPES, guess);
        root.addView(typeGroup);

        root.addView(section("사유 (나이스 출결 구분)"));
        final RadioGroup reasonGroup = choices(REASONS, "미정");
        root.addView(reasonGroup);

        Button save = new Button(this);
        save.setText("저장");
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(18);
        root.addView(save, slp);

        save.setOnClickListener(v -> {
            String type = checkedText(typeGroup);
            if (type == null) {
                Toast.makeText(this, "유형을 골라 주세요.", Toast.LENGTH_SHORT).show();
                return;
            }
            String reason = checkedText(reasonGroup);
            if (reason == null || "미정".equals(reason)) reason = "";
            Relay.enqueueType(this, id, type, reason, who, text);
            if (nid != 0) getSystemService(NotificationManager.class).cancel(nid);
            Toast.makeText(this, "저장 중… 완료되면 알림으로 알려 드립니다.", Toast.LENGTH_SHORT).show();
            finish();
        });

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    private RadioGroup choices(String[] items, String preselect) {
        RadioGroup g = new RadioGroup(this);
        g.setOrientation(RadioGroup.VERTICAL); // 폰 화면 폭에서 넘치지 않도록 세로 배치
        for (String s : items) {
            RadioButton b = new RadioButton(this);
            b.setText(s);
            b.setTextSize(16);
            b.setId(android.view.View.generateViewId());
            b.setMinHeight(dp(44));
            g.addView(b);
            if (s.equals(preselect)) b.setChecked(true);
        }
        return g;
    }

    private String checkedText(RadioGroup g) {
        int id = g.getCheckedRadioButtonId();
        if (id == -1) return null;
        RadioButton b = g.findViewById(id);
        return b == null ? null : b.getText().toString();
    }

    private TextView section(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(16), 0, dp(4));
        return t;
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
