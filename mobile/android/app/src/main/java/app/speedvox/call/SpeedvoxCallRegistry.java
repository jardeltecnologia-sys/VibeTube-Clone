package app.speedvox.call;

import java.util.concurrent.ConcurrentHashMap;

// Guarda a Connection (telecom) viva de cada chamada que está tocando, para que
// a tela cheia (IncomingCallActivity) e os botões da notificação possam atender
// ou recusar PELO sistema. Quando não há Connection registrada (caminho de
// fallback, sem telecom), quem chama recebe `false` e abre o app diretamente.
public final class SpeedvoxCallRegistry {
    private SpeedvoxCallRegistry() {}

    private static final ConcurrentHashMap<String, SpeedvoxConnection> BY_ID = new ConcurrentHashMap<>();

    static void put(String callId, SpeedvoxConnection c) {
        if (callId != null && c != null) BY_ID.put(callId, c);
    }

    static void remove(String callId) {
        if (callId != null) BY_ID.remove(callId);
    }

    static SpeedvoxConnection get(String callId) {
        return callId == null ? null : BY_ID.get(callId);
    }

    // Retorna true se uma Connection do telecom tratou o "atender".
    public static boolean answer(String callId) {
        SpeedvoxConnection c = get(callId);
        if (c != null) { c.doAnswer(); return true; }
        return false;
    }

    // Retorna true se uma Connection do telecom tratou o "recusar".
    public static boolean decline(String callId) {
        SpeedvoxConnection c = get(callId);
        if (c != null) { c.doReject(); return true; }
        return false;
    }
}
