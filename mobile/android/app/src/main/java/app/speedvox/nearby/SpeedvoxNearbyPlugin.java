package app.speedvox.nearby;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Zero-infrastructure mesh transport for SpeedVox.
 *
 * Uses Google Nearby Connections (Strategy.P2P_CLUSTER), which combines
 * Bluetooth, BLE and Wi-Fi (Direct/hotspot) under one API and needs NO internet
 * and NO access point. Every device advertises AND discovers at once, forming an
 * ad-hoc cluster. Each connected endpoint is reported to the WebView, where the
 * JS mesh protocol (mesh.js) handles multi-hop flooding, store-and-forward and
 * SOS on top of these direct links.
 *
 * The advertised endpoint name carries the SpeedVox userId so the JS layer can
 * map an opaque endpointId to a real user:  "<userId><displayName>".
 */
@CapacitorPlugin(name = "SpeedvoxNearby")
public class SpeedvoxNearbyPlugin extends Plugin {

    private static final String SERVICE_ID = "app.speedvox.mesh";
    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private static final char SEP = '\u0001';

    private ConnectionsClient connectionsClient;
    private String localName = "";
    // endpointId -> userId advertised by that endpoint.
    private final ConcurrentHashMap<String, String> endpointUser = new ConcurrentHashMap<>();

    private ConnectionsClient client() {
        if (connectionsClient == null) {
            connectionsClient = Nearby.getConnectionsClient(getContext());
        }
        return connectionsClient;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String userId = call.getString("userId", "");
        String displayName = call.getString("displayName", "");
        localName = userId + SEP + displayName;

        AdvertisingOptions adv = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        DiscoveryOptions dis = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();

        client().startAdvertising(localName, SERVICE_ID, connectionLifecycle, adv)
                .addOnFailureListener(e -> notifyError("advertise", e));
        client().startDiscovery(SERVICE_ID, endpointDiscovery, dis)
                .addOnFailureListener(e -> notifyError("discover", e));

        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            client().stopAdvertising();
            client().stopDiscovery();
            client().stopAllEndpoints();
        } catch (Exception ignored) {}
        endpointUser.clear();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String data = call.getString("data", "");
        if (endpointId == null) { call.reject("endpointId required"); return; }
        Payload payload = Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8));
        client().sendPayload(endpointId, payload);
        call.resolve();
    }

    // --- Discovery: when we find a peer, request a connection to it. ---
    private final EndpointDiscoveryCallback endpointDiscovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            // Remember the userId now; we confirm on a successful connection.
            endpointUser.put(endpointId, parseUserId(info.getEndpointName()));
            client().requestConnection(localName, endpointId, connectionLifecycle)
                    .addOnFailureListener(e -> notifyError("request", e));
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            emitLost(endpointId);
        }
    };

    // --- Connection lifecycle: auto-accept; report up/down to the WebView. ---
    private final ConnectionLifecycleCallback connectionLifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            // Trust model: open mesh. Accept all; payloads are E2EE at the app layer.
            endpointUser.putIfAbsent(endpointId, parseUserId(info.getEndpointName()));
            client().acceptConnection(endpointId, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, ConnectionResolution result) {
            if (result.getStatus().isSuccess()) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                ev.put("userId", endpointUser.getOrDefault(endpointId, endpointId));
                notifyListeners("peerConnected", ev);
            } else {
                emitLost(endpointId);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            emitLost(endpointId);
        }
    };

    // --- Payloads: hand the raw frame string to the JS mesh protocol. ---
    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) return;
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            ev.put("data", new String(payload.asBytes(), StandardCharsets.UTF_8));
            notifyListeners("payload", ev);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            // Single-shot byte payloads: nothing to track.
        }
    };

    private void emitLost(String endpointId) {
        endpointUser.remove(endpointId);
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        notifyListeners("peerLost", ev);
    }

    private void notifyError(String phase, Exception e) {
        JSObject ev = new JSObject();
        ev.put("phase", phase);
        ev.put("message", e == null ? "unknown" : String.valueOf(e.getMessage()));
        notifyListeners("meshError", ev);
    }

    private static String parseUserId(String endpointName) {
        if (endpointName == null) return "";
        int i = endpointName.indexOf(SEP);
        return i >= 0 ? endpointName.substring(0, i) : endpointName;
    }
}
