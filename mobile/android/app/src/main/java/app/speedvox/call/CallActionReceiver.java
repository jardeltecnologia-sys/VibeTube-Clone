package app.speedvox.call;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import app.speedvox.mobile.MainActivity;

// Recebe os toques em "Atender"/"Recusar" da notificação de chamada (CallStyle)
// e encaminha para a Connection do telecom. Se não houver Connection (caminho de
// fallback), atende abrindo o app diretamente.
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_ANSWER = "app.speedvox.call.ANSWER";
    static final String ACTION_DECLINE = "app.speedvox.call.DECLINE";

    @Override
    public void onReceive(Context context, Intent intent) {
        Context app = context.getApplicationContext();
        String action = intent.getAction();
        String callId = intent.getStringExtra("callId");

        if (ACTION_ANSWER.equals(action)) {
            if (!SpeedvoxCallRegistry.answer(callId)) {
                Intent open = new Intent(app, MainActivity.class);
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                open.putExtra("speedvox_answer", true);
                open.putExtra("callId", callId);
                try { app.startActivity(open); } catch (Exception ignored) {}
            }
        } else if (ACTION_DECLINE.equals(action)) {
            SpeedvoxCallRegistry.decline(callId);
        }
        CallTelecom.dismissIncomingUi(app);
    }
}
