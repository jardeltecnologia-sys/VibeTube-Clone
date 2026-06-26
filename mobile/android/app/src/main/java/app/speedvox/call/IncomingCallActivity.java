package app.speedvox.call;

import android.animation.ObjectAnimator;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.LinearInterpolator;
import android.widget.LinearLayout;
import android.widget.TextView;

import app.speedvox.mobile.MainActivity;

// Tela cheia de "chamada recebida", estilo Instagram/WhatsApp. Aparece por cima
// da tela de bloqueio, toca alto e vibra. Mostra um avatar pulsante e DOIS
// botões redondos animados (Recusar em vermelho, Atender em verde) — os dois
// "pulsam" pra chamar a atenção, garantindo a opção de atender.
public class IncomingCallActivity extends Activity {
    private Ringtone ringtone;
    private Vibrator vibrator;

    private int dp(float v) { return Math.round(getResources().getDisplayMetrics().density * v); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockscreen();

        String caller = getIntent().getStringExtra("caller");
        if (caller == null || caller.isEmpty()) caller = "Chamada recebida";
        final String media = getIntent().getStringExtra("media");

        // --- Fundo com leve degradê escuro (estilo app de chamada) ---
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        GradientDrawable bg = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{ Color.parseColor("#0d2b24"), Color.parseColor("#06140f") });
        root.setBackground(bg);
        root.setPadding(dp(32), dp(72), dp(32), dp(56));

        // Espaço flexível no topo
        View topSpace = new View(this);
        root.addView(topSpace, new LinearLayout.LayoutParams(0, 0, 1f));

        // --- Avatar circular com a inicial, pulsando ---
        String initial = caller.trim().isEmpty() ? "?" : caller.trim().substring(0, 1).toUpperCase();
        TextView avatar = new TextView(this);
        avatar.setText(initial);
        avatar.setTextColor(Color.parseColor("#04130e"));
        avatar.setTextSize(56);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable avBg = new GradientDrawable();
        avBg.setShape(GradientDrawable.OVAL);
        avBg.setColor(Color.parseColor("#00a884"));
        avatar.setBackground(avBg);
        LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(dp(132), dp(132));
        avLp.bottomMargin = dp(28);
        root.addView(avatar, avLp);
        pulse(avatar, 1f, 1.06f, 1100);

        // --- Nome ---
        TextView name = new TextView(this);
        name.setText(caller);
        name.setTextColor(Color.WHITE);
        name.setTextSize(30);
        name.setGravity(Gravity.CENTER);
        root.addView(name);

        // --- Subtítulo ---
        TextView sub = new TextView(this);
        sub.setText("video".equals(media) ? "Chamada de vídeo · SpeedVox" : "Chamada de voz · SpeedVox");
        sub.setTextColor(Color.parseColor("#8696a0"));
        sub.setTextSize(16);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(8);
        root.addView(sub, subLp);

        // Espaço flexível embaixo
        View midSpace = new View(this);
        root.addView(midSpace, new LinearLayout.LayoutParams(0, 0, 1.4f));

        // --- Dois botões redondos com rótulo embaixo ---
        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);

        LinearLayout declineCol = roundButton("✕", "Recusar", "#f15c6d");
        LinearLayout acceptCol = roundButton("☎", "Atender", "#00d36e");

        LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(0,
            LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        buttons.addView(declineCol, colLp);
        buttons.addView(acceptCol, colLp);
        root.addView(buttons, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);

        // Os dois botões pulsam (efeito "vibrando" pra chamar atenção).
        pulse(declineCol.getChildAt(0), 1f, 1.10f, 850);
        pulse(acceptCol.getChildAt(0), 1f, 1.14f, 650);

        startRinging();

        declineCol.getChildAt(0).setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { stopRinging(); finish(); }
        });
        acceptCol.getChildAt(0).setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                stopRinging();
                Intent open = new Intent(IncomingCallActivity.this, MainActivity.class);
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                open.putExtra("speedvox_answer", true);
                open.putExtra("callId", getIntent().getStringExtra("callId"));
                startActivity(open);
                finish();
            }
        });
    }

    // Cria uma coluna: botão circular (com símbolo) + rótulo embaixo.
    private LinearLayout roundButton(String symbol, String label, String colorHex) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);

        TextView btn = new TextView(this);
        btn.setText(symbol);
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(30);
        btn.setGravity(Gravity.CENTER);
        btn.setClickable(true);
        btn.setFocusable(true);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(Color.parseColor(colorHex));
        btn.setBackground(d);
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(dp(72), dp(72));
        col.addView(btn, bLp);

        TextView lbl = new TextView(this);
        lbl.setText(label);
        lbl.setTextColor(Color.parseColor("#cfd9de"));
        lbl.setTextSize(14);
        lbl.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lLp.topMargin = dp(10);
        col.addView(lbl, lLp);
        return col;
    }

    private void pulse(View v, float from, float to, long durationMs) {
        ObjectAnimator sx = ObjectAnimator.ofFloat(v, "scaleX", from, to);
        ObjectAnimator sy = ObjectAnimator.ofFloat(v, "scaleY", from, to);
        for (ObjectAnimator a : new ObjectAnimator[]{ sx, sy }) {
            a.setDuration(durationMs);
            a.setRepeatCount(ObjectAnimator.INFINITE);
            a.setRepeatMode(ObjectAnimator.REVERSE);
            a.setInterpolator(new LinearInterpolator());
            a.start();
        }
    }

    private void showOverLockscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );
    }

    private void startRinging() {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone.setLooping(true);
                ringtone.play();
            }
        } catch (Exception ignored) {}
        try {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 1000, 600, 1000, 600};
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {}
    }

    private void stopRinging() {
        try { if (ringtone != null) ringtone.stop(); } catch (Exception ignored) {}
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) {}
    }

    @Override
    protected void onDestroy() {
        stopRinging();
        super.onDestroy();
    }
}
