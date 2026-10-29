// PlantGo Core Application Logic
// Safe extraction from Capacitor if available in native runtime
const CapacitorPlugins = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins : {};
const Camera = CapacitorPlugins.Camera || null;
// Enum values from @capacitor/camera (not exposed on window.Capacitor without a bundler)
const CameraResultType = { Uri: 'uri', Base64: 'base64', DataUrl: 'dataUrl' };
const CameraSource = { Prompt: 'PROMPT', Camera: 'CAMERA', Photos: 'PHOTOS' };
const Geolocation = CapacitorPlugins.Geolocation || null;
const Permissions = CapacitorPlugins.Permissions || null;

// --- STATE MANAGEMENT ---
// --- MARIADB BACKEND API CONFIGURATION ---
const CLOUD_API_BASE = "https://plantgo.gptindia.pro/api";
const LOCAL_EMULATOR_API_BASE = "http://10.0.2.2:5001/api";
const LOCAL_LAN_API_BASE = "http://localhost:5001/api";
const LOCAL_LOOPBACK_API_BASE = "http://127.0.0.1:5001/api";

// Local dev servers are only offered in debug builds and the browser, never in Play Store releases
const DEV_ENDPOINTS_ENABLED = !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || Boolean(window.Capacitor.DEBUG);

let API_BASE = CLOUD_API_BASE;

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...options, signal: controller ? controller.signal : undefined });
    return res;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// --- SESSION (issued by the backend after Google/Firebase sign-in) ---
function getSessionToken() {
  try { return localStorage.getItem("plantgo_session"); } catch (e) { return null; }
}

function setSessionToken(token) {
  try {
    if (token) localStorage.setItem("plantgo_session", token);
    else localStorage.removeItem("plantgo_session");
  } catch (e) { }
}

// Backend request with the signed-in user's session attached
async function apiFetch(path, options = {}, timeoutMs = 8000) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const token = getSessionToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetchWithTimeout(API_BASE + path, { ...options, headers }, timeoutMs);
  // Expired session: drop back to the guest state (only once, even with parallel requests)
  if (res.status === 401 && token && getSessionToken() === token) {
    clearSignedInUser();
  }
  return res;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Uploaded photos are served by the backend under /api/uploads
function resolveImageUrl(img) {
  if (!img) return "";
  if (img.startsWith("/api/")) return API_BASE.replace(/\/api$/, "") + img;
  return img;
}

function applyUserStats(u) {
  state.userStats = {
    discoveredCount: u?.discoveredCount ?? 0,
    reviewedCount: u?.reviewedCount ?? 0,
    totalPoints: u?.totalPoints ?? 0,
    level: u ? (u.level ?? 1) : 0,
    xp: u?.xp ?? 0,
    xpToNext: u ? (u.xpToNext ?? 1000) : 0,
    milestoneAchieved: Boolean(u?.milestoneAchieved)
  };
  updateProfileUI();
}

// Loads profile, feeds, radar and settings for the current session (or guest)
async function loadUserData() {
  const [profileRes, feedsRes, radarRes, settingsRes] = await Promise.all([
    apiFetch("/profile").then(r => r.ok ? r.json() : null).catch(() => null),
    apiFetch("/feeds").then(r => r.ok ? r.json() : null).catch(() => null),
    apiFetch("/radar").then(r => r.ok ? r.json() : null).catch(() => null),
    apiFetch("/settings").then(r => r.ok ? r.json() : null).catch(() => null)
  ]);

  // Guests always see zero stats, never the backend's guest profile
  applyUserStats(getSessionToken() ? profileRes : null);

  if (Array.isArray(feedsRes)) {
    state.feeds = feedsRes;
    renderFeeds();
  }

  if (Array.isArray(radarRes)) {
    state.radarPlants = radarRes;
    updateRadarDistances();
    renderRadarList();
    renderMapPlantMarkers();
  }

  loadBlockedUsers();

  if (settingsRes) {
    state.settings.publishAchievementsToFeed = settingsRes.publishAchievementsToFeed;
    state.settings.highAccuracyGps = settingsRes.highAccuracyGps;
    const pubEl = document.getElementById("setting-publish-achievements");
    if (pubEl) pubEl.checked = state.settings.publishAchievementsToFeed;
    const gpsEl = document.getElementById("setting-high-gps");
    if (gpsEl) gpsEl.checked = state.settings.highAccuracyGps;
  }
}

async function syncFromBackend() {
  updateBackendStatusUI(false, "Connecting to MariaDB backend...", true);

  let candidateEndpoints = [];

  if (!DEV_ENDPOINTS_ENABLED) {
    candidateEndpoints = [CLOUD_API_BASE];
  } else {
    // In Android runtime (Capacitor), prioritize Cloud then Android emulator / LAN / loopback
    candidateEndpoints = [
      CLOUD_API_BASE,
      LOCAL_EMULATOR_API_BASE,
      LOCAL_LAN_API_BASE,
      LOCAL_LOOPBACK_API_BASE
    ];
  }

  let healthRes = null;
  let activeEndpoint = null;
  let lastError = null;

  for (const ep of candidateEndpoints) {
    try {
      const res = await fetchWithTimeout(ep + "/health", {}, 4500);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.status === "ok") {
          healthRes = res;
          activeEndpoint = ep;
          API_BASE = ep;
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`PlantGo: Health check failed for ${ep}:`, err.message);
    }
  }

  if (!activeEndpoint) {
    state.backendConnected = false;
    updateBackendStatusUI(false, "Offline mode (Could not reach Cloud or Local MariaDB server)");
    console.warn("Backend unavailable, using local mock data. Last error:", lastError?.message);
    return;
  }

  try {
    state.backendConnected = true;
    let label = "";
    if (activeEndpoint.includes("plantgo.gptindia.pro")) {
      label = "Cloud Server (plantgo.gptindia.pro)";
    } else if (activeEndpoint.includes("10.0.2.2")) {
      label = "Android Emulator (10.0.2.2:5001)";
    } else if (activeEndpoint.includes("localhost")) {
      label = "Wi-Fi PC (localhost:5001)";
    } else {
      label = "Local Host (" + activeEndpoint + ")";
    }
    updateBackendStatusUI(true, label);

    await loadUserData();

    console.log("🌿 MariaDB PlantGo data synced successfully from " + activeEndpoint);
  } catch (err) {
    state.backendConnected = false;
    updateBackendStatusUI(false, "Offline mode (" + err.message + ")");
    console.warn("Backend data fetch error:", err.message);
  }
}

function updateBackendStatusUI(connected, text, isChecking = false) {
  const badge = document.getElementById("backend-status-badge");
  const desc = document.getElementById("backend-status-desc");
  if (badge) {
    if (isChecking) {
      badge.textContent = "Connecting... ⏳";
      badge.style.background = "rgba(33, 150, 243, 0.15)";
      badge.style.color = "#1976d2";
    } else {
      badge.textContent = connected ? "Connected 🟢" : "Offline 🟡";
      badge.style.background = connected ? "rgba(76, 175, 80, 0.15)" : "rgba(255, 152, 0, 0.15)";
      badge.style.color = connected ? "#2e7d32" : "#e65100";
    }
  }
  if (desc) {
    desc.textContent = text;
  }
}

// Expose globally for console testing
window.syncFromBackend = syncFromBackend;

// --- STATE MANAGEMENT ---
const state = {
  backendConnected: false,
  activeTab: 'map',
  layout: 'glass-dock',
  theme: 'light-mint',
  mapFilter: 'all',
  feedFilter: 'all',
  selectedPlantId: null,
  photoData: null,
  selectedOrgan: "auto",
  map: null,
  userMarker: null,
  accuracyCircle: null,
  currentLocation: null,
  mapInitialized: false,
  locationWatcher: null,
  mapMarkers: [],
  settings: {
    publishAchievementsToFeed: localStorage.getItem('plantgo_publish_feed') !== 'false', // Default true
    highAccuracyGps: true
  },
  userStats: {
    discoveredCount: 0,
    reviewedCount: 0,
    totalPoints: 0,
    level: 0,
    xp: 0,
    xpToNext: 0,
    milestoneAchieved: false
  },
  feeds: [],
  radarPlants: []
};

// --- CORE UTILITY FUNCTIONS ---

function changeTab(tabName) {
  if (tabName !== "ai-identify" && typeof stopLiveVideoStream === "function") stopLiveVideoStream();
  state.activeTab = tabName;
  document.querySelectorAll(".app-screen").forEach(screen => {
    screen.classList.remove("active");
  });

  const targetScreen = document.getElementById('screen-' + tabName);
  if (targetScreen) {
    targetScreen.classList.add("active");
  }

  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.remove("active");
    if (item.getAttribute("data-tab") === tabName) {
      item.classList.add("active");
    }
  });

  // Screen specific initializers
  if (tabName === 'map') {
    if (!state.mapInitialized) {
      initMap();
    } else if (state.map) {
      setTimeout(() => {
        state.map.invalidateSize();
      }, 150);
    }
  }
  if (tabName === 'ai-identify') {
    initCameraFlow();
  }
  if (tabName === 'feeds') {
    renderFeeds();
  }
  if (tabName === 'radar') {
    renderRadarList();
  }
  if (tabName === 'profile') {
    updateProfileUI();
    initGoogleAuth();
  }
}

// Toast notification helper
function showToast(message, duration = 3200) {
  const toast = document.getElementById('app-toast');
  if (!toast) return;
  // Callers sometimes pass a type ("success"/"error") instead of a duration
  if (typeof duration !== 'number') duration = duration === 'error' ? 5000 : 3200;
  toast.innerHTML = message;
  toast.classList.add('show');

  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// --- PERMISSION AND DIALOG UTILITIES ---

function showPermissionDeniedDialog(permissionName, onGrant, onGallery) {
  const existingDialog = document.getElementById('permission-dialog');
  if (existingDialog) existingDialog.remove();

  const dialogHtml =
    '<div id="permission-dialog" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; justify-content:center; align-items:center; z-index:9999;">' +
    '<div style="background:white; padding:22px; border-radius:14px; text-align:center; max-width: 320px; color: black; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">' +
    '<h4 style="margin-bottom: 8px; font-size: 1.05rem;">' + permissionName + ' Access Needed</h4>' +
    '<p style="margin-bottom: 18px; font-size: 0.85rem; color: #555;">' + permissionName + ' permission is required to discover and scan flora specimens.</p>' +
    '<button id="btn-grant-again" class="btn-primary" style="width:100%; margin-bottom: 8px; padding: 10px;">Grant Permission</button>' +
    (onGallery ? '<button id="btn-gallery-alt" class="btn-secondary" style="width:100%; margin-bottom: 8px; padding: 8px;">Choose From Gallery</button>' : '') +
    '<button id="btn-dialog-close" class="btn-secondary" style="width:100%; padding: 8px;">Cancel</button>' +
    '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', dialogHtml);

  document.getElementById('btn-grant-again').onclick = () => {
    document.getElementById('permission-dialog').remove();
    onGrant();
  };
  if (onGallery) {
    document.getElementById('btn-gallery-alt').onclick = () => {
      document.getElementById('permission-dialog').remove();
      onGallery();
    };
  }
  document.getElementById('btn-dialog-close').onclick = () => {
    document.getElementById('permission-dialog').remove();
  };
}

// --- MAP IMPLEMENTATION (OpenStreetMap + Leaflet) ---

function getCapacitorGeolocation() {
  if (typeof window !== 'undefined' && window.Capacitor) {
    if (window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
      return window.Capacitor.Plugins.Geolocation;
    }
    if (typeof window.Capacitor.registerPlugin === 'function') {
      try {
        return window.Capacitor.registerPlugin('Geolocation');
      } catch (e) { }
    }
  }
  return null;
}

function initMap(retryCount = 0) {
  if (state.mapInitialized) return;

  const mapElement = document.getElementById('map');
  if (!mapElement) {
    if (retryCount < 10) setTimeout(() => initMap(retryCount + 1), 150);
    return;
  }

  // Ensure Leaflet library is ready
  if (typeof L === 'undefined') {
    if (retryCount < 20) {
      setTimeout(() => initMap(retryCount + 1), 150);
      return;
    }
    console.error('Leaflet library failed to load.');
    updateGpsStatusBadge('denied', 'Map Offline');
    return;
  }

  try {
    // 1. Initialize Leaflet Map with OpenStreetMap raster tiles
    const initialCenter = state.currentLocation
      ? [state.currentLocation.lat, state.currentLocation.lng]
      : [12.9716, 77.5946];
    const initialZoom = state.currentLocation ? 16 : 13;

    state.map = L.map('map', {
      zoomControl: false,
      attributionControl: true
    }).setView(initialCenter, initialZoom);

    // Standard Free OpenStreetMap Tile Layer
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(state.map);

    if (state.map.attributionControl) {
      state.map.attributionControl.setPosition('bottomright');
      state.map.attributionControl.setPrefix(false);
    }

    // Attach controls & UI
    addMapControls();
    renderMapPlantMarkers();
    state.mapInitialized = true;

    // Window resize handler for tile realignment
    window.addEventListener('resize', () => {
      if (state.map) state.map.invalidateSize();
    });

    // Invalidate container size after mount
    setTimeout(() => {
      if (state.map) state.map.invalidateSize();
    }, 200);

  } catch (err) {
    console.error('Error during initMap:', err);
  }

  // 2. Request Location Permission & Start GPS Tracking
  checkAndRequestLocationPermission(false);
}

function addMapControls() {
  const mapContainer = document.querySelector('.map-canvas-container');
  if (!mapContainer) return;

  // Recenter GPS Button
  const recenterBtn = document.createElement('button');
  recenterBtn.type = 'button';
  recenterBtn.innerHTML = '📍';
  recenterBtn.className = 'map-fab-btn';
  recenterBtn.title = 'Recenter on My Location';
  recenterBtn.style.bottom = '110px';
  recenterBtn.style.left = '14px';
  recenterBtn.onclick = () => {
    if (state.currentLocation) {
      state.map.flyTo([state.currentLocation.lat, state.currentLocation.lng], 16, { animate: true, duration: 1.0 });
      showToast('📍 Recentered to your current GPS position');
    } else {
      showToast('🛰️ Requesting current location...');
      checkAndRequestLocationPermission(true);
    }
  };
  mapContainer.appendChild(recenterBtn);

  // Heatmap Toggle Button
  const heatmapBtn = document.createElement('button');
  heatmapBtn.type = 'button';
  heatmapBtn.innerHTML = '🔥';
  heatmapBtn.className = 'map-fab-btn';
  heatmapBtn.title = 'Botanical Density Heatmap';
  heatmapBtn.style.bottom = '165px';
  heatmapBtn.style.left = '14px';
  heatmapBtn.onclick = () => {
    heatmapBtn.classList.toggle('active');
    const isActive = heatmapBtn.classList.contains('active');
    showToast(isActive ? '🔥 Botanical density heatmap enabled' : 'Botanical density heatmap hidden');
  };
  mapContainer.appendChild(heatmapBtn);

  // Hook up the Map Capture Plant Button
  const captureBtn = document.getElementById('map-capture-btn');
  if (captureBtn) {
    captureBtn.onclick = () => {
      openCaptureFlow();
    };
  }

  // Hook up filter chips
  document.querySelectorAll('.map-filter-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      document.querySelectorAll('.map-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.mapFilter = chip.getAttribute('data-filter');
      renderMapPlantMarkers();
    });
  });
}

function renderMapPlantMarkers() {
  if (!state.map || typeof L === 'undefined') return;

  // Clear existing markers
  state.mapMarkers.forEach(m => state.map.removeLayer(m));
  state.mapMarkers = [];

  const plants = state.radarPlants.filter(p => {
    if (p.lat == null || p.lng == null) return false;
    if (state.mapFilter === 'all') return true;
    return p.category === state.mapFilter;
  });

  plants.forEach(plant => {
    const customIcon = L.divIcon({
      className: 'custom-plant-pin',
      html: `
        <div style="background:var(--primary, #2e7d32); color:white; border-radius:50%; width:36px; height:36px; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.35); border:2.5px solid white; font-size:18px; cursor:pointer;" title="${escapeHtml(plant.commonName || plant.title)}">
          🌿
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -20]
    });

    const marker = L.marker([plant.lat, plant.lng], { icon: customIcon }).addTo(state.map);

    // Bind interactive specimen popup
    marker.bindPopup(`
      <div style="font-family: inherit; font-size: 13px; min-width: 140px; padding: 6px 4px; text-align: center;">
        <strong style="color: var(--primary, #2e7d32); font-size: 14px; display: block; margin-bottom: 2px;">${escapeHtml(plant.commonName || plant.title)}</strong>
        <span style="font-style: italic; color: #666; font-size: 11px; display: block; margin-bottom: 8px;">${escapeHtml(plant.scientific || "")}</span>
        <button type="button" onclick="openSpecimenDetailsById('${plant.id}')" style="background: var(--primary, #2e7d32); color: white; border: none; padding: 6px 14px; border-radius: 14px; font-size: 11px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.2);">Inspect Specimen 🔍</button>
      </div>
    `);

    state.mapMarkers.push(marker);
  });
}

// --- GPS LOCATION & PERMISSION MANAGEMENT ---

function updateGpsStatusBadge(status, text) {
  const pill = document.getElementById('gps-status-pill');
  const label = document.getElementById('gps-status-text');
  if (!pill) return;
  pill.classList.remove('active', 'denied');
  if (status === 'active') pill.classList.add('active');
  if (status === 'denied') pill.classList.add('denied');
  if (label && text) label.textContent = text;
}

function showLocationPermissionBanner() {
  const banner = document.getElementById('map-location-banner');
  if (banner) banner.style.display = 'flex';
}

function hideLocationBanner() {
  const banner = document.getElementById('map-location-banner');
  if (banner) banner.style.display = 'none';
}

function handleUserLocationSuccess(lat, lng, accuracy, autoFly = false) {
  state.currentLocation = { lat, lng, accuracy };

  if (!state.map || typeof L === 'undefined') return;

  const latLng = [lat, lng];

  // 1. Create or update User Pulsing Beacon
  if (!state.userMarker) {
    const beaconIcon = L.divIcon({
      className: 'user-location-marker-container',
      html: `
        <div class="user-location-beacon">
          <div class="user-location-pulse"></div>
          <div class="user-location-dot"></div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    state.userMarker = L.marker(latLng, { icon: beaconIcon, zIndexOffset: 1000 }).addTo(state.map);
    state.userMarker.bindTooltip("You are here", { direction: 'top', offset: [0, -12] });
  } else {
    state.userMarker.setLatLng(latLng);
  }

  // 2. Create or update GPS Accuracy Circle
  const radius = Math.min(Math.max(accuracy || 25, 15), 250);
  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latLng, {
      radius: radius,
      color: '#2196f3',
      weight: 1,
      fillColor: '#2196f3',
      fillOpacity: 0.12
    }).addTo(state.map);
  } else {
    state.accuracyCircle.setLatLng(latLng);
    state.accuracyCircle.setRadius(radius);
  }

  // 3. Smooth flyTo on first location acquisition or recenter
  if (autoFly) {
    state.map.flyTo(latLng, 16, { animate: true, duration: 1.2 });
  }

  // 4. Update UI Statuses
  hideLocationBanner();
  updateGpsStatusBadge('active', 'GPS Active 📍');

  // 5. Refresh distances to nearby community sightings
  updateRadarDistances();
  renderRadarList();
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + "m away" : (m / 1000).toFixed(1) + " km away";
}

// Real distance from the user to each community sighting, nearest first
function updateRadarDistances() {
  const loc = state.currentLocation;
  state.radarPlants.forEach(p => {
    p.distM = loc && p.lat != null && p.lng != null ? distanceMeters(loc, p) : null;
    p.dist = p.distM != null ? formatDistance(p.distM) : "";
  });
  state.radarPlants.sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));
}

let gpsWatchdogTimer = null;
let isLocating = false;

async function checkAndRequestLocationPermission(userInitiated = false) {
  if (isLocating && !userInitiated) return;
  isLocating = true;

  updateGpsStatusBadge('locating', 'Acquiring GPS...');

  if (gpsWatchdogTimer) clearTimeout(gpsWatchdogTimer);
  gpsWatchdogTimer = setTimeout(() => {
    if (!state.currentLocation) {
      updateGpsStatusBadge('denied', 'Tap to Retry GPS 📍');
      showLocationPermissionBanner();
    }
    isLocating = false;
  }, 8000);

  const nativeGeo = getCapacitorGeolocation();

  // --- A. NATIVE CAPACITOR (Android runtime) ---
  if (isCapacitorNative() && nativeGeo) {
    try {
      let permission = await nativeGeo.checkPermissions();
      if (permission.location !== 'granted') {
        permission = await nativeGeo.requestPermissions();
      }

      if (permission.location === 'granted') {
        // Fast location retrieval
        try {
          const pos = await nativeGeo.getCurrentPosition({
            enableHighAccuracy: false,
            timeout: 5000,
            maximumAge: 60000
          });
          if (pos && pos.coords) {
            clearTimeout(gpsWatchdogTimer);
            handleUserLocationSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true);
          }
        } catch (fastErr) {
          console.warn('Fast native location failed, proceeding to high accuracy watch:', fastErr);
        }

        startLocationWatch();
        isLocating = false;
        return;
      } else {
        clearTimeout(gpsWatchdogTimer);
        isLocating = false;
        updateGpsStatusBadge('denied', 'Location Permission Denied');
        showLocationPermissionBanner();
        if (userInitiated) {
          showPermissionDeniedDialog('Location', () => checkAndRequestLocationPermission(true));
        }
        return;
      }
    } catch (e) {
      console.warn('Native geolocation check failed:', e);
      if (e && e.message && e.message.includes('Location services are not enabled')) {
        clearTimeout(gpsWatchdogTimer);
        isLocating = false;
        updateGpsStatusBadge('denied', 'Please Enable Device GPS');
        showToast('⚠️ Please turn on Location (GPS) in your Android quick settings.');
        return;
      }
      // If native fails, continue to web fallback below
    }
  }

  // --- B. WEB BROWSER RUNTIME (localhost:3000 / mobile browser) ---
  if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
    // 1. Fast position fetch with enableHighAccuracy: false (immediate resolution on desktop/laptops)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(gpsWatchdogTimer);
        isLocating = false;
        handleUserLocationSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true);
        startLocationWatch();
      },
      (fastErr) => {
        console.warn('Quick position failed, trying high accuracy...', fastErr);
        // 2. High accuracy fallback
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(gpsWatchdogTimer);
            isLocating = false;
            handleUserLocationSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true);
            startLocationWatch();
          },
          (err) => {
            clearTimeout(gpsWatchdogTimer);
            isLocating = false;
            console.warn('Web Geolocation error:', err);
            let msg = 'Location Access Denied';
            if (err.code === 1) msg = 'Permission Denied';
            else if (err.code === 2) msg = 'Location Unavailable';
            else if (err.code === 3) msg = 'Tap to Retry GPS 📍';

            updateGpsStatusBadge('denied', msg);
            showLocationPermissionBanner();
            if (userInitiated && err.code === 1) {
              showToast('📍 Location blocked. Please allow location in your device settings.');
            }
          },
          {
            enableHighAccuracy: true,
            timeout: 6000,
            maximumAge: 15000
          }
        );
      },
      {
        enableHighAccuracy: false,
        timeout: 4000,
        maximumAge: 60000
      }
    );
  } else {
    clearTimeout(gpsWatchdogTimer);
    isLocating = false;
    updateGpsStatusBadge('denied', 'Geolocation Not Supported');
    showToast('Geolocation is not supported by this browser.');
  }
}

function startLocationWatch() {
  if (state.locationWatcher) return;

  const nativeGeo = getCapacitorGeolocation();

  // Native Capacitor watch
  if (isCapacitorNative() && nativeGeo) {
    try {
      nativeGeo.watchPosition(
        {
          enableHighAccuracy: state.settings.highAccuracyGps,
          timeout: 15000,
          maximumAge: 5000
        },
        (position, err) => {
          if (err) {
            console.warn('Native location watch error:', err);
            return;
          }
          if (position && position.coords) {
            handleUserLocationSuccess(position.coords.latitude, position.coords.longitude, position.coords.accuracy, false);
          }
        }
      ).then(id => {
        state.locationWatcher = id;
      }).catch(err => {
        console.warn('Native watchPosition failed to start:', err);
      });
    } catch (err) {
      console.warn('Native Geolocation watch error:', err);
    }
    return;
  }

  // Web Browser watch
  if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
    try {
      state.locationWatcher = navigator.geolocation.watchPosition(
        (pos) => {
          handleUserLocationSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, false);
        },
        (err) => {
          console.warn('Web location watch error:', err);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 5000
        }
      );
    } catch (err) {
      console.warn('Web Geolocation watch error:', err);
    }
  }
}

window.checkAndRequestLocationPermission = checkAndRequestLocationPermission;

// --- CAPTURE & IDENTIFICATION WORKFLOW (Pl@ntNet AI) ---

let liveMediaStream = null;

function isCapacitorNative() {
  return (
    typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

function openCaptureFlow() {
  // Show the Upload / Open Camera choice; changeTab renders it via initCameraFlow
  changeTab("ai-identify");
}

function closeCameraView() {
  stopLiveVideoStream();
  changeTab("map");
}

function stopLiveVideoStream() {
  if (liveMediaStream) {
    try {
      liveMediaStream.getTracks().forEach(track => track.stop());
    } catch (e) { }
    liveMediaStream = null;
  }
  const videoEl = document.getElementById("camera-live-video");
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl.style.display = "none";
  }
}

async function startCameraCapture() {
  stopLiveVideoStream();


  // 1. If running natively in Android via Capacitor, trigger native Camera directly
  if (isCapacitorNative() && Camera) {
    await requestAndLaunchNativeCamera("camera");
    return;
  }

  // 2. If running on Web / localhost, attempt HTML5 getUserMedia live camera stream
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const constraints = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      liveMediaStream = stream;
      const videoEl = document.getElementById("camera-live-video");
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.style.display = "block";
        await videoEl.play();
        renderCameraControls("live-stream");
        return;
      }
    } catch (webCamErr) {
      console.warn("Live webcam stream rejected or unavailable:", webCamErr);
    }
  }

  // 3. Fallback: try Capacitor Camera or Web File Input
  if (Camera) {
    await requestAndLaunchNativeCamera("camera");
  } else {
    triggerWebFileInput();
  }
}

function captureLiveVideoFrame() {
  const videoEl = document.getElementById("camera-live-video");
  const canvasEl = document.getElementById("camera-snapshot-canvas");
  if (!videoEl || !canvasEl) return;

  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

  const dataUrl = canvasEl.toDataURL("image/jpeg", 0.9);
  state.photoData = dataUrl;

  stopLiveVideoStream();

  setPreviewPhoto(dataUrl);

  renderCameraControls("preview");
  showToast("Photo captured! Choose organ to identify 🌿", "success");
}

function triggerWebFileInput() {
  const fileInput = document.getElementById("web-file-input");
  if (fileInput) {
    fileInput.value = "";
    fileInput.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        state.photoData = event.target.result;
        stopLiveVideoStream();
        setPreviewPhoto(state.photoData);
        renderCameraControls("preview");
      };
      reader.readAsDataURL(file);
    };
    fileInput.click();
  } else {
    showToast("Photo picker is not available on this device", "error");
  }
}

// Shows the chosen photo as a card on the identify screen (null clears it)
function setPreviewPhoto(src) {
  const viewfinder = document.querySelector(".camera-viewfinder");
  const img = document.getElementById("identify-photo");
  if (img) {
    if (src) img.src = src;
    else img.removeAttribute("src");
  }
  if (viewfinder) viewfinder.classList.toggle("has-photo", Boolean(src));
}

function renderCameraControls(mode) {
  const cameraControls = document.getElementById("camera-controls-bottom");
  const viewfinder = document.querySelector(".camera-viewfinder");
  if (!cameraControls) return;
  cameraControls.innerHTML = "";
  // The welcome hero (Take Photo / Gallery) is only shown before a photo is chosen
  if (viewfinder) viewfinder.classList.toggle("is-initial", mode === "initial");

  if (mode === "live-stream") {
    cameraControls.innerHTML = `
      <div style="display:flex; justify-content:center; align-items:center; gap:20px; width:100%; position:relative; z-index:10;">
        <button class="btn-secondary" id="btn-switch-gallery" style="flex:1; max-width:130px; padding:10px; font-size:0.8rem; border-radius:12px;">🖼 Gallery</button>
        <button class="live-shutter-btn" id="btn-shutter" title="Take Photo">
          <div class="live-shutter-inner"></div>
        </button>
        <div style="flex:1; max-width:130px;"></div>
      </div>`;

    const shutterBtn = document.getElementById("btn-shutter");
    if (shutterBtn) shutterBtn.onclick = captureLiveVideoFrame;

    const galleryBtn = document.getElementById("btn-switch-gallery");
    if (galleryBtn) galleryBtn.onclick = triggerWebFileInput;

  } else if (mode === "initial") {
    setPreviewPhoto(null);

  } else if (mode === "preview") {
    state.selectedOrgan = state.selectedOrgan || "auto";
    const organs = [
      ["auto", "⚡ Auto"], ["flower", "🌸 Flower"], ["leaf", "🍃 Leaf"], ["fruit", "🍒 Fruit"], ["bark", "🪵 Bark"]
    ];

    cameraControls.innerHTML = `
      <div class="camera-preview-panel">
        <div class="organ-label">What part of the plant is this?</div>
        <div class="organ-chips-row">
          ${organs.map(([key, label]) => `<button class="organ-chip ${state.selectedOrgan === key ? "active" : ""}" data-organ="${key}">${label}</button>`).join("")}
        </div>
        <div class="camera-preview-menu">
          <button class="btn-secondary" id="btn-retake" style="flex:1;">🔄 Retake</button>
          <button class="btn-primary" id="btn-use-photo" style="flex:2;">🌿 Identify Plant</button>
        </div>
      </div>`;

    document.querySelectorAll(".organ-chip").forEach(chip => {
      chip.onclick = () => {
        state.selectedOrgan = chip.getAttribute("data-organ");
        renderCameraControls("preview");
      };
    });

    document.getElementById("btn-retake").onclick = () => renderCameraControls("initial");
    document.getElementById("btn-use-photo").onclick = () => runIdentification(state.photoData, state.selectedOrgan);

  } else if (mode === "analyzing") {
    cameraControls.innerHTML = `
      <div class="camera-preview-panel" style="text-align:center;">
        <h3 style="color:var(--primary); margin-bottom:6px;">Identifying your plant...</h3>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">Matching against 30,000+ species with Pl@ntNet.</p>
        <div class="loading-spinner" style="margin:0 auto;"></div>
      </div>`;
  }
}

async function requestAndLaunchNativeCamera(source = "camera") {
  const nativeCam = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera) ? window.Capacitor.Plugins.Camera : Camera;
  if (!nativeCam) {
    triggerWebFileInput();
    return;
  }

  try {
    // 1. Check and request permission on Capacitor Camera API
    // The gallery uses the system photo picker, which needs no permission
    if (source === "camera" && typeof nativeCam.checkPermissions === 'function') {
      try {
        const perm = await nativeCam.checkPermissions();
        if (perm && perm.camera !== 'granted') {
          if (typeof nativeCam.requestPermissions === 'function') {
            const req = await nativeCam.requestPermissions({ permissions: ['camera'] });
            if (req && req.camera !== 'granted') {
              showPermissionDeniedDialog(
                "Camera",
                () => requestAndLaunchNativeCamera("camera"),
                () => requestAndLaunchNativeCamera("photos")
              );
              return;
            }
          }
        }
      } catch (permErr) {
        console.warn("Camera checkPermissions error:", permErr);
      }
    }

    // 2. Launch Camera / Gallery
    const photo = await nativeCam.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: source === "photos" ? CameraSource.Photos : CameraSource.Camera,
      quality: 85,
      width: 1600,
      height: 1600,
      correctOrientation: true,
      allowEditing: false,
      saveToGallery: false
    });

    if (photo && photo.dataUrl) {
      state.photoData = photo.dataUrl;
      stopLiveVideoStream();
      setPreviewPhoto(photo.dataUrl);
      renderCameraControls("preview");
      showToast("Specimen photo captured! Select organ to identify 🌿", "success");
    }
  } catch (err) {
    console.warn("Native camera operation cancelled or error:", err);
    renderCameraControls("initial");
    const msg = (err && err.message) || "";
    if (!/cancel/i.test(msg)) {
      showToast("Camera error: " + (msg || "unable to capture photo"), "error");
    }
  }
}

async function checkAndRequestCameraPermission() {
  await startCameraCapture();
}

async function checkAndRequestGalleryPermission() {
  if (isCapacitorNative() && Camera) {
    await requestAndLaunchNativeCamera("photos");
  } else {
    triggerWebFileInput();
  }
}

function initCameraFlow() {
  const overlay = document.querySelector(".ai-results-overlay");
  if (overlay) overlay.classList.remove("active");
  renderCameraControls("initial");
}

window.openCaptureFlow = openCaptureFlow;
window.closeCameraView = closeCameraView;
window.startCameraCapture = startCameraCapture;
window.captureLiveVideoFrame = captureLiveVideoFrame;
window.checkAndRequestCameraPermission = checkAndRequestCameraPermission;
window.checkAndRequestGalleryPermission = checkAndRequestGalleryPermission;


async function runIdentification(photoPath, organ = "auto") {
  if (!photoPath) {
    showToast("Take or choose a photo first", "error");
    renderCameraControls("initial");
    return;
  }
  if (!state.backendConnected) {
    showToast("You're offline. Connect to the internet to identify plants.", "error");
    return;
  }

  renderCameraControls("analyzing");
  try {
    const resp = await apiFetch("/identify", {
      method: "POST",
      body: JSON.stringify({ image: photoPath, organ: organ || "auto" })
    }, 45000);
    const data = await resp.json().catch(() => null);

    if (!resp.ok) throw new Error((data && (data.error || data.message)) || "Server error " + resp.status);
    if (!data || !data.success) throw new Error((data && data.message) || "No botanical match found. Try a clearer photo of a flower or leaf.");

    displayIdentificationResult({
      commonName: data.commonName,
      scientificName: data.scientificName,
      confidence: data.confidence,
      confidenceScore: data.confidenceScore,
      family: data.family,
      detectedOrgan: data.detectedOrgan,
      description: data.description,
      care: data.care,
      sun: data.sun,
      water: data.water,
      category: data.category,
      candidates: data.candidates || [],
      remainingRequests: data.remainingRequests,
      image: photoPath
    });
    renderCameraControls("preview");
  } catch (err) {
    console.error("Pl@ntNet identification error:", err);
    const msg = err.name === "AbortError" ? "the request timed out" : err.message;
    showToast("Identification failed: " + msg, "error");
    renderCameraControls("preview");
  }
}

function displayIdentificationResult(result) {
  const overlay = document.querySelector(".ai-results-overlay");
  if (!overlay) return;

  overlay.querySelector("h3").textContent = "Identified: " + result.commonName;
  overlay.querySelector("p").textContent = result.scientificName + " • " + result.confidence + " Match";

  const statusBadge = overlay.querySelector(".ai-status-badge");
  if (statusBadge) {
    statusBadge.textContent = (result.confidenceScore && result.confidenceScore > 0.4) ? "🌿 Pl@ntNet Match" : "Botanical Candidate";
  }

  let candidatesHtml = "";
  if (result.candidates && result.candidates.length > 1) {
    candidatesHtml =
      '<div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">' +
      '<span style="font-size: 0.72rem; color: var(--primary); font-weight: 600; text-transform: uppercase;">Other Candidates:</span>' +
      '<div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:5px;">' +
      result.candidates.slice(1, 3).map(c =>
        '<span style="font-size: 0.7rem; background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 6px; color: var(--text-secondary);">' +
        escapeHtml((c.commonNames?.[0] || c.scientificName) + ' (' + c.score + ')') +
        '</span>'
      ).join('') +
      '</div>' +
      '</div>';
  }

  let quotaBadgeHtml = "";
  if (result.remainingRequests !== undefined) {
    quotaBadgeHtml =
      '<div style="margin-top: 8px; font-size: 0.72rem; color: #81c784; font-weight:500;">' +
      '✨ Pl@ntNet API Quota: ' + result.remainingRequests + ' requests remaining' +
      '</div>';
  }

  const detailsHtml =
    '<div class="result-details" style="padding: 0.6rem 0; font-size: 0.82rem; color: var(--text-secondary);">' +
    '<p style="margin-bottom:4px;"><b>Family:</b> ' + escapeHtml(result.family) + (result.detectedOrgan ? ' • <b>Organ:</b> ' + escapeHtml(result.detectedOrgan) : '') + '</p>' +
    (result.sun ? '<p style="margin-bottom:4px;"><b>Sunlight:</b> ' + escapeHtml(result.sun) + '</p>' : '') +
    (result.water ? '<p style="margin-bottom:4px;"><b>Water:</b> ' + escapeHtml(result.water) + '</p>' : '') +
    '<p style="margin-bottom:4px;"><b>Care:</b> ' + escapeHtml(result.care) + '</p>' +
    '<p><b>Notes:</b> ' + escapeHtml(result.description) + '</p>' +
    candidatesHtml +
    quotaBadgeHtml +
    '</div>';

  document.getElementById("ai-results-list").innerHTML = detailsHtml;

  const confirmRow = overlay.querySelector(".confirm-action-row");
  confirmRow.innerHTML =
    '<button class="btn-secondary" id="ai-cancel-btn">Retake</button>' +
    '<button class="btn-primary" id="ai-confirm-btn">Confirm & Submit (+250 XP)</button>';

  document.getElementById("ai-cancel-btn").onclick = () => {
    overlay.classList.remove("active");
    renderCameraControls("initial");
  };

  document.getElementById("ai-confirm-btn").onclick = () => {
    overlay.classList.remove("active");
    handlePlantSubmission(result);
  };

  overlay.classList.add("active");
}

// Handling when an identified plant is submitted
async function handlePlantSubmission(result) {
  if (!(await ensureSession())) {
    showToast("Sign in to save your discovery and earn XP 🌱", "error");
    renderCameraControls("preview");
    openAuthModal();
    return;
  }
  if (!state.backendConnected) {
    showToast("You're offline. Connect to the internet to submit this sighting.", "error");
    renderCameraControls("preview");
    return;
  }
  if (!(await confirmCommunityGuidelines())) {
    renderCameraControls("preview");
    return;
  }

  showToast("Saving your discovery...");
  try {
    const resp = await apiFetch("/feeds/sighting", {
      method: "POST",
      body: JSON.stringify({
        commonName: result.commonName,
        scientificName: result.scientificName,
        confidence: result.confidence,
        family: result.family,
        description: result.description,
        sun: result.sun,
        water: result.water,
        image: result.image,
        category: result.category || "flowers",
        lat: state.currentLocation ? state.currentLocation.lat : null,
        lng: state.currentLocation ? state.currentLocation.lng : null
      })
    }, 30000);

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.success) {
      throw new Error((data && data.error) || ("Server error " + resp.status));
    }

    applyUserStats(data.userStats);

    state.feeds.unshift(data.sighting);
    if (data.achievement) state.feeds.unshift(data.achievement);
    if (data.sighting.lat != null) {
      state.radarPlants.unshift(data.sighting);
      updateRadarDistances();
      renderMapPlantMarkers();
    }
    renderFeeds();

    if (data.milestoneTriggered) {
      showToast("🏆 Milestone reached: 10 plants identified!", 4500);
    } else if (data.leveledUp) {
      showToast("⬆️ Level up! You're now level " + state.userStats.level + ". +250 XP", 4000);
    } else {
      showToast("☘ Sighting saved! +250 XP");
    }
    renderCameraControls("initial");
    changeTab("feeds");
  } catch (err) {
    console.warn("Failed to save sighting:", err);
    showToast("Could not save sighting: " + err.message, "error");
    renderCameraControls("preview");
  }
}

// --- FEEDS IMPLEMENTATION ---

function renderFeeds() {
  const container = document.getElementById('feeds-container');
  if (!container) return;

  const filteredFeeds = state.feeds.filter(item => {
    if (state.feedFilter === 'all') return true;
    if (state.feedFilter === 'sightings') return item.type === 'sighting';
    if (state.feedFilter === 'achievements') return item.type === 'achievement';
    return true;
  });

  if (filteredFeeds.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🌱</div>
        <div class="empty-state-title">No sightings yet</div>
        <div class="empty-state-desc">Capture a plant from the Map tab to post the first discovery.</div>
      </div>`;
    return;
  }

  container.innerHTML = filteredFeeds.map(item => {
    const userLabel = escapeHtml(item.user) + (item.isUser ? ' (You)' : '');
    const when = item.createdAt ? timeAgo(item.createdAt) : 'Just now';
    if (item.type === 'achievement') {
      return `
        <div class="feed-achievement-card" data-id="${escapeHtml(item.id)}">
          <div class="feed-achievement-header">
            <div class="feed-achievement-user">
              <div class="feed-achievement-avatar" style="background-image: url('${escapeHtml(resolveImageUrl(item.avatar))}')"></div>
              <span>${userLabel}</span>
            </div>
            <span class="feed-header-right">${escapeHtml(item.badgeText)}${postMenuButton(item)}</span>
          </div>
          <div class="feed-achievement-body">
            <div class="feed-achievement-badge-icon">${escapeHtml(item.icon || '🏆')}</div>
            <div class="feed-achievement-details">
              <div class="feed-achievement-title">${escapeHtml(item.title)}</div>
              <div class="feed-achievement-desc">${escapeHtml(item.description)}</div>
            </div>
          </div>
          <div class="feed-achievement-footer">
            <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 500;">${escapeHtml(when)}</span>
            <span class="milestone-badge-pill">Milestone 🌟</span>
          </div>
        </div>
      `;
    }
    const image = resolveImageUrl(item.image);
    return `
      <div class="verification-card" data-id="${escapeHtml(item.id)}">
        <div class="verification-header">
          <span>${escapeHtml(item.badgeText)} • ${userLabel}</span>
          ${postMenuButton(item)}
        </div>
        ${image
        ? `<div class="verification-image" style="background-image: url('${escapeHtml(image)}')"></div>`
        : `<div class="verification-image verification-image-empty">🌿</div>`}
        <div class="verification-content">
          <div class="verification-title">${escapeHtml(item.title)}</div>
          <div class="verification-meta">${escapeHtml((item.subtitle ? item.subtitle + ' • ' : '') + when)}</div>

          <div class="verification-meta-stats">
            <span>Status: ${escapeHtml(item.status)}</span>
            <span>${item.votes} community ${item.votes === 1 ? 'vouch' : 'vouches'}</span>
          </div>
          ${item.isUser ? '' : `<button class="btn-secondary feed-vouch-btn" onclick="vouchSighting('${escapeHtml(item.id)}')">✓ Vouch for this ID (+50 XP)</button>`}
        </div>
      </div>
    `;
  }).join('');
}

function postMenuButton(item) {
  if (item.isUser) return '';
  return `<button type="button" class="post-menu-btn" onclick="openPostActions('${escapeHtml(item.id)}')" aria-label="Report or block">⋯</button>`;
}

// --- REPORT & BLOCK (user-generated content moderation) ---

function findPost(feedId) {
  return state.feeds.find(f => f.id === feedId) || state.radarPlants.find(f => f.id === feedId);
}

// Drops posts from the local lists and redraws every view that shows them
function removePostsLocally(predicate) {
  state.feeds = state.feeds.filter(f => !predicate(f));
  state.radarPlants = state.radarPlants.filter(f => !predicate(f));
  renderFeeds();
  renderRadarList();
  renderMapPlantMarkers();
}

window.openPostActions = async function (feedId) {
  const post = findPost(feedId);
  if (!post) return;
  if (!(await ensureSession())) {
    showToast("Sign in to report or block", "error");
    openAuthModal();
    return;
  }
  state.actionPostId = feedId;
  const blockBtn = document.getElementById("post-action-block");
  if (blockBtn) {
    blockBtn.textContent = "⛔ Block " + (post.user || "this user");
    blockBtn.style.display = post.authorId ? "" : "none";
  }
  document.getElementById("post-actions-overlay").classList.add("active");
};

window.closePostActions = function () {
  document.getElementById("post-actions-overlay").classList.remove("active");
};

window.reportPost = async function (reason) {
  const feedId = state.actionPostId;
  closePostActions();
  if (!feedId) return;
  try {
    const resp = await apiFetch("/feeds/" + encodeURIComponent(feedId) + "/report", {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || "Server error " + resp.status);
    removePostsLocally(f => f.id === feedId);
    closeSpecimenDetails();
    showToast("Thanks, we'll review this post. It's now hidden for you.");
  } catch (err) {
    showToast("Could not report: " + err.message, "error");
  }
};

window.blockPostAuthor = async function () {
  const post = findPost(state.actionPostId);
  closePostActions();
  if (!post || !post.authorId) return;
  if (!window.confirm("Block " + (post.user || "this user") + "?\n\nYou won't see their posts anymore. You can unblock them from your Profile.")) return;
  try {
    const resp = await apiFetch("/users/" + encodeURIComponent(post.authorId) + "/block", { method: "POST" });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || "Server error " + resp.status);
    removePostsLocally(f => f.authorId === post.authorId);
    closeSpecimenDetails();
    loadBlockedUsers();
    showToast("⛔ " + escapeHtml(post.user || "User") + " is blocked");
  } catch (err) {
    showToast("Could not block: " + err.message, "error");
  }
};

async function loadBlockedUsers() {
  const section = document.getElementById("profile-blocked-section");
  const list = document.getElementById("profile-blocked-list");
  if (!section || !list) return;
  if (!getSessionToken()) {
    section.style.display = "none";
    return;
  }
  const users = await apiFetch("/blocks").then(r => r.ok ? r.json() : null).catch(() => null);
  if (!Array.isArray(users) || users.length === 0) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  list.innerHTML = users.map((u, i) => `
    ${i > 0 ? '<div class="setting-divider"></div>' : ''}
    <div class="blocked-user-row">
      <div class="blocked-user-avatar" style="background-image: url('${escapeHtml(resolveImageUrl(u.avatar))}')"></div>
      <span class="blocked-user-name">${escapeHtml(u.username)}</span>
      <button type="button" class="btn-secondary blocked-user-unblock" onclick="unblockUser('${escapeHtml(u.id)}')">Unblock</button>
    </div>`).join('');
}

window.unblockUser = async function (userId) {
  try {
    const resp = await apiFetch("/users/" + encodeURIComponent(userId) + "/block", { method: "DELETE" });
    if (!resp.ok) throw new Error("Server error " + resp.status);
    showToast("User unblocked");
    loadUserData();
  } catch (err) {
    showToast("Could not unblock: " + err.message, "error");
  }
};

// Asks once for agreement to the Community Guidelines before the first post
let guidelinesResolver = null;
function confirmCommunityGuidelines() {
  if (localStorage.getItem("plantgo_guidelines_accepted") === "1") return Promise.resolve(true);
  document.getElementById("guidelines-overlay").classList.add("active");
  return new Promise(resolve => { guidelinesResolver = resolve; });
}

window.resolveGuidelines = function (accepted) {
  document.getElementById("guidelines-overlay").classList.remove("active");
  if (accepted) localStorage.setItem("plantgo_guidelines_accepted", "1");
  if (guidelinesResolver) guidelinesResolver(accepted);
  guidelinesResolver = null;
};

function timeAgo(dateValue) {
  const then = new Date(dateValue).getTime();
  if (!Number.isFinite(then)) return 'Just now';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days < 30 ? days + 'd ago' : new Date(then).toLocaleDateString();
}

window.vouchSighting = async function (feedId) {
  if (!(await ensureSession())) {
    showToast("Sign in to vouch for sightings", "error");
    openAuthModal();
    return;
  }
  try {
    const resp = await apiFetch("/feeds/" + encodeURIComponent(feedId) + "/vote", { method: "POST" });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || "Server error " + resp.status);
    [state.feeds, state.radarPlants].forEach(list => {
      const item = list.find(f => f.id === feedId);
      if (item) Object.assign(item, { votes: data.feed.votes, verified: data.feed.verified, status: data.feed.status });
    });
    applyUserStats(data.userStats);
    renderFeeds();
    renderRadarList();
    showToast("✓ Vouched! +50 XP");
  } catch (err) {
    showToast(err.message, "error");
  }
};

// --- RADAR IMPLEMENTATION ---

function renderRadarList() {
  const listContainer = document.querySelector('.radar-list');
  if (!listContainer) return;

  // Status line and sonar dots reflect real sightings within 5 km
  const nearby = state.radarPlants.filter(p => p.distM != null && p.distM <= 5000);
  const status = document.getElementById('radar-status');
  if (status) {
    if (!state.currentLocation) status.textContent = 'Waiting for GPS...';
    else if (nearby.length === 0) status.textContent = 'No sightings within 5 km yet';
    else status.textContent = nearby.length + ' sighting' + (nearby.length === 1 ? '' : 's') + ' within 5 km';
  }
  const dots = document.getElementById('radar-dots');
  if (dots) {
    const loc = state.currentLocation;
    dots.innerHTML = loc ? nearby.slice(0, 12).map(p => {
      const r = Math.min(1, p.distM / 5000) * 45;
      const angle = Math.atan2(p.lat - loc.lat, p.lng - loc.lng);
      return `<div class="radar-target-dot" style="top:${50 - r * Math.sin(angle)}%; left:${50 + r * Math.cos(angle)}%;"></div>`;
    }).join('') : '';
  }

  if (state.radarPlants.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📡</div>
        <div class="empty-state-title">No plants spotted nearby yet</div>
        <div class="empty-state-desc">Sightings you and other explorers capture will appear here.</div>
      </div>`;
    return;
  }

  listContainer.innerHTML = state.radarPlants.map(plant => {
    const image = resolveImageUrl(plant.image);
    return `
    <div class="stat-box" style="display:flex; align-items:center; gap:12px; padding:10px 14px; margin-bottom:8px; cursor:pointer;" onclick="openSpecimenDetailsById('${escapeHtml(plant.id)}')">
      <div style="width:44px; height:44px; border-radius:8px; background:#e8f5e9 center/cover no-repeat; ${image ? `background-image:url('${escapeHtml(image)}');` : ''} flex-shrink:0; display:flex; align-items:center; justify-content:center;">${image ? '' : '🌿'}</div>
      <div style="flex:1; text-align:left; min-width:0;">
        <div style="font-size:0.88rem; font-weight:700; color:var(--text-primary);">${escapeHtml(plant.commonName || plant.title)}</div>
        <div style="font-size:0.75rem; color:var(--text-secondary); font-style:italic;">${escapeHtml(plant.scientific || '')}</div>
      </div>
      ${plant.dist ? `<div style="text-align:right;"><span class="milestone-badge-pill" style="font-size:0.7rem;">${escapeHtml(plant.dist)}</span></div>` : ''}
    </div>`;
  }).join('');
}

// --- SPECIMEN DETAILS DRAWER ---

window.openSpecimenDetailsById = function (plantId) {
  const plant = state.radarPlants.find(p => p.id === plantId) || state.feeds.find(p => p.id === plantId);
  if (plant) openSpecimenDetails(plant);
};

function openSpecimenDetails(plant) {
  const sheet = document.querySelector('.detail-bottom-sheet');
  if (!sheet) return;
  state.selectedPlantId = plant.id;
  if (state.map) state.map.closePopup();

  sheet.querySelector('.detail-common-name').textContent = plant.commonName || plant.title;
  sheet.querySelector('.detail-scientific-name').textContent = plant.scientific || '';

  const headerGrad = sheet.querySelector('.detail-image-grad');
  if (headerGrad) {
    const image = resolveImageUrl(plant.image);
    headerGrad.style.backgroundImage = image
      ? 'linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.85)), url("' + image + '")'
      : 'linear-gradient(135deg, #1b5e20, #43a047)';
    headerGrad.style.backgroundSize = 'cover';
    headerGrad.style.backgroundPosition = 'center';
  }

  const pillContainer = document.getElementById('detail-pill-container');
  if (pillContainer) {
    pillContainer.innerHTML = [plant.category, plant.family, plant.confidence ? plant.confidence + ' match' : null]
      .filter(Boolean)
      .map(t => `<span class="detail-pill">${escapeHtml(t)}</span>`)
      .join('');
  }

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || 'Unknown';
  };
  setText('detail-desc', plant.description || 'No notes for this sighting yet.');
  setText('detail-sun', plant.sun);
  setText('detail-water', plant.water);
  setText('detail-spotted-by', plant.user ? plant.user + (plant.isUser ? ' (You)' : '') : '');
  setText('detail-distance', plant.dist || (plant.createdAt ? timeAgo(plant.createdAt) : ''));
  setText('detail-status', plant.status);
  setText('detail-votes', plant.votes + ' community ' + (plant.votes === 1 ? 'vouch' : 'vouches'));

  const voteBtn = document.getElementById('detail-vote-action-btn');
  if (voteBtn) voteBtn.style.display = plant.isUser ? 'none' : '';
  const reportBtn = document.getElementById('detail-report-btn');
  if (reportBtn) reportBtn.style.display = plant.isUser ? 'none' : '';

  sheet.classList.add('active');
}

function closeSpecimenDetails() {
  const sheet = document.querySelector('.detail-bottom-sheet');
  if (sheet) sheet.classList.remove('active');
}

// --- PROFILE & SETTINGS UI SYNC ---

function updateProfileUI() {
  const stats = state.userStats;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('profile-discovered-count', stats.discoveredCount);
  setText('profile-verified-count', stats.reviewedCount);
  setText('profile-total-points', Number(stats.totalPoints).toLocaleString());
  const isGuest = stats.level === 0;
  setText('profile-rank', (isGuest ? 'Guest Explorer' : 'Botanist Rank') + ' (Lv. ' + stats.level + ')');

  const pointsTxt = document.getElementById('profile-points-txt');
  if (pointsTxt) {
    pointsTxt.innerHTML = isGuest
      ? 'Sign in to start earning XP'
      : 'XP to Level ' + (stats.level + 1) + ': <span class="xp-indicator"></span>';
  }

  document.querySelectorAll('.level-val').forEach(el => { el.textContent = 'Lv ' + stats.level; });
  document.querySelectorAll('.xp-indicator').forEach(el => {
    el.textContent = isGuest ? '0 XP' : stats.xp + ' / ' + stats.xpToNext + ' XP';
  });
  const xpFill = document.getElementById('profile-xp-fill');
  if (xpFill) xpFill.style.width = isGuest ? '0%' : Math.min(100, Math.round((stats.xp / Math.max(1, stats.xpToNext)) * 100)) + '%';

  // Milestone Progress
  const count = stats.discoveredCount;
  setText('milestone-status-badge', count >= 10 ? 'Completed 🎉' : count + ' / 10');
  const milestoneFill = document.getElementById('milestone-bar-fill');
  if (milestoneFill) milestoneFill.style.width = Math.min(100, Math.round((count / 10) * 100)) + '%';
  if (count >= 10) {
    setText('milestone-subtext', 'Milestone achieved! 10 plants identified in the field.');
  } else {
    const remaining = 10 - count;
    setText('milestone-subtext', remaining + ' more ' + (remaining === 1 ? 'discovery' : 'discoveries') + ' to reach milestone!');
  }

  // Badges unlock by number of discoveries
  document.querySelectorAll('.badge-icon-wrap[data-unlock-at]').forEach(badge => {
    const unlocked = count >= parseInt(badge.getAttribute('data-unlock-at'), 10);
    badge.classList.toggle('unlocked', unlocked);
    badge.classList.toggle('locked', !unlocked);
  });
}

// --- INITIALIZATION ---

function initApp() {
  // Navigation event listeners
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = item.getAttribute("data-tab");
      changeTab(tabName);
    });
  });

  // Camera back button
  const cameraBackBtn = document.getElementById('camera-back-btn');
  if (cameraBackBtn) {
    cameraBackBtn.onclick = () => {
      changeTab('map');
    };
  }

  // Detail Sheet close button
  const sheetClose = document.querySelector('.detail-sheet-close');
  if (sheetClose) {
    sheetClose.onclick = closeSpecimenDetails;
  }

  const sheetReportBtn = document.getElementById('detail-report-btn');
  if (sheetReportBtn) {
    sheetReportBtn.onclick = () => {
      if (state.selectedPlantId) openPostActions(state.selectedPlantId);
    };
  }

  // Detail sheet vote button
  const sheetVoteBtn = document.getElementById('detail-vote-action-btn');
  if (sheetVoteBtn) {
    sheetVoteBtn.onclick = async () => {
      if (!state.selectedPlantId) return;
      await vouchSighting(state.selectedPlantId);
      closeSpecimenDetails();
    };
  }

  // Feed Filter Chips
  document.querySelectorAll('.feed-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.feed-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.feedFilter = chip.getAttribute('data-feed-filter');
      renderFeeds();
    });
  });

  // Settings: Publish Achievements to Feed Toggle
  const publishToggle = document.getElementById("setting-publish-achievements");
  if (publishToggle) {
    publishToggle.checked = state.settings.publishAchievementsToFeed;
    publishToggle.addEventListener("change", async (e) => {
      state.settings.publishAchievementsToFeed = e.target.checked;
      localStorage.setItem("plantgo_publish_feed", e.target.checked ? "true" : "false");
      if (state.backendConnected && getSessionToken()) {
        try {
          await apiFetch("/settings", {
            method: "PUT",
            body: JSON.stringify({
              publishAchievementsToFeed: state.settings.publishAchievementsToFeed,
              highAccuracyGps: state.settings.highAccuracyGps
            })
          });
        } catch (err) {
          console.warn("Settings sync to MariaDB failed:", err);
        }
      }
      showToast(e.target.checked
        ? "Settings: Achievements will be published to the Community Feed"
        : "Settings: Achievements will NOT be published to the Feed (Private)");
    });
  }

  // Settings: High GPS Toggle
  const gpsToggle = document.getElementById('setting-high-gps');
  if (gpsToggle) {
    gpsToggle.checked = state.settings.highAccuracyGps;
    gpsToggle.addEventListener('change', (e) => {
      state.settings.highAccuracyGps = e.target.checked;
      showToast(e.target.checked ? 'High accuracy GPS enabled' : 'Battery saver GPS mode active');
    });
  }

  // Initial tab setup
  changeTab('map');
  updateProfileUI();

  initFirebaseAuth();

  // Sync data with MariaDB backend
  syncFromBackend();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

window.state = state;


// --- FIREBASE AUTHENTICATION INITIALIZATION & HANDLERS ---
const firebaseConfig = {
  projectId: "REDACTED",
  appId: "REDACTED",
  storageBucket: "REDACTED",
  apiKey: "REDACTED",
  authDomain: "REDACTED",
  messagingSenderId: "REDACTED",
  measurementId: "REDACTED"
};

let fbAuth = null;
let currentUser = null;
let authIsSignUp = false;

function initFirebaseAuth() {
  try {
    if (typeof firebase !== 'undefined') {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      fbAuth = firebase.auth();

      fbAuth.onAuthStateChanged((user) => {
        if (user) {
          signInToBackendWithFirebase(user);
        } else if (currentUser && currentUser.provider === "firebase") {
          clearSignedInUser();
        }
      });
      console.log("☘ Firebase Auth initialized successfully");
    } else {
      console.warn("Firebase SDK not yet loaded.");
    }
  } catch (err) {
    console.error("Firebase Auth initialization warning:", err);
  }

  // Setup DOM Event Listeners as well as inline handlers
  const headerBtn = document.getElementById('header-auth-btn');
  const modalOverlay = document.getElementById('auth-modal-overlay');
  const closeBtn = document.getElementById('auth-modal-close');
  const form = document.getElementById('auth-form');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const logoutBtn = document.getElementById('auth-logout-btn');

  if (headerBtn) headerBtn.onclick = openAuthModal;
  if (closeBtn) closeBtn.onclick = closeAuthModal;
  if (toggleBtn) toggleBtn.onclick = toggleAuthMode;
  if (logoutBtn) logoutBtn.onclick = handleAuthLogout;
  if (form) form.onsubmit = handleAuthSubmit;
  if (modalOverlay) {
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) closeAuthModal();
    };
  }
}

function openAuthModal() {
  const overlay = document.getElementById('auth-modal-overlay');
  const errorBanner = document.getElementById('auth-error-msg');
  if (errorBanner) errorBanner.style.display = 'none';

  const authForm = document.getElementById('auth-form');
  const loggedInView = document.getElementById('auth-logged-in-view');

  if (currentUser) {
    if (authForm) authForm.style.display = 'none';
    if (loggedInView) loggedInView.style.display = 'flex';
    const emailEl = document.getElementById('auth-user-email');
    if (emailEl) emailEl.textContent = currentUser.email || 'Explorer';
    const titleEl = document.getElementById('auth-modal-title');
    if (titleEl) titleEl.textContent = 'Account Profile';
    const subEl = document.getElementById('auth-modal-subtitle');
    if (subEl) subEl.textContent = currentUser.provider === 'google' ? 'Signed in with Google' : 'Signed in with email';
  } else {
    if (authForm) authForm.style.display = 'flex';
    if (loggedInView) loggedInView.style.display = 'none';
    updateAuthModalMode();
    initGoogleAuth();
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.classList.add('active');
  }
}

function closeAuthModal() {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');
  }
}

function toggleAuthMode() {
  authIsSignUp = !authIsSignUp;
  updateAuthModalMode();
}

function updateAuthModalMode() {
  const title = document.getElementById('auth-modal-title');
  const subtitle = document.getElementById('auth-modal-subtitle');
  const submitBtn = document.getElementById('auth-submit-btn');
  const prompt = document.getElementById('auth-toggle-prompt');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const errorBanner = document.getElementById('auth-error-msg');
  if (errorBanner) errorBanner.style.display = 'none';

  if (authIsSignUp) {
    if (title) title.textContent = 'Create Explorer Account';
    if (subtitle) subtitle.textContent = 'Join the botanical citizen-science network';
    if (submitBtn) submitBtn.textContent = 'Create Account';
    if (prompt) prompt.textContent = 'Already have an account?';
    if (toggleBtn) toggleBtn.textContent = 'Sign In';
  } else {
    if (title) title.textContent = 'Welcome to PlantGo';
    if (subtitle) subtitle.textContent = 'Sign in to sync your botanical discoveries & rank';
    if (submitBtn) submitBtn.textContent = 'Sign In';
    if (prompt) prompt.textContent = "Don't have an account?";
    if (toggleBtn) toggleBtn.textContent = 'Create Account';
  }
}

async function handleAuthSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const emailInput = document.getElementById('auth-email');
  const passInput = document.getElementById('auth-password');
  const errorBanner = document.getElementById('auth-error-msg');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (!emailInput || !passInput) return false;
  const email = emailInput.value.trim();
  const password = passInput.value;

  if (!email || !password) {
    if (errorBanner) {
      errorBanner.textContent = 'Please fill in both email and password.';
      errorBanner.style.display = 'block';
    }
    return false;
  }

  if (password.length < 6) {
    if (errorBanner) {
      errorBanner.textContent = 'Password must be at least 6 characters.';
      errorBanner.style.display = 'block';
    }
    return false;
  }

  if (errorBanner) errorBanner.style.display = 'none';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait...';
  }

  try {
    if (!fbAuth) {
      if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        fbAuth = firebase.auth();
      } else {
        throw new Error('Firebase SDK is not loaded. Please check your internet connection.');
      }
    }

    if (authIsSignUp) {
      const res = await fbAuth.createUserWithEmailAndPassword(email, password);
      showToast('Account created! Welcome, ' + (res.user.email || 'Explorer') + ' 🌱', 'success');
    } else {
      const res = await fbAuth.signInWithEmailAndPassword(email, password);
      showToast('Signed in as ' + (res.user.email || 'Explorer') + ' ☘', 'success');
    }
    closeAuthModal();
  } catch (err) {
    console.error('Firebase Auth Error:', err);
    let msg = err.message || 'Authentication error';
    if (err.code === 'auth/invalid-email') msg = 'Invalid email address format.';
    else if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') msg = 'Incorrect email or password.';
    else if (err.code === 'auth/wrong-password') msg = 'Incorrect password.';
    else if (err.code === 'auth/email-already-in-use') msg = 'Email is already registered. Click "Sign In" below.';
    else if (err.code === 'auth/weak-password') msg = 'Password must be at least 6 characters.';
    else if (err.code === 'auth/operation-not-allowed') msg = 'Email/Password auth is not enabled in Firebase Console.';
    if (errorBanner) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = authIsSignUp ? 'Create Account' : 'Sign In';
    }
  }
  return false;
}

// Web Google Sign-In and Android Web Client ID from REDACTED (Project: REDACTED)
const GOOGLE_CLIENT_ID = "REDACTED.apps.googleusercontent.com";
const GOOGLE_ANDROID_WEB_CLIENT_ID = "REDACTED.apps.googleusercontent.com";

// Inside the Android app, Google's web button can't work (it navigates the WebView away),
// so use the native Sign in with Google sheet via the SocialLogin plugin instead.
let nativeGoogleReady = null;

function getNativeSocialLogin() {
  return isCapacitorNative() && window.Capacitor.Plugins && window.Capacitor.Plugins.SocialLogin
    ? window.Capacitor.Plugins.SocialLogin
    : null;
}

async function nativeGoogleSignIn() {
  const social = getNativeSocialLogin();
  if (!social) return;
  try {
    if (!nativeGoogleReady) {
      nativeGoogleReady = social.initialize({ google: { webClientId: GOOGLE_ANDROID_WEB_CLIENT_ID } });
    }
    await nativeGoogleReady;
    const res = await social.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    const idToken = res && res.result && res.result.idToken;
    if (!idToken) throw new Error("Google did not return an ID token");
    await handleGoogleCredentialResponse({ credential: idToken });
  } catch (err) {
    nativeGoogleReady = null;
    const msg = (err && err.message) || String(err);
    console.warn("Native Google sign-in failed:", err);
    if (!/cancel/i.test(msg)) showToast("Google sign-in failed: " + msg, "error");
  }
}

function renderNativeGoogleButtons() {
  ["google-signin-modal-btn", "profile-google-btn-container"].forEach(id => {
    const container = document.getElementById(id);
    if (!container) return;
    container.innerHTML =
      '<button type="button" class="native-google-btn">' +
      '<span class="native-google-g">G</span><span>Sign in with Google</span>' +
      '</button>';
    container.querySelector("button").onclick = nativeGoogleSignIn;
  });
}

function initGoogleAuth() {
  if (getNativeSocialLogin()) {
    renderNativeGoogleButtons();
    return;
  }
  if (typeof google !== "undefined" && google.accounts && google.accounts.id) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true
    });

    // Render button inside Auth Modal
    const modalBtnContainer = document.getElementById("google-signin-modal-btn");
    if (modalBtnContainer) {
      modalBtnContainer.innerHTML = "";
      google.accounts.id.renderButton(modalBtnContainer, {
        theme: "outline",
        size: "large",
        type: "standard",
        text: "continue_with",
        shape: "rectangular",
        logo_alignment: "left",
        width: 280
      });
    }

    // Render button on Profile screen
    const profileBtnContainer = document.getElementById("profile-google-btn-container");
    if (profileBtnContainer) {
      profileBtnContainer.innerHTML = "";
      google.accounts.id.renderButton(profileBtnContainer, {
        theme: "filled_blue",
        size: "medium",
        type: "standard",
        text: "continue_with",
        shape: "pill"
      });
    }
  } else {
    // Retry once if Google script is still asynchronously loading
    setTimeout(initGoogleAuth, 500);
  }
}

// Stores the backend session for a verified account and loads its real data
function completeSignIn(data, provider) {
  setSessionToken(data.sessionToken);
  const u = data.user;
  currentUser = {
    displayName: u.username || "Explorer",
    email: u.email || "",
    photoURL: u.avatar || "",
    id: u.id,
    provider
  };
  localStorage.setItem("plantgo_saved_user", JSON.stringify(currentUser));
  applyUserStats(u);
  updateAuthUI(currentUser);
  loadUserData();
}

async function signInToBackendWithFirebase(fbUser, notify = true) {
  try {
    const idToken = await fbUser.getIdToken();
    const res = await fetchWithTimeout(API_BASE + "/auth/firebase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: idToken })
    }, 10000);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.sessionToken) {
      throw new Error((data && data.error) || "Server error " + res.status);
    }
    completeSignIn(data, "firebase");
    return true;
  } catch (err) {
    console.warn("Could not connect Firebase account to backend:", err);
    if (notify) showToast("Couldn't load your PlantGo profile: " + err.message, "error");
    return false;
  }
}

// Makes sure a backend session exists, retrying the Firebase exchange if needed
async function ensureSession() {
  if (getSessionToken()) return true;
  if (fbAuth && fbAuth.currentUser) return signInToBackendWithFirebase(fbAuth.currentUser);
  return false;
}

async function handleGoogleCredentialResponse(response) {
  const idToken = response.credential;
  if (!idToken) return;

  showToast("Verifying Google account...");
  try {
    const res = await fetchWithTimeout(API_BASE + "/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: idToken })
    }, 10000);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.sessionToken) {
      throw new Error((data && data.error) || "Server error " + res.status);
    }
    completeSignIn(data, "google");
    closeAuthModal();
    showToast("Welcome, " + currentUser.displayName + " ☘", "success");
  } catch (err) {
    console.warn("Google sign-in failed:", err);
    showToast("Google sign-in failed: " + err.message, "error");
  }
}

function clearSignedInUser() {
  localStorage.removeItem("plantgo_saved_user");
  setSessionToken(null);
  currentUser = null;
  applyUserStats(null);
  updateAuthUI(null);
  if (state.backendConnected) loadUserData();
}

async function handleAuthLogout() {
  try {
    if (fbAuth && fbAuth.currentUser) {
      await fbAuth.signOut();
    }
    if (typeof google !== "undefined" && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    const social = getNativeSocialLogin();
    if (social) {
      try { await social.logout({ provider: "google" }); } catch (e) { }
    }
    clearSignedInUser();
    initGoogleAuth();
    showToast("Signed out of PlantGo");
    closeAuthModal();
  } catch (err) {
    console.error("Sign out error:", err);
  }
}

// Permanently deletes the account and all its data on the server, then signs out
async function handleDeleteAccount() {
  const ok = window.confirm(
    "Delete your PlantGo account?\n\nThis permanently removes your profile, XP, sightings, photos and vouches. This cannot be undone."
  );
  if (!ok) return;
  try {
    const res = await apiFetch("/account", { method: "DELETE" }, 15000);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.error) || "Server error " + res.status);
    }
    await handleAuthLogout();
    showToast("Your account and data have been deleted");
  } catch (err) {
    console.error("Delete account error:", err);
    showToast("Could not delete account: " + err.message, "error");
  }
}

function updateAuthUI(user) {
  const label = document.getElementById("header-auth-label");
  const icon = document.getElementById("header-auth-icon");
  const headerBtn = document.getElementById("header-auth-btn");
  const profileNameEl = document.querySelector(".profile-name");
  const profileAvatar = document.querySelector(".profile-avatar-large");
  const profileUnauthCard = document.getElementById("profile-auth-unauth");
  const profileLoggedCard = document.getElementById("profile-auth-logged");
  const profileEmailTxt = document.getElementById("profile-google-email");
  const deleteAccountBtn = document.getElementById("btn-delete-account");
  const editProfileBtn = document.getElementById("btn-edit-profile");
  const avatarEditBadge = document.getElementById("profile-avatar-edit-badge");

  if (profileAvatar) profileAvatar.disabled = !user;
  if (editProfileBtn) editProfileBtn.style.display = user ? "inline-flex" : "none";
  if (avatarEditBadge) avatarEditBadge.style.display = user ? "flex" : "none";

  if (user) {
    const displayName = user.displayName || (user.email ? user.email.split("@")[0] : "Explorer");
    if (label) label.textContent = displayName;
    if (icon) icon.textContent = "🌿";
    if (headerBtn) headerBtn.classList.add("logged-in");
    if (profileNameEl) profileNameEl.textContent = displayName;
    if (profileAvatar && user.photoURL) {
      profileAvatar.style.backgroundImage = cssUrl(resolveImageUrl(user.photoURL));
    }
    if (profileUnauthCard) profileUnauthCard.style.display = "none";
    if (profileLoggedCard) profileLoggedCard.style.display = "flex";
    if (deleteAccountBtn) deleteAccountBtn.style.display = "block";
    if (profileEmailTxt) profileEmailTxt.textContent = user.email || displayName;
    const authBadge = document.getElementById("profile-auth-badge");
    if (authBadge) authBadge.textContent = user.provider === "google" ? "✓ Google Connected" : "✓ Signed in with email";
  } else {
    if (label) label.textContent = "Sign In/Sign Up";
    if (icon) icon.textContent = "👤";
    if (headerBtn) headerBtn.classList.remove("logged-in");
    if (profileNameEl) profileNameEl.textContent = "Explorer";
    if (profileAvatar) {
      profileAvatar.style.backgroundImage = "url('assets/avatar_explorer.png')";
    }
    if (profileUnauthCard) profileUnauthCard.style.display = "flex";
    if (profileLoggedCard) profileLoggedCard.style.display = "none";
    if (deleteAccountBtn) deleteAccountBtn.style.display = "none";
  }
}

// Quoted CSS url() value that is safe for any image path or data URL
function cssUrl(src) {
  return 'url("' + String(src).replace(/["\\\n\r]/g, c => "\\" + c.charCodeAt(0).toString(16) + " ") + '")';
}

// --- EDIT PROFILE (name and profile picture) ---
let editProfileAvatarData = null;

function setEditProfileError(message) {
  const el = document.getElementById("edit-profile-error");
  if (!el) return;
  el.textContent = message || "";
  el.style.display = message ? "block" : "none";
}

function setEditProfileAvatarPreview(src) {
  const el = document.getElementById("edit-profile-avatar");
  if (el) el.style.backgroundImage = cssUrl(src || "assets/avatar_explorer.png");
}

function openEditProfile() {
  if (!currentUser) {
    openAuthModal();
    return;
  }
  editProfileAvatarData = null;
  setEditProfileError("");
  const nameInput = document.getElementById("edit-profile-name");
  if (nameInput) nameInput.value = currentUser.displayName || "";
  setEditProfileAvatarPreview(resolveImageUrl(currentUser.photoURL));
  const saveBtn = document.getElementById("edit-profile-save");
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
  const overlay = document.getElementById("edit-profile-overlay");
  if (overlay) overlay.classList.add("active");
}

function closeEditProfile() {
  const overlay = document.getElementById("edit-profile-overlay");
  if (overlay) overlay.classList.remove("active");
  editProfileAvatarData = null;
}

// Centre-crops an image to a square and downscales it to a small JPEG data URL
function cropImageToSquare(src, size = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const out = Math.min(size, side);
      const canvas = document.createElement("canvas");
      canvas.width = out;
      canvas.height = out;
      canvas.getContext("2d").drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, out, out
      );
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Could not read that image"));
    img.src = src;
  });
}

async function useAvatarImage(src) {
  try {
    editProfileAvatarData = await cropImageToSquare(src);
    setEditProfileAvatarPreview(editProfileAvatarData);
    setEditProfileError("");
  } catch (err) {
    setEditProfileError(err.message);
  }
}

async function pickAvatarPhoto() {
  const nativeCam = isCapacitorNative() ? Camera : null;
  if (!nativeCam) {
    const input = document.getElementById("edit-profile-file");
    if (input) {
      input.value = "";
      input.click();
    }
    return;
  }

  // Prompt lets the user pick camera or gallery; without camera permission, offer the gallery only
  let source = CameraSource.Prompt;
  if (typeof nativeCam.checkPermissions === "function") {
    try {
      const perm = await nativeCam.checkPermissions();
      if (perm && perm.camera !== "granted" && typeof nativeCam.requestPermissions === "function") {
        const req = await nativeCam.requestPermissions({ permissions: ["camera"] });
        if (req && req.camera !== "granted") source = CameraSource.Photos;
      }
    } catch (permErr) {
      console.warn("Camera checkPermissions error:", permErr);
    }
  }

  try {
    const photo = await nativeCam.getPhoto({
      resultType: CameraResultType.DataUrl,
      source,
      quality: 80,
      width: 512,
      height: 512,
      correctOrientation: true,
      allowEditing: false,
      saveToGallery: false
    });
    if (photo && photo.dataUrl) await useAvatarImage(photo.dataUrl);
  } catch (err) {
    const msg = (err && err.message) || "";
    if (!/cancel/i.test(msg)) setEditProfileError("Could not get photo: " + (msg || "unknown error"));
  }
}

function handleAvatarFileInput(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => useAvatarImage(reader.result);
  reader.onerror = () => setEditProfileError("Could not read that image");
  reader.readAsDataURL(file);
}

async function saveProfileEdits(event) {
  if (event) event.preventDefault();
  if (!currentUser) return false;

  const nameInput = document.getElementById("edit-profile-name");
  const name = (nameInput ? nameInput.value : "").replace(/\s+/g, " ").trim();
  if ([...name].length < 2 || [...name].length > 30) {
    setEditProfileError("Name must be 2 to 30 characters");
    return false;
  }

  const body = {};
  if (name !== currentUser.displayName) body.username = name;
  if (editProfileAvatarData) body.avatar = editProfileAvatarData;
  if (Object.keys(body).length === 0) {
    closeEditProfile();
    return false;
  }

  const saveBtn = document.getElementById("edit-profile-save");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }
  setEditProfileError("");

  try {
    const res = await apiFetch("/profile", { method: "PATCH", body: JSON.stringify(body) }, 20000);
    const data = await res.json().catch(() => null);
    if (res.status === 401) {
      closeEditProfile();
      showToast("Your session expired, please sign in again", "error");
      return false;
    }
    if (!res.ok || !data) {
      throw new Error((data && data.error) || "Server error " + res.status);
    }
    currentUser.displayName = data.username || currentUser.displayName;
    currentUser.photoURL = data.avatar || "";
    localStorage.setItem("plantgo_saved_user", JSON.stringify(currentUser));
    updateAuthUI(currentUser);
    applyUserStats(data);
    closeEditProfile();
    showToast("Profile updated");

    const feeds = await apiFetch("/feeds").then(r => r.ok ? r.json() : null).catch(() => null);
    if (Array.isArray(feeds)) {
      state.feeds = feeds;
      renderFeeds();
    }
  } catch (err) {
    console.warn("Profile update failed:", err);
    setEditProfileError(err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }
  return false;
}

// Export globally so both inline HTML and JS event listeners can call them seamlessly
window.openEditProfile = openEditProfile;
window.closeEditProfile = closeEditProfile;
window.pickAvatarPhoto = pickAvatarPhoto;
window.handleAvatarFileInput = handleAvatarFileInput;
window.saveProfileEdits = saveProfileEdits;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.toggleAuthMode = toggleAuthMode;
window.handleAuthSubmit = handleAuthSubmit;
window.handleAuthLogout = handleAuthLogout;
window.handleDeleteAccount = handleDeleteAccount;
window.initFirebaseAuth = initFirebaseAuth;

// Restore saved user only when a backend session exists (older versions stored users without one)
try {
  const saved = localStorage.getItem("plantgo_saved_user");
  if (saved && getSessionToken()) {
    currentUser = JSON.parse(saved);
    updateAuthUI(currentUser);
  } else if (saved) {
    localStorage.removeItem("plantgo_saved_user");
  }
} catch (e) { }

// Google Identity Services starts immediately; Firebase auth is initialised by initApp
initGoogleAuth();
