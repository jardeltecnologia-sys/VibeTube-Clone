package app.speedvox.call;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.messaging.FirebaseMessaging;

// Ponte para a camada web pegar o token FCM deste aparelho e registrá-lo no
// servidor (associado ao usuário logado).
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
}
