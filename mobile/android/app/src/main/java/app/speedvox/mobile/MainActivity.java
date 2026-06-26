package app.speedvox.mobile;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import com.getcapacitor.BridgeActivity;

import app.speedvox.nearby.SpeedvoxNearbyPlugin;
import app.speedvox.call.SpeedvoxCallPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the zero-infrastructure mesh transport before the bridge starts.
        registerPlugin(SpeedvoxNearbyPlugin.class);
        // Native FCM token bridge (full-screen incoming calls).
        registerPlugin(SpeedvoxCallPlugin.class);
        super.onCreate(savedInstanceState);

        // Android 13+: permissão de notificações.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 9201);
            }
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
}
