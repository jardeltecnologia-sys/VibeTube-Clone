package app.speedvox.call;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
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
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import app.speedvox.mobile.MainActivity;

// Tela cheia de "chamada recebida", estilo Instagram. Aparece por cima da tela
// de bloqueio, toca e vibra. "Atender" abre o app (a camada web assume a
// chamada via WebRTC); "Recusar" encerra.
public class IncomingCallActivity extends Activity {
    private Ringtone ringtone;
    private Vibrator vibrator;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockscreen();

        String caller = getIntent().getStringExtra("caller");
        if (caller == null || caller.isEmpty()) caller = "Chamada recebida";
        final String media = getIntent().getStringExtra("media");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0b141a"));
        root.setPadding(48, 96, 48, 96);

        TextView name = new TextView(this);
        name.setText(caller);
        name.setTextColor(Color.WHITE);
        name.setTextSize(30);
        name.setGravity(Gravity.CENTER);

        TextView sub = new TextView(this);
        sub.setText("video".equals(media) ? "Chamada de vídeo · SpeedVox" : "Chamada de voz · SpeedVox");
        sub.setTextColor(Color.parseColor("#8696a0"));
        sub.setTextSize(16);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 20, 0, 96);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);

        Button decline = new Button(this);
        decline.setText("Recusar");
        decline.setBackgroundColor(Color.parseColor("#f15c6d"));
        decline.setTextColor(Color.WHITE);

        Button accept = new Button(this);
        accept.setText("Atender");
        accept.setBackgroundColor(Color.parseColor("#00a884"));
        accept.setTextColor(Color.WHITE);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(24, 0, 24, 0);
        buttons.addView(decline, lp);
        buttons.addView(accept, lp);

        root.addView(name);
        root.addView(sub);
        root.addView(buttons);
        setContentView(root);

        startRinging();

        decline.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { stopRinging(); finish(); }
        });
        accept.setOnClickListener(new View.OnClickListener() {
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
            if (ringtone != null) ringtone.play();
        } catch (Exception ignored) {}
        try {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null) {
                long[] pattern = {0, 600, 800};
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
