package app.speedvox.call;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

// Recebe o push de chamada (FCM) e dispara a tela cheia, mesmo com o app
// fechado. A entrega usa data-message de alta prioridade vinda do servidor.
public class SpeedvoxMessagingService extends FirebaseMessagingService {
    public static final String PREFS = "speedvox_fcm";
    public static final String KEY_TOKEN = "fcm_token";
    private static final String CHANNEL_ID = "speedvox_calls";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        // Guarda o token localmente; o app (camada web) registra no servidor.
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        sp.edit().putString(KEY_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"call".equals(data.get("type"))) {
            return; // só tratamos chamadas aqui; o resto fica com a camada web
        }
        String caller = data.get("caller");
        if (caller == null || caller.isEmpty()) caller = "Chamada recebida";
        String callId = data.get("callId");
        String media = data.get("media");

        ensureChannel();

        Intent fullScreen = new Intent(this, IncomingCallActivity.class);
        fullScreen.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        fullScreen.putExtra("caller", caller);
        fullScreen.putExtra("callId", callId);
        fullScreen.putExtra("media", media);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 1001, fullScreen, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(caller)
            .setContentText("Chamada recebida pelo SpeedVox")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(true)
            .setFullScreenIntent(pi, true); // <- abre a tela cheia mesmo bloqueado

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(2001, b.build());
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Chamadas", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Chamadas recebidas no SpeedVox");
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }
    }
}
