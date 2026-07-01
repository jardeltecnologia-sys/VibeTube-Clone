package app.speedvox.call;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.messaging.FirebaseMessaging;

// Ponte para a camada web: pega o token FCM deste aparelho e expõe a "prontidão
// de chamada" (o que ainda falta liberar para tocar como o WhatsApp), além de
// atalhos para o usuário liberar bateria e notificação em tela cheia.
@CapacitorPlugin(name = "SpeedvoxCall")
public class SpeedvoxCallPlugin extends Plugin {

    @PluginMethod
    public void getToken(final PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    JSObject ret = new JSObject();
                    ret.put("token", task.getResult());
                    call.resolve(ret);
                } else {
                    resolveCached(call);
                }
            });
        } catch (Exception e) {
            resolveCached(call);
        }
    }

    private void resolveCached(PluginCall call) {
        SharedPreferences sp = getContext()
            .getSharedPreferences(SpeedvoxMessagingService.PREFS, Context.MODE_PRIVATE);
        String cached = sp.getString(SpeedvoxMessagingService.KEY_TOKEN, null);
        if (cached != null) {
            JSObject ret = new JSObject();
            ret.put("token", cached);
            call.resolve(ret);
        } else {
            call.reject("Sem token FCM disponível");
        }
    }

    // Estado de prontidão da chamada "estilo WhatsApp": o que já está liberado e
    // o que ainda falta neste aparelho. Alimenta o painel na tela de Ajustes.
    @PluginMethod
    public void getCallReadiness(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("native", true);

        boolean notifications = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifications = ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        }
        ret.put("notifications", notifications);

        boolean fullScreen = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            fullScreen = nm != null && nm.canUseFullScreenIntent();
        }
        ret.put("fullScreen", fullScreen);

        boolean battery = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            battery = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }
        ret.put("battery", battery);

        ret.put("telecom", CallTelecom.isRegistered(ctx));
        ret.put("overlay", CallTelecom.canLaunchOverlay(ctx));
        call.resolve(ret);
    }

    // Abre a tela do sistema para liberar "Aparecer sobre outros apps" (overlay).
    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                startFrom(i);
            }
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    // Abre a tela do sistema para o usuário isentar o app da otimização de bateria.
    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                startFrom(i);
            }
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    // Abre a tela do sistema para liberar "notificações em tela cheia" (Android 14+).
    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                startFrom(i);
            }
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    private void startFrom(Intent i) {
        Activity act = getActivity();
        if (act != null) {
            act.startActivity(i);
        } else {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
    }
}
