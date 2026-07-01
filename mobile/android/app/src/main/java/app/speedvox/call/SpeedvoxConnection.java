package app.speedvox.call;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.telecom.Connection;
import android.telecom.DisconnectCause;

import androidx.annotation.RequiresApi;

import app.speedvox.mobile.MainActivity;

// Connection self-managed do telecom representando UMA chamada recebida do
// SpeedVox. É assim que o WhatsApp faz: a chamada toca PELO sistema (tela de
// bloqueio, "Não perturbe"/prioridade, Bluetooth/carro) como uma ligação real.
@RequiresApi(Build.VERSION_CODES.O)
public class SpeedvoxConnection extends Connection {
    private final Context appContext;
    private final String callId;
    private final String caller;
    private final String media;

    SpeedvoxConnection(Context ctx, String callId, String caller, String media) {
        this.appContext = ctx.getApplicationContext();
        this.callId = callId;
        this.caller = caller;
        this.media = media;
    }

    // Self-managed: o app precisa mostrar a própria UI de chamada recebida.
    // Reutilizamos a tela cheia + a notificação CallStyle de alta prioridade.
    @Override
    public void onShowIncomingCallUi() {
        CallTelecom.showIncomingUi(appContext, caller, callId, media);
    }

    @Override
    public void onAnswer() { doAnswer(); }

    @Override
    public void onReject() { doReject(); }

    @Override
    public void onDisconnect() {
        setDisconnected(new DisconnectCause(DisconnectCause.LOCAL));
        cleanup();
    }

    @Override
    public void onAbort() {
        setDisconnected(new DisconnectCause(DisconnectCause.CANCELED));
        cleanup();
    }

    void doAnswer() {
        try { setActive(); } catch (Exception ignored) {}
        // Traz o app web para frente; o socket reconecta e o servidor re-entrega
        // a chamada ainda tocando, então o WebRTC conecta (ver realtime.js).
        Intent open = new Intent(appContext, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("speedvox_answer", true);
        open.putExtra("callId", callId);
        try { appContext.startActivity(open); } catch (Exception ignored) {}
        CallTelecom.dismissIncomingUi(appContext);
    }

    void doReject() {
        setDisconnected(new DisconnectCause(DisconnectCause.REJECTED));
        CallTelecom.dismissIncomingUi(appContext);
        cleanup();
    }

    private void cleanup() {
        SpeedvoxCallRegistry.remove(callId);
        try { destroy(); } catch (Exception ignored) {}
    }
}
