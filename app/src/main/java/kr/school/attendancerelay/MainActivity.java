package kr.school.attendancerelay;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashSet;
import java.util.Set;

/** 설정 화면. 레이아웃 파일 없이 코드로 구성 (외부 라이브러리 0개). */
public class MainActivity extends Activity {

    private EditText urlEdit, secretEdit, prefixEdit;
    private CheckBox cbSamsung, cbGoogle, cbKakao;
    private TextView statusView, logView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Prefs p = new Prefs(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        root.setPadding(pad, dp(28), pad, pad);

        TextView title = new TextView(this);
        title.setText("출결 알림 전달기");
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setPadding(0, dp(10), 0, dp(10));
        root.addView(statusView);

        root.addView(button("① 알림 접근 권한 설정 열기", v ->
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))));
        root.addView(button("② 배터리 최적화 제외 설정 열기", v ->
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))));

        root.addView(section("Apps Script 웹 앱 URL"));
        urlEdit = edit(p.url(), "https://script.google.com/macros/s/.../exec", InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(urlEdit);

        root.addView(section("비밀키 (Apps Script의 SECRET과 같게)"));
        secretEdit = edit(p.secret(), "", InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        root.addView(secretEdit);

        root.addView(section("발신자 이름 패턴"));
        prefixEdit = edit(p.prefix(), Prefs.DEFAULT_PATTERN, InputType.TYPE_CLASS_TEXT);
        root.addView(prefixEdit);
        root.addView(hint("연락처/카톡 이름이 이 패턴에 맞는 사람의 메시지만 전달합니다.\n"
                + "기본값 ^#?26302\\d{2} = 2630201권민준, #2630201권민준어머니 형식 (26년 3학년 2반).\n"
                + "내년에는 연도·학년·반 숫자만 바꾸면 됩니다."));

        root.addView(section("감시할 앱"));
        Set<String> apps = p.apps();
        cbSamsung = check("삼성 메시지", apps.contains(Prefs.PKG_SAMSUNG_MSG));
        cbGoogle = check("구글 메시지", apps.contains(Prefs.PKG_GOOGLE_MSG));
        cbKakao = check("카카오톡", apps.contains(Prefs.PKG_KAKAO));
        root.addView(cbSamsung);
        root.addView(cbGoogle);
        root.addView(cbKakao);

        root.addView(button("저장", v -> save()));
        root.addView(button("연결 테스트", v -> test()));

        root.addView(section("최근 전송 기록 (메시지 내용은 저장하지 않음)"));
        logView = new TextView(this);
        logView.setTextSize(13);
        logView.setTypeface(Typeface.MONOSPACE);
        root.addView(logView);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        Relay.flush(this);
    }

    private void refresh() {
        Prefs p = new Prefs(this);
        boolean access = listenerEnabled();
        String s;
        if (!access) s = "⚠ 알림 접근 권한이 꺼져 있습니다. ①을 눌러 켜 주세요.";
        else if (!p.isConfigured()) s = "⚠ 아래 설정을 입력하고 저장하세요.";
        else s = "✓ 작동 중: 패턴 " + p.prefix() + " 에 맞는 발신자만 전달";
        statusView.setText(s);
        statusView.setTextColor(access && p.isConfigured() ? Color.rgb(20, 120, 60) : Color.rgb(190, 60, 30));
        logView.setText(p.logText());
    }

    private void save() {
        String url = urlEdit.getText().toString().trim();
        if (!url.startsWith("https://script.google.com/")) {
            toast("URL은 https://script.google.com/ 으로 시작해야 합니다.");
            return;
        }
        if (Prefs.compile(prefixEdit.getText().toString()) == null) {
            toast("발신자 이름 패턴이 올바르지 않습니다.");
            return;
        }
        Set<String> apps = new HashSet<>();
        if (cbSamsung.isChecked()) apps.add(Prefs.PKG_SAMSUNG_MSG);
        if (cbGoogle.isChecked()) apps.add(Prefs.PKG_GOOGLE_MSG);
        if (cbKakao.isChecked()) apps.add(Prefs.PKG_KAKAO);
        new Prefs(this).save(url, secretEdit.getText().toString(), prefixEdit.getText().toString(), apps);
        toast("저장했습니다.");
        refresh();
    }

    private void test() {
        toast("테스트 중…");
        new Thread(() -> {
            Relay.Result r = Relay.testConnection(this);
            runOnUiThread(() -> toast(r.ok ? "연결 성공! Apps Script와 통신됩니다." : "실패: " + r.message));
        }).start();
    }

    private boolean listenerEnabled() {
        String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        if (flat == null) return false;
        String me = new ComponentName(this, RelayService.class).flattenToString();
        for (String s : flat.split(":")) {
            if (s.equals(me)) return true;
        }
        return false;
    }

    /* ---- 작은 UI 도우미 ---- */

    private Button button(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    private TextView section(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(18), 0, dp(4));
        return t;
    }

    private TextView hint(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(12);
        t.setTextColor(Color.GRAY);
        return t;
    }

    private EditText edit(String value, String hint, int variation) {
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | variation);
        e.setHint(hint);
        e.setText(value);
        return e;
    }

    private CheckBox check(String text, boolean on) {
        CheckBox c = new CheckBox(this);
        c.setText(text);
        c.setChecked(on);
        return c;
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
