package app.speedvox.mobile;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

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

        // Android 13+: pedir permissão de notificações (necessária para a chamada).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 9201);
            }
        }
    }
}
