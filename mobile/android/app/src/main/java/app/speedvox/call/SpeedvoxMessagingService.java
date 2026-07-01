package app.speedvox.call;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

// Recebe o push de chamada (FCM) e faz a chamada tocar mesmo com o app fechado.
// Primeiro tenta o caminho de PARIDADE (Telecom self-managed — toca pelo sistema
// como uma ligação de verdade); se o Telecom recusar/indisponível, cai para a
// notificação de tela cheia. A entrega usa data-message de alta prioridade.
public class SpeedvoxMessagingService extends FirebaseMessagingService {
    public static final String PREFS = "speedvox_fcm";
    public static final String KEY_TOKEN = "fcm_token";

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

        // Caminho preferido: telecom do sistema (tela de bloqueio, DnD, Bluetooth,
        // UI nativa de ligação). Ao aceitar, o próprio sistema chama a UI via
        // onShowIncomingCallUi(). Se recusar, mostramos a notificação direto.
        boolean viaTelecom = CallTelecom.placeIncoming(getApplicationContext(), caller, callId, media);
        if (!viaTelecom) {
            CallTelecom.showIncomingUi(getApplicationContext(), caller, callId, media);
        }
    }
}
