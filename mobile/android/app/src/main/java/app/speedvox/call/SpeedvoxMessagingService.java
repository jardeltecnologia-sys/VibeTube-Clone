package app.speedvox.call;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

// Recebe o push de chamada (FCM) e faz a chamada tocar E abrir em TELA CHEIA
// mesmo com o app fechado. A entrega usa data-message de alta prioridade.
//
// IMPORTANTE: sempre usamos a notificação com full-screen intent (caminho
// confiável que abre o app por cima de tudo). A tentativa via Telecom
// self-managed foi REMOVIDA daqui porque, em vários aparelhos, ela "aceitava" a
// chamada mas não exibia UI — a chamada sumia (virava "cancelada").
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

        // Sempre mostra a tela cheia (notificação com full-screen intent que abre
        // a IncomingCallActivity por cima da tela de bloqueio). Este é o caminho
        // que abre o app na tela do usuário de forma confiável.
        CallTelecom.showIncomingUi(getApplicationContext(), caller, callId, media);
    }
}
