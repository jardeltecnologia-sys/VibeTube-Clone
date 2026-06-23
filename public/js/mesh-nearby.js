// SpeedVox native "Nearby" transport — zero-infrastructure mesh links.
//
// Bridges the Capacitor plugin `SpeedvoxNearby` (Android: Google Nearby
// Connections = Bluetooth + BLE + Wi-Fi Direct/hotspot, no internet needed) into
// the MeshManager. Discovered devices become protocol links, so the existing
// flooding / store-and-forward / SOS logic works with no server at all.
//
// On platforms without the plugin (any browser, desktop, iOS until its plugin
// lands) this is a no-op: isAvailable() returns false and the app simply keeps
// using the WebRTC transport. See NEARBY.md for the native side and build steps.

// Capacitor injects `window.Capacitor` into the WebView. We read it from the
// global (this app ships without a bundler, so bare imports won't resolve).
const Capacitor = (typeof window !== 'undefined' && window.Capacitor) || null;
const Nearby = (() => {
  try { return Capacitor && Capacitor.registerPlugin && Capacitor.registerPlugin('SpeedvoxNearby'); }
  catch { return null; }
})();

export function isAvailable() {
  try {
    return Boolean(Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()
      && Capacitor.isPluginAvailable && Capacitor.isPluginAvailable('SpeedvoxNearby') && Nearby);
  } catch {
    return false;
  }
}

// Wire the native transport into a MeshManager. Returns a controller with
// start()/stop(). Endpoints discovered nearby are added as links; their payloads
// are fed straight into the mesh protocol.
export function attachNearby(mesh, { displayName } = {}) {
  if (!isAvailable()) {
    return { available: false, start() {}, async stop() {} };
  }

  // Map the plugin's opaque endpointId <-> the SpeedVox userId it advertises.
  const endpointToUser = new Map();

  const onConnected = (ev) => {
    // ev: { endpointId, userId }
    if (!ev || !ev.userId) return;
    endpointToUser.set(ev.endpointId, ev.userId);
    mesh.addLink(ev.userId, (raw) => {
      // Send a UTF-8 frame to this specific endpoint.
      Nearby.send({ endpointId: ev.endpointId, data: raw }).catch(() => {});
    }, 'nearby');
  };

  const onLost = (ev) => {
    const userId = endpointToUser.get(ev.endpointId);
    if (userId) { endpointToUser.delete(ev.endpointId); mesh.removeLink(userId); }
  };

  const onPayload = (ev) => {
    // ev: { endpointId, data }  (data is the raw protocol frame string)
    const userId = endpointToUser.get(ev.endpointId);
    if (userId && typeof ev.data === 'string') mesh.receiveFrame(userId, ev.data);
  };

  let handles = [];
  const controller = {
    available: true,
    running: false,
    lastError: null,
    endpoints: endpointToUser,
    async start() {
      if (controller.running) return;
      controller.lastError = null;
      const onError = (ev) => { controller.lastError = (ev && ev.message) || 'erro'; };
      handles = [
        await Nearby.addListener('peerConnected', onConnected),
        await Nearby.addListener('peerLost', onLost),
        await Nearby.addListener('payload', onPayload),
        await Nearby.addListener('meshError', onError),
      ];
      // Advertise AND discover at once (P2P_CLUSTER) so every device both finds
      // and is found — the basis of an ad-hoc mesh.
      await Nearby.start({ userId: mesh.selfId, displayName: displayName || mesh.selfId });
      controller.running = true;
    },
    async stop() {
      try { await Nearby.stop(); } catch {}
      for (const h of handles) { try { await h.remove(); } catch {} }
      handles = [];
      for (const userId of endpointToUser.values()) mesh.removeLink(userId);
      endpointToUser.clear();
      controller.running = false;
    },
  };
  return controller;
}
