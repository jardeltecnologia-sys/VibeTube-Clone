// geomesh-router.js - Directional Offline Routing for SpeedVox Mesh
export class GeoMeshRouter {
  constructor(mesh) {
    this.mesh = mesh;
    this.localCoords = { latitude: 0, longitude: 0, altitude: 0 };
    this.compassHeading = 0;
    
    // Maps userId -> { coords: { latitude, longitude, altitude }, ts: number }
    this.userCoordsTable = new Map();
    
    this.initHardwareSensors();
    this.startPresenceBroadcast();
  }

  // 1. Initialize hardware sensors (Runs 100% Offline)
  initHardwareSensors() {
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (position) => {
          this.localCoords.latitude = position.coords.latitude;
          this.localCoords.longitude = position.coords.longitude;
          this.localCoords.altitude = position.coords.altitude || 0;
        },
        (err) => console.warn('[GeoMesh] GPS in inertial/dead reckoning mode'),
        { enableHighAccuracy: true, maximumAge: 0 }
      );
    }

    if (typeof window !== 'undefined' && window.DeviceOrientationEvent) {
      const handleOrientation = (event) => {
        this.compassHeading = event.webkitCompassHeading || (360 - event.alpha) || 0;
      };
      window.addEventListener('deviceorientation', handleOrientation);
    }
  }

  // 2. Periodically broadcast local coordinates to neighbors (to: '*')
  startPresenceBroadcast() {
    setInterval(() => {
      if (!this.mesh || !this.mesh.selfId) return;
      if (this.localCoords.latitude === 0 && this.localCoords.longitude === 0) return;
      
      // Broadcast presence with our coordinates
      this.mesh.sendMessage('*', {
        type: 'presence',
        coords: this.localCoords
      }, 'presence');
    }, 8000);
  }

  // 3. Register coords received from other peers
  registerPeerCoords(userId, coords) {
    if (!userId || !coords) return;
    this.userCoordsTable.set(userId, {
      coords,
      ts: Date.now()
    });
  }

  // 4. Haversine formula for metric distance calculation (meters)
  calculateDistance(coords1, coords2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = coords1.latitude * Math.PI / 180;
    const phi2 = coords2.latitude * Math.PI / 180;
    const deltaPhi = (coords2.latitude - coords1.latitude) * Math.PI / 180;
    const deltaLambda = (coords2.longitude - coords1.longitude) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // 5. Calculate Azimuth/Bearing (degrees, 0-360)
  calculateBearing(fromCoords, toCoords) {
    const lat1 = fromCoords.latitude * Math.PI / 180;
    const lat2 = toCoords.latitude * Math.PI / 180;
    const lon1 = fromCoords.longitude * Math.PI / 180;
    const lon2 = toCoords.longitude * Math.PI / 180;

    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);

    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  // 6. Select the best next-hop peer that aligns with the target direction
  selectOptimalHop(targetUserId) {
    const targetEntry = this.userCoordsTable.get(targetUserId);
    if (!targetEntry) return null;

    const targetCoords = targetEntry.coords;
    if (this.localCoords.latitude === 0 && this.localCoords.longitude === 0) return null;

    const targetBearing = this.calculateBearing(this.localCoords, targetCoords);
    let bestPeerId = null;
    let minScore = Infinity;

    const activeLinks = Array.from(this.mesh.links.keys());
    if (activeLinks.length === 0) return 'SATELLITE_BURST_MODE';

    for (const peerId of activeLinks) {
      const peerEntry = this.userCoordsTable.get(peerId);
      if (!peerEntry) continue;

      const peerCoords = peerEntry.coords;
      const distanceToTarget = this.calculateDistance(peerCoords, targetCoords);
      const peerBearing = this.calculateBearing(this.localCoords, peerCoords);
      
      const angularDeviation = Math.abs(targetBearing - peerBearing);

      // Score: 70% distance, 30% bearing alignment
      const score = (distanceToTarget * 0.7) + (angularDeviation * 0.3);

      if (score < minScore) {
        minScore = score;
        bestPeerId = peerId;
      }
    }

    return bestPeerId;
  }
}
