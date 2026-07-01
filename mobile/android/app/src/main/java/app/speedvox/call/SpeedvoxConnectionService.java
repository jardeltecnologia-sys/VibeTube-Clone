package app.speedvox.call;

import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import androidx.annotation.RequiresApi;

// ConnectionService que o sistema (Telecom) chama para criar a chamada recebida.
// Registrado como self-managed no Manifest — é o que faz a ligação tocar com a
// UI nativa do telefone, na tela de bloqueio, respeitando DnD/prioridade.
@RequiresApi(Build.VERSION_CODES.O)
public class SpeedvoxConnectionService extends ConnectionService {

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle handle, ConnectionRequest request) {
        Bundle extras = callExtras(request);
        String callId = extras != null ? extras.getString("callId") : null;
        String caller = extras != null ? extras.getString("caller") : null;
        String media = extras != null ? extras.getString("media") : null;
        if (caller == null || caller.isEmpty()) caller = "Chamada recebida";

        SpeedvoxConnection conn = new SpeedvoxConnection(this, callId, caller, media);
        conn.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED);
        conn.setAddress(
            Uri.fromParts("sip", callId != null && !callId.isEmpty() ? callId : "speedvox", null),
            TelecomManager.PRESENTATION_ALLOWED);
        conn.setCallerDisplayName(caller, TelecomManager.PRESENTATION_ALLOWED);
        conn.setAudioModeIsVoip(true);
        conn.setRinging();
        SpeedvoxCallRegistry.put(callId, conn);
        return conn;
    }

    @Override
    public void onCreateIncomingConnectionFailed(PhoneAccountHandle handle, ConnectionRequest request) {
        // Telecom recusou (ex.: outra ligação ativa). Cai para a notificação de
        // tela cheia comum, para o usuário ainda ver e atender a chamada.
        Bundle extras = callExtras(request);
        String callId = extras != null ? extras.getString("callId") : null;
        String caller = extras != null ? extras.getString("caller") : null;
        String media = extras != null ? extras.getString("media") : null;
        CallTelecom.showIncomingUi(getApplicationContext(), caller, callId, media);
    }

    private Bundle callExtras(ConnectionRequest request) {
        Bundle root = request != null ? request.getExtras() : null;
        return root != null ? root.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS) : null;
    }
}
