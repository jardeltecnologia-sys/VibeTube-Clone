package app.speedvox.call;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import androidx.core.app.NotificationCompat;

// Coração do caminho "estilo WhatsApp": registra uma conta telecom self-managed,
// entrega a chamada recebida ao sistema (Telecom) e renderiza a UI de chamada
// (tela cheia + notificação CallStyle com Atender/Recusar nativos).
public final class CallTelecom {
    private CallTelecom() {}

    // v2: canais são IMUTÁVEIS no Android — para mudar som/vibração é preciso um
    // ID novo. Mantido em sincronia com o canal antigo do serviço de mensagens.
    private static final String CHANNEL_ID = "speedvox_calls_v2";
    private static final int NOTIF_ID = 2001;
    static final String ACCOUNT_ID = "speedvox_self_managed";

    static PhoneAccountHandle handle(Context ctx) {
        return new PhoneAccountHandle(
            new ComponentName(ctx.getApplicationContext(), SpeedvoxConnectionService.class),
            ACCOUNT_ID);
    }

    // Registra a conta self-managed para o Telecom rotear nossas chamadas.
    // Idempotente (pode chamar sempre). API 26+.
    public static void ensureRegistered(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return;
            PhoneAccount account = PhoneAccount.builder(handle(ctx), "SpeedVox")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription("Chamadas SpeedVox")
                .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
                .build();
            tm.registerPhoneAccount(account);
        } catch (Exception ignored) {}
    }

    public static boolean isRegistered(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return false;
            PhoneAccount acc = tm.getPhoneAccount(handle(ctx));
            return acc != null;
        } catch (Exception e) { return false; }
    }

    // Toca a chamada PELO sistema (telecom). Retorna true se o Telecom aceitou;
    // false quando deve cair para o caminho de notificação direto.
    public static boolean placeIncoming(Context ctx, String caller, String callId, String media) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            ensureRegistered(ctx);
            TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return false;

            Bundle callExtras = new Bundle();
            callExtras.putString("callId", callId == null ? "" : callId);
            callExtras.putString("caller", caller == null ? "" : caller);
            callExtras.putString("media", media == null ? "" : media);

            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS,
                Uri.fromParts("sip", callId == null || callId.isEmpty() ? "speedvox" : callId, null));
            extras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callExtras);

            tm.addNewIncomingCall(handle(ctx), extras);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // Abre a tela cheia DIRETO (não depende do full-screen intent, que só dispara
    // sozinho com a tela bloqueada / permissão especial). Em Android 10+ iniciar
    // uma Activity a partir do background exige "Aparecer sobre outros apps"
    // (SYSTEM_ALERT_WINDOW). Com essa permissão, a tela abre também com a tela
    // ligada — que é o caso que estava só tocando sem abrir.
    public static boolean launchIncomingActivity(Context ctx, String caller, String callId, String media) {
        try {
            Context app = ctx.getApplicationContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    && !android.provider.Settings.canDrawOverlays(app)) {
                return false; // sem overlay o Android bloqueia abrir do background
            }
            Intent i = new Intent(app, IncomingCallActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            i.putExtra("caller", caller);
            i.putExtra("callId", callId);
            i.putExtra("media", media);
            app.startActivity(i);
            return true;
        } catch (Exception ignored) { return false; }
    }

    public static boolean canLaunchOverlay(Context ctx) {
        try {
            return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || android.provider.Settings.canDrawOverlays(ctx.getApplicationContext());
        } catch (Exception e) { return false; }
    }

    // Mostra a UI de chamada recebida: notificação de alta prioridade com
    // full-screen intent para a IncomingCallActivity. Em Android 12+ usa
    // Notification.CallStyle (visual/ranking de ligação de verdade).
    public static void showIncomingUi(Context ctx, String caller, String callId, String media) {
        Context app = ctx.getApplicationContext();
        if (caller == null || caller.isEmpty()) caller = "Chamada recebida";
        ensureChannel(app);

        Intent fs = new Intent(app, IncomingCallActivity.class);
        fs.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        fs.putExtra("caller", caller);
        fs.putExtra("callId", callId);
        fs.putExtra("media", media);
        PendingIntent fsPi = PendingIntent.getActivity(app, 1001, fs, piFlags());

        PendingIntent answerPi = actionPi(app, CallActionReceiver.ACTION_ANSWER, callId, 1002);
        PendingIntent declinePi = actionPi(app, CallActionReceiver.ACTION_DECLINE, callId, 1003);
        String sub = "video".equals(media) ? "Chamada de vídeo · SpeedVox" : "Chamada de voz · SpeedVox";

        Notification n;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Person person = new Person.Builder().setName(caller).setImportant(true).build();
            n = new Notification.Builder(app, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setStyle(Notification.CallStyle.forIncomingCall(person, declinePi, answerPi))
                .setContentText(sub)
                .setFullScreenIntent(fsPi, true)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .build();
        } else {
            n = new NotificationCompat.Builder(app, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(caller)
                .setContentText(sub)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(true)
                .setFullScreenIntent(fsPi, true)
                .addAction(android.R.drawable.sym_action_call, "Atender", answerPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Recusar", declinePi)
                .build();
        }

        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, n);
    }

    public static void dismissIncomingUi(Context ctx) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getApplicationContext()
                .getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
        } catch (Exception ignored) {}
    }

    private static PendingIntent actionPi(Context app, String action, String callId, int req) {
        Intent i = new Intent(app, CallActionReceiver.class).setAction(action).putExtra("callId", callId);
        return PendingIntent.getBroadcast(app, req, i, piFlags());
    }

    private static int piFlags() {
        int f = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) f |= PendingIntent.FLAG_IMMUTABLE;
        return f;
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "Chamadas", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Chamadas recebidas no SpeedVox");
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{ 0, 1000, 600, 1000, 600, 1000 });
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        ch.setSound(ring, attrs);
        ch.setBypassDnd(true);
        nm.createNotificationChannel(ch);
    }
}
