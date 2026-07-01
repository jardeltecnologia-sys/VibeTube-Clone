package app.speedvox.mobile;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import android.os.PowerManager;

import com.getcapacitor.BridgeActivity;

import app.speedvox.nearby.SpeedvoxNearbyPlugin;
import app.speedvox.call.SpeedvoxCallPlugin;
import app.speedvox.call.CallTelecom;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the zero-infrastructure mesh transport before the bridge starts.
        registerPlugin(SpeedvoxNearbyPlugin.class);
        // Native FCM token bridge (full-screen incoming calls).
        registerPlugin(SpeedvoxCallPlugin.class);
        super.onCreate(savedInstanceState);

        // Paridade com WhatsApp: registra a conta telecom self-managed para as
        // chamadas tocarem PELO sistema (UI nativa de ligação, tela de bloqueio).
        try { CallTelecom.ensureRegistered(this); } catch (Exception ignored) {}

        // Isenção de otimização de bateria: sem isso, o Android/fabricante congela
        // o app no Doze e a chamada não chega de forma confiável. Pergunta 1x.
        requestBatteryExemptionOnce();

        // Android 13+: permissão de notificações.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 9201);
            }
        }

        // Microfone e câmera: ESSENCIAIS para as chamadas de voz/vídeo. Sem a
        // permissão concedida, o WebView nega o getUserMedia e o áudio nunca é
        // capturado (o outro lado fica sem ouvir). Pedimos logo na abertura.
        java.util.List<String> media = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            media.add(Manifest.permission.RECORD_AUDIO);
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            media.add(Manifest.permission.CAMERA);
        }
        if (!media.isEmpty()) {
            requestPermissions(media.toArray(new String[0]), 9202);
        }

        // Android 14+ (API 34): a chamada em tela cheia exige permissão especial
        // ("Notificações em tela cheia"). Se ainda não foi concedida, leva o
        // usuário direto pra tela de liberar — senão a chamada vem só como
        // notificação (não abre em tela cheia, como no WhatsApp).
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && !nm.canUseFullScreenIntent()) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                    i.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception ignored) {}
            }
        }
    }

    // Pede isenção de otimização de bateria uma única vez por instalação (para
    // não incomodar). Sem isso o processo pode ser congelado e perder chamadas.
    private void requestBatteryExemptionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            android.content.SharedPreferences sp = getSharedPreferences("speedvox_setup", MODE_PRIVATE);
            if (sp.getBoolean("battery_asked", false)) return;
            sp.edit().putBoolean("battery_asked", true).apply();
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) {}
    }
}
