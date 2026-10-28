// PlantGo Core Application Logic
// Safe extraction from Capacitor if available in native runtime
const CapacitorPlugins = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins : {};
const Camera = CapacitorPlugins.Camera || null;
const CameraResultType = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.CameraResultType) ? window.Capacitor.CameraResultType : { Uri: 'uri' };
const CameraSource = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.CameraSource) ? window.Capacitor.CameraSource : { Camera: 'CAMERA', Photos: 'PHOTOS' };
const Geolocation = CapacitorPlugins.Geolocation || null;
const Permissions = CapacitorPlugins.Permissions || null;

// --- STATE MANAGEMENT ---
// --- MARIADB BACKEND API CONFIGURATION ---
const API_BASE = (function() {
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname || "127.0.0.1";
    const cleanHost = (host === "localhost" || host === "127.0.0.1") ? "127.0.0.1" : host;
    return "http://" + cleanHost + ":5001/api";
  }
  return "http://127.0.0.1:5001/api";
})();

async function syncFromBackend() {
  updateBackendStatusUI(false, "Connecting to MariaDB backend...", true);
  try {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutTimer = controller ? setTimeout(() => controller.abort(), 3500) : null;

    let healthRes = null;
    try {
      healthRes = await fetch(API_BASE + "/health", controller ? { signal: controller.signal } : {});
    } catch (e1) {
      const altUrl = API_BASE.includes("127.0.0.1") ? "http://localhost:5001/api/health" : "http://127.0.0.1:5001/api/health";
      healthRes = await fetch(altUrl, controller ? { signal: controller.signal } : {});
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    if (!healthRes || !healthRes.ok) throw new Error("Health check returned status " + (healthRes ? healthRes.status : "unknown"));
    
    state.backendConnected = true;
    updateBackendStatusUI(true, "MariaDB Active (Port 5001)");

    const [profileRes, feedsRes, radarRes, settingsRes] = await Promise.all([
      fetch(API_BASE + "/profile").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(API_BASE + "/feeds").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(API_BASE + "/radar").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(API_BASE + "/settings").then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    if (profileRes) {
      state.userStats = {
        discoveredCount: profileRes.discoveredCount,
        reviewedCount: profileRes.reviewedCount,
        totalPoints: profileRes.totalPoints,
        level: profileRes.level,
        xp: profileRes.xp,
        xpToNext: profileRes.xpToNext,
        milestoneAchieved: profileRes.milestoneAchieved
      };
      updateProfileUI();
    }

    if (feedsRes && Array.isArray(feedsRes)) {
      state.feeds = feedsRes;
      renderFeeds();
    }

    if (radarRes && Array.isArray(radarRes)) {
      state.radarPlants = radarRes;
      renderRadarList();
      if (state.mapInitialized) {
        renderMapPlantMarkers();
      }
    }

    if (settingsRes) {
      state.settings.publishAchievementsToFeed = settingsRes.publishAchievementsToFeed;
      state.settings.highAccuracyGps = settingsRes.highAccuracyGps;
      const pubEl = document.getElementById("setting-publish-achievements");
      if (pubEl) pubEl.checked = state.settings.publishAchievementsToFeed;
      const gpsEl = document.getElementById("setting-high-gps");
      if (gpsEl) gpsEl.checked = state.settings.highAccuracyGps;
    }

    console.log("🌿 MariaDB PlantGo data synced successfully!");
  } catch (err) {
    state.backendConnected = false;
    updateBackendStatusUI(false, "Offline mode (Could not reach MariaDB on port 5001)");
    console.warn("Backend unavailable, using local mock data:", err.message);
  }
}

function updateBackendStatusUI(connected, text, isChecking = false) {
  const badge = document.getElementById("backend-status-badge");
  const desc = document.getElementById("backend-status-desc");
  if (badge) {
    if (isChecking) {
      badge.textContent = "Checking...";
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
  mapInitialized: false,
  locationWatcher: null,
  mapMarkers: [],
  settings: {
    publishAchievementsToFeed: localStorage.getItem('plantgo_publish_feed') !== 'false', // Default true
    highAccuracyGps: true
  },
  userStats: {
    discoveredCount: 9, // Seeded at 9 to allow testing the 10th plant milestone immediately
    reviewedCount: 2,
    totalPoints: 4280,
    level: 14,
    xp: 2340,
    xpToNext: 5000,
    milestoneAchieved: false
  },
  feeds: [
    {
      id: 'feed-1',
      type: 'sighting',
      user: 'Aria_Botanica',
      avatar: 'assets/avatar_explorer.png',
      badgeText: 'Field Sighting',
      title: 'Sacred Banyan Tree (Ficus benghalensis)',
      subtitle: 'Near Central Botanical Grove • 1h ago',
      image: 'assets/plant_banyan.png',
      family: 'Moraceae',
      votes: 8,
      verified: true,
      status: 'Community Consensus'
    },
    {
      id: 'feed-2',
      type: 'achievement',
      user: 'LeafSeeker_99',
      avatar: 'assets/avatar_explorer.png',
      badgeText: 'Milestone',
      title: '🏆 Reached 10 Plants Identified!',
      subtitle: 'Milestone Achievement • 3h ago',
      description: 'LeafSeeker_99 just logged their 10th wild plant identification! Awarded the "Deca Botanist" trophy.',
      icon: '🏅',
      cheers: 14,
      cheered: false
    },
    {
      id: 'feed-3',
      type: 'sighting',
      user: 'FloraFinder_Sam',
      avatar: 'assets/avatar_explorer.png',
      badgeText: 'Needs Vouching',
      title: 'Aloe Vera (Aloe barbadensis miller)',
      subtitle: 'Highland Trail Waypoint • 5h ago',
      image: 'assets/plant_aloe.png',
      family: 'Asphodelaceae',
      votes: 3,
      verified: false,
      status: 'Needs 2 more reviews'
    }
  ],
  radarPlants: [
    {
      id: 'banyan-1',
      name: 'Sacred Banyan Tree',
      scientific: 'Ficus benghalensis',
      category: 'trees',
      dist: '120m away',
      image: 'assets/plant_banyan.png',
      lat: 20.003,
      lng: 0.002,
      rarity: 'Common Sacred',
      family: 'Moraceae',
      desc: 'Large evergreen tree with aerial prop roots forming massive natural canopy architecture.',
      sun: 'Full to Partial',
      water: 'Moderate',
      edible: 'Fruiting figs edible to wildlife',
      medicinal: 'Bark & latex traditionally utilized',
      flowering: 'Year-round',
      fruiting: 'May - July'
    },
    {
      id: 'aloe-1',
      name: 'Aloe Vera',
      scientific: 'Aloe barbadensis miller',
      category: 'medicinal',
      dist: '280m away',
      image: 'assets/plant_aloe.png',
      lat: 20.001,
      lng: -0.003,
      rarity: 'Medicinal Succulent',
      family: 'Asphodelaceae',
      desc: 'Stemless, thick fleshy leaves containing soothing soothing phytochemicals and polysaccharides.',
      sun: 'Direct Bright',
      water: 'Low / Drought Tolerant',
      edible: 'Gel consumed in health tonics',
      medicinal: 'Skin soothing, burn alleviation',
      flowering: 'Early Summer',
      fruiting: 'Late Summer'
    },
    {
      id: 'rose-1',
      name: 'Chinese Rose',
      scientific: 'Rosa chinensis',
      category: 'flowers',
      dist: '450m away',
      image: 'assets/plant_rose.png',
      lat: 19.997,
      lng: 0.001,
      rarity: 'Ornamental Shrub',
      family: 'Rosaceae',
      desc: 'Vibrant perennial garden rose cultivar renowned for recurring fragrant blooms.',
      sun: 'Full Sun',
      water: 'Regular',
      edible: 'Rose hips rich in Vitamin C',
      medicinal: 'Aromatherapy & rosewater extracts',
      flowering: 'Spring to Autumn',
      fruiting: 'Autumn'
    }
  ]
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
  if (tabName === 'map' && !state.mapInitialized) {
    initMap();
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
  }
}

// Toast notification helper
function showToast(message, duration = 3200) {
  const toast = document.getElementById('app-toast');
  if (!toast) return;
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

// --- MAP IMPLEMENTATION (Leaflet) ---

function initMap() {
  if (state.mapInitialized) return;

  // 1. Request Location Permission & Start GPS
  checkAndRequestLocationPermission();
  
  // 2. Initialize Leaflet Map
  state.map = L.map('map', { zoomControl: false }).setView([20.0, 0.0], 16);
  
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(state.map);

  state.userMarker = L.circleMarker([20.0, 0.0], { 
    radius: 9, 
    color: '#ffffff',
    weight: 3,
    fillColor: '#2196f3', 
    fillOpacity: 1 
  }).addTo(state.map);

  addMapControls();
  renderMapPlantMarkers();
  state.mapInitialized = true;
}

function addMapControls() {
  const mapContainer = document.querySelector('.map-canvas-container');
  
  // Recenter GPS Button
  const recenterBtn = document.createElement('button');
  recenterBtn.innerHTML = '📍';
  recenterBtn.className = 'map-fab-btn';
  recenterBtn.title = 'Recenter GPS';
  recenterBtn.style.position = 'absolute';
  recenterBtn.style.bottom = '24px';
  recenterBtn.style.left = '12px';
  recenterBtn.style.zIndex = '1000';
  recenterBtn.onclick = () => {
    if (state.userMarker) {
      state.map.setView(state.userMarker.getLatLng(), 16);
      showToast('📍 Recentered to your GPS coordinates');
    }
  };
  mapContainer.appendChild(recenterBtn);
  
  // Heatmap Toggle Button
  const heatmapBtn = document.createElement('button');
  heatmapBtn.innerHTML = '🔥';
  heatmapBtn.className = 'map-fab-btn';
  heatmapBtn.title = 'Density Heatmap';
  heatmapBtn.style.position = 'absolute';
  heatmapBtn.style.bottom = '76px';
  heatmapBtn.style.left = '12px';
  heatmapBtn.style.zIndex = '1000';
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
  if (!state.map) return;

  // Clear existing markers
  state.mapMarkers.forEach(m => state.map.removeLayer(m));
  state.mapMarkers = [];

  const plants = state.radarPlants.filter(p => {
    if (state.mapFilter === 'all') return true;
    return p.category === state.mapFilter;
  });

  plants.forEach(plant => {
    const customIcon = L.divIcon({
      className: 'custom-plant-pin',
      html: '<div style="background:var(--primary); color:white; border-radius:50%; width:34px; height:34px; display:flex; align-items:center; justify-content:center; box-shadow:0 3px 8px rgba(0,0,0,0.3); border:2px solid white; font-size:16px; cursor:pointer;">☘</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });

    const marker = L.marker([plant.lat, plant.lng], { icon: customIcon }).addTo(state.map);
    marker.on('click', () => {
      openSpecimenDetails(plant);
    });
    state.mapMarkers.push(marker);
  });
}

async function checkAndRequestLocationPermission() {
  if (!Geolocation) {
    // Web fallback for location
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const latLng = [pos.coords.latitude, pos.coords.longitude];
        if (state.userMarker) state.userMarker.setLatLng(latLng);
        if (state.map) state.map.setView(latLng, 16);
      }, (err) => console.log('Browser geolocation fallback notice:', err));
    }
    return;
  }

  try {
    const permission = await Geolocation.checkPermissions();
    if (permission.location === 'granted') {
      startLocationWatch();
    } else {
      const result = await Geolocation.requestPermissions();
      if (result.location === 'granted') {
        startLocationWatch();
      } else {
        showPermissionDeniedDialog('Location', checkAndRequestLocationPermission);
      }
    }
  } catch (e) {
    showPermissionDeniedDialog('Location', checkAndRequestLocationPermission);
  }
}

function startLocationWatch() {
  if (state.locationWatcher || !Geolocation) return;
  
  try {
    state.locationWatcher = Geolocation.watchPosition({
      enableHighAccuracy: state.settings.highAccuracyGps,
      timeout: 20000,
      maximumAge: 0
    }, (position, err) => {
      if (err) {
        console.error('Location Watch Error:', err);
        return;
      }
      if (position && position.coords) {
        const latLng = [position.coords.latitude, position.coords.longitude];
        if (state.userMarker) state.userMarker.setLatLng(latLng);
        if (state.map && state.map.getZoom() < 10) {
          state.map.setView(latLng, 16);
        }
      }
    });
  } catch (err) {
    console.warn('Geolocation watcher could not start:', err);
  }
}

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

async function openCaptureFlow() {
  changeTab("ai-identify");
  await startCameraCapture();
}

function closeCameraView() {
  stopLiveVideoStream();
  changeTab("map");
}

function stopLiveVideoStream() {
  if (liveMediaStream) {
    try {
      liveMediaStream.getTracks().forEach(track => track.stop());
    } catch (e) {}
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

  const viewfinder = document.querySelector(".camera-viewfinder");
  if (viewfinder) {
    viewfinder.style.backgroundImage = "none";
    viewfinder.style.backgroundColor = "#111";
  }

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
  const viewfinder = document.querySelector(".camera-viewfinder");
  if (!videoEl || !canvasEl) return;

  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

  const dataUrl = canvasEl.toDataURL("image/jpeg", 0.9);
  state.photoData = dataUrl;

  stopLiveVideoStream();

  if (viewfinder) {
    viewfinder.style.backgroundImage = "url(" + dataUrl + ")";
    viewfinder.style.backgroundSize = "cover";
    viewfinder.style.backgroundPosition = "center";
  }

  renderCameraControls("preview");
  showToast("Photo captured! Choose organ to identify 🌿", "success");
}

function triggerWebFileInput() {
  const fileInput = document.getElementById("web-file-input");
  const viewfinder = document.querySelector(".camera-viewfinder");
  if (fileInput) {
    fileInput.value = "";
    fileInput.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        state.photoData = event.target.result;
        stopLiveVideoStream();
        if (viewfinder) {
          viewfinder.style.backgroundImage = "url(" + state.photoData + ")";
          viewfinder.style.backgroundSize = "cover";
          viewfinder.style.backgroundPosition = "center";
        }
        renderCameraControls("preview");
      };
      reader.readAsDataURL(file);
    };
    fileInput.click();
  } else {
    simulatePhotoCapture("assets/plant_rose.png");
  }
}

function renderCameraControls(mode) {
  const cameraControls = document.getElementById("camera-controls-bottom");
  const viewfinder = document.querySelector(".camera-viewfinder");
  if (!cameraControls) return;
  cameraControls.innerHTML = "";

  if (mode === "live-stream") {
    cameraControls.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; gap:12px; width:100%; position:relative; z-index:10;">
        <div style="display:flex; justify-content:center; align-items:center; gap:20px; width:100%;">
          <button class="btn-secondary" id="btn-switch-gallery" style="flex:1; max-width:130px; padding:10px; font-size:0.8rem; border-radius:12px;">🖼 Upload</button>
          <button class="live-shutter-btn" id="btn-shutter" title="Take Photo">
            <div class="live-shutter-inner"></div>
          </button>
          <button class="btn-secondary" id="btn-demo-sample" style="flex:1; max-width:130px; padding:10px; font-size:0.8rem; border-radius:12px;">🌹 Sample</button>
        </div>
      </div>`;

    const shutterBtn = document.getElementById("btn-shutter");
    if (shutterBtn) shutterBtn.onclick = captureLiveVideoFrame;

    const galleryBtn = document.getElementById("btn-switch-gallery");
    if (galleryBtn) galleryBtn.onclick = triggerWebFileInput;

    const sampleBtn = document.getElementById("btn-demo-sample");
    if (sampleBtn) sampleBtn.onclick = () => simulatePhotoCapture("assets/plant_rose.png");

  } else if (mode === "initial") {
    if (viewfinder) {
      viewfinder.style.backgroundImage = "none";
      viewfinder.style.backgroundColor = "#111";
    }

    cameraControls.innerHTML = `
      <div class="camera-initial-menu" style="position:relative; z-index:10;">
        <div style="display:flex; gap:10px; width:100%; margin-bottom:10px;">
          <button class="btn-secondary" id="btn-gallery" style="flex:1;">🖼 Upload / Gallery</button>
          <button class="btn-primary" id="btn-camera" style="flex:1;">📸 Open Camera</button>
        </div>
        <div style="display:flex; align-items:center; justify-content:center; gap:8px; font-size:0.75rem; color:#aaa;">
          <span>Quick Demo:</span>
          <button class="sample-pill" data-sample="assets/plant_rose.png" style="background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.25); color:white; border-radius:12px; padding:3px 10px; cursor:pointer;">🌹 Rose</button>
          <button class="sample-pill" data-sample="assets/plant_aloe.png" style="background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.25); color:white; border-radius:12px; padding:3px 10px; cursor:pointer;">🪴 Aloe</button>
          <button class="sample-pill" data-sample="assets/plant_banyan.png" style="background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.25); color:white; border-radius:12px; padding:3px 10px; cursor:pointer;">🌳 Banyan</button>
        </div>
      </div>`;

    const camBtn = document.getElementById("btn-camera");
    if (camBtn) camBtn.onclick = () => startCameraCapture();

    const galBtn = document.getElementById("btn-gallery");
    if (galBtn) galBtn.onclick = () => checkAndRequestGalleryPermission();

    document.querySelectorAll(".sample-pill").forEach(pill => {
      pill.onclick = () => {
        simulatePhotoCapture(pill.getAttribute("data-sample"));
      };
    });

  } else if (mode === "preview") {
    state.selectedOrgan = state.selectedOrgan || "auto";

    cameraControls.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; gap:8px; width:100%; position:relative; z-index:10;">
        <div style="display:flex; align-items:center; gap:6px; font-size:0.75rem; color:var(--text-secondary);">
          <span>Botanical Organ:</span>
          <div class="organ-chips-row" style="display:flex; gap:4px;">
            <button class="organ-chip ${state.selectedOrgan === "auto" ? "active" : ""}" data-organ="auto" style="padding:3px 9px; font-size:0.75rem; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:${state.selectedOrgan === "auto" ? "var(--primary)" : "rgba(0,0,0,0.5)"}; color:white; cursor:pointer;">⚡ Auto</button>
            <button class="organ-chip ${state.selectedOrgan === "flower" ? "active" : ""}" data-organ="flower" style="padding:3px 9px; font-size:0.75rem; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:${state.selectedOrgan === "flower" ? "var(--primary)" : "rgba(0,0,0,0.5)"}; color:white; cursor:pointer;">🌸 Flower</button>
            <button class="organ-chip ${state.selectedOrgan === "leaf" ? "active" : ""}" data-organ="leaf" style="padding:3px 9px; font-size:0.75rem; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:${state.selectedOrgan === "leaf" ? "var(--primary)" : "rgba(0,0,0,0.5)"}; color:white; cursor:pointer;">🍃 Leaf</button>
            <button class="organ-chip ${state.selectedOrgan === "fruit" ? "active" : ""}" data-organ="fruit" style="padding:3px 9px; font-size:0.75rem; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:${state.selectedOrgan === "fruit" ? "var(--primary)" : "rgba(0,0,0,0.5)"}; color:white; cursor:pointer;">🍒 Fruit</button>
            <button class="organ-chip ${state.selectedOrgan === "bark" ? "active" : ""}" data-organ="bark" style="padding:3px 9px; font-size:0.75rem; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:${state.selectedOrgan === "bark" ? "var(--primary)" : "rgba(0,0,0,0.5)"}; color:white; cursor:pointer;">🪵 Bark</button>
          </div>
        </div>
        <div class="camera-preview-menu" style="display:flex; gap:10px; width:100%;">
          <button class="btn-secondary" id="btn-retake" style="flex:1;">🔄 Retake</button>
          <button class="btn-primary" id="btn-use-photo" style="flex:2;">🌿 Identify with Pl@ntNet</button>
        </div>
      </div>`;

    document.querySelectorAll(".organ-chip").forEach(chip => {
      chip.onclick = () => {
        state.selectedOrgan = chip.getAttribute("data-organ");
        renderCameraControls("preview");
      };
    });

    document.getElementById("btn-retake").onclick = () => startCameraCapture();
    document.getElementById("btn-use-photo").onclick = () => runIdentification(state.photoData, state.selectedOrgan);

  } else if (mode === "analyzing") {
    cameraControls.innerHTML = `
      <div class="camera-analyzing-overlay" style="text-align:center; padding:15px; position:relative; z-index:10;">
        <h3 style="color:var(--primary); margin-bottom:6px;">Consulting Pl@ntNet AI...</h3>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">Matching floral morphology, venation, and botanical taxonomy against 30,000+ species.</p>
        <div class="loading-spinner" style="margin:0 auto;"></div>
      </div>`;
  }
}

async function requestAndLaunchNativeCamera(source = "camera") {
  if (!Camera) {
    triggerWebFileInput();
    return;
  }

  try {
    // 1. Check and request permission on Capacitor Camera API
    if (typeof Camera.checkPermissions === 'function') {
      try {
        const perm = await Camera.checkPermissions();
        if (perm && perm.camera !== 'granted') {
          if (typeof Camera.requestPermissions === 'function') {
            const req = await Camera.requestPermissions({ permissions: ['camera', 'photos'] });
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
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: source === "photos" ? CameraSource.Photos : CameraSource.Camera,
      quality: 85,
      allowEditing: false,
      saveToGallery: false
    });

    if (photo && photo.dataUrl) {
      state.photoData = photo.dataUrl;
      stopLiveVideoStream();
      const viewfinder = document.querySelector(".camera-viewfinder");
      if (viewfinder) {
        viewfinder.style.backgroundImage = "url(" + photo.dataUrl + ")";
        viewfinder.style.backgroundSize = "cover";
        viewfinder.style.backgroundPosition = "center";
      }
      renderCameraControls("preview");
      showToast("Specimen photo captured! Select organ to identify 🌿", "success");
    }
  } catch (err) {
    console.warn("Native camera operation cancelled or error:", err);
    if (err && err.message && (err.message.includes("cancelled") || err.message.includes("User cancelled"))) {
      renderCameraControls("initial");
    } else {
      triggerWebFileInput();
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

function simulatePhotoCapture(imagePath) {
  state.photoData = imagePath;
  stopLiveVideoStream();
  const viewfinder = document.querySelector(".camera-viewfinder");
  if (viewfinder) {
    viewfinder.style.backgroundImage = "url(" + imagePath + ")";
    viewfinder.style.backgroundSize = "cover";
    viewfinder.style.backgroundPosition = "center";
  }
  renderCameraControls("preview");
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
  renderCameraControls("analyzing");
  
  try {
    let identificationResult = null;

    if (state.backendConnected) {
      const resp = await fetch(API_BASE + "/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: photoPath || "assets/plant_rose.png",
          organ: organ || "auto"
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          identificationResult = {
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
            verified: true,
            image: photoPath || "assets/plant_rose.png"
          };
        }
      }
    }

    if (!identificationResult) {
      // Offline fallback
      identificationResult = {
        commonName: "Tea rose",
        scientificName: "Rosa × odorata",
        confidence: "92.4%",
        confidenceScore: 0.924,
        family: "Rosaceae",
        detectedOrgan: organ !== "auto" ? organ : "flower",
        description: "Hardy perennial shrub with fragrant multi-petaled blooms.",
        care: "Requires 6+ hours of direct sunlight, well-draining soil, and consistent moisture.",
        sun: "Full Sun",
        water: "Moderate, damp soil",
        category: "flowers",
        candidates: [
          { scientificName: "Rosa × odorata", commonNames: ["Tea rose"], score: "92.4%", family: "Rosaceae" }
        ],
        verified: true,
        image: photoPath || "assets/plant_rose.png"
      };
    }

    displayIdentificationResult(identificationResult);
  } catch (err) {
    console.error("Pl@ntNet identification error:", err);
    displayIdentificationResult({
      commonName: "Field Specimen",
      scientificName: "Flora taxonomy",
      confidence: "85.0%",
      confidenceScore: 0.85,
      family: "Botanical",
      detectedOrgan: "leaf",
      description: "Specimen logged during field excursion.",
      care: "Ensure natural sunlight and ambient hydration.",
      category: "flowers",
      verified: true,
      image: photoPath || "assets/plant_banyan.png"
    });
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
              (c.commonNames?.[0] || c.scientificName) + ' (' + c.score + ')' +
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
      '<p style="margin-bottom:4px;"><b>Family:</b> ' + result.family + (result.detectedOrgan ? ' • <b>Organ:</b> ' + result.detectedOrgan : '') + '</p>' +
      (result.sun ? '<p style="margin-bottom:4px;"><b>Sunlight:</b> ' + result.sun + '</p>' : '') +
      (result.water ? '<p style="margin-bottom:4px;"><b>Water:</b> ' + result.water + '</p>' : '') +
      '<p style="margin-bottom:4px;"><b>Care:</b> ' + result.care + '</p>' +
      '<p><b>Notes:</b> ' + result.description + '</p>' +
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
  // If backend is connected, persist to MariaDB
  if (state.backendConnected) {
    try {
      const resp = await fetch(API_BASE + "/feeds/sighting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commonName: result.commonName,
          scientificName: result.scientificName,
          confidence: result.confidence,
          family: result.family,
          description: result.description,
          image: result.image,
          category: result.category || "flowers"
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        state.userStats.discoveredCount = data.userStats.discoveredCount;
        state.userStats.xp = data.userStats.xp;
        state.userStats.totalPoints = data.userStats.totalPoints;
        state.userStats.milestoneAchieved = data.userStats.milestoneAchieved;
        updateProfileUI();

        state.feeds.unshift(data.sighting);
        if (data.achievement) {
          state.feeds.unshift(data.achievement);
        }
        renderFeeds();

        if (data.milestoneTriggered) {
          showToast("🏆 Milestone Reached: 10 Plants Identified! Saved to MariaDB & published to Feed.", 4500);
        } else {
          showToast("☘ Plant logged to MariaDB! +250 XP earned. Total discovered: " + state.userStats.discoveredCount);
        }
        changeTab("feeds");
        return;
      }
    } catch (err) {
      console.warn("Failed to persist sighting to MariaDB, falling back to local:", err);
    }
  }

  // Local fallback
  state.userStats.discoveredCount += 1;
  state.userStats.xp += 250;
  state.userStats.totalPoints += 250;
  updateProfileUI();

  const newSighting = {
    id: "sighting-" + Date.now(),
    type: "sighting",
    user: "Explorer_Forest_9 (You)",
    avatar: "assets/avatar_explorer.png",
    badgeText: "New Discovery",
    title: result.commonName + " (" + result.scientificName + ")",
    subtitle: "Identified nearby • Just now",
    image: result.image,
    family: result.family,
    votes: 1,
    verified: false,
    status: "Awaiting Community Consensus"
  };
  state.feeds.unshift(newSighting);

  if (state.userStats.discoveredCount === 10) {
    triggerMilestoneAchievement(10);
  } else {
    showToast("☘ Plant logged! +250 XP earned. Total discovered: " + state.userStats.discoveredCount);
  }

  changeTab("feeds");
}

// Milestone Achievement Trigger
function triggerMilestoneAchievement(milestoneCount) {
  state.userStats.milestoneAchieved = true;
  updateProfileUI();

  // Check user privacy setting: "Publish achievements to feed"
  if (state.settings.publishAchievementsToFeed) {
    const milestonePost = {
      id: 'achievement-' + Date.now(),
      type: 'achievement',
      user: 'Explorer_Forest_9 (You)',
      avatar: 'assets/avatar_explorer.png',
      badgeText: 'Milestone',
      title: '🏆 Reached ' + milestoneCount + ' Plants Identified!',
      subtitle: 'Milestone Achievement • Just now',
      description: 'Explorer_Forest_9 just reached the major milestone of identifying ' + milestoneCount + ' distinct plant specimens in the wild! Unlocked the "Deca Botanist" achievement badge.',
      icon: '🏆',
      cheers: 1,
      cheered: false,
      isUser: true
    };
    
    // Insert milestone at the very top of the feed
    state.feeds.unshift(milestonePost);
    renderFeeds();

    showToast('🏆 Milestone Reached: 10 Plants Identified! Achievement published to Community Feed.', 4500);
  } else {
    showToast('🏆 Milestone Reached: 10 Plants Identified! (Not published to feed — disabled in Settings)', 4500);
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
    container.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-secondary);">No feed items found.</div>';
    return;
  }

  container.innerHTML = filteredFeeds.map(item => {
    if (item.type === 'achievement') {
      return `
        <div class="feed-achievement-card" data-id="${item.id}">
          <div class="feed-achievement-header">
            <div class="feed-achievement-user">
              <div class="feed-achievement-avatar" style="background-image: url('${item.avatar}')"></div>
              <span>${item.user}</span>
            </div>
            <span>${item.badgeText}</span>
          </div>
          <div class="feed-achievement-body">
            <div class="feed-achievement-badge-icon">${item.icon}</div>
            <div class="feed-achievement-details">
              <div class="feed-achievement-title">${item.title}</div>
              <div class="feed-achievement-desc">${item.description}</div>
            </div>
          </div>
          <div class="feed-achievement-footer">
            <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 500;">${item.subtitle}</span>
            <span class="milestone-badge-pill">Verified Milestone 🌟</span>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="verification-card" data-id="${item.id}">
          <div class="verification-header">
            <span>${item.badgeText} • ${item.user}</span>
          </div>
          <div class="verification-image" style="background-image: url('${item.image}')"></div>
          <div class="verification-content">
            <div class="verification-title">${item.title}</div>
            <div class="verification-meta">${item.subtitle}</div>

            <div class="verification-meta-stats">
              <span>Status: ${item.status}</span>
              <span>${item.votes} community vouches</span>
            </div>
          </div>
        </div>
      `;
    }
  }).join('');
}

window.toggleCheer = async function(feedId) {
  const item = state.feeds.find(f => f.id === feedId);
  if (!item) return;

  if (state.backendConnected) {
    try {
      const resp = await fetch(API_BASE + "/feeds/" + feedId + "/cheer", { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        item.cheers = data.cheers;
        item.cheered = data.cheered;
        renderFeeds();
        if (item.cheered) showToast("👏 Cheered on this achievement (Saved to MariaDB)!");
        return;
      }
    } catch (err) {
      console.warn("Cheer API error, using local fallback:", err);
    }
  }

  if (!item.cheered) {
    item.cheers += 1;
    item.cheered = true;
    showToast("👏 Cheered on this achievement!");
  } else {
    item.cheers -= 1;
    item.cheered = false;
  }
  renderFeeds();
};

window.vouchSighting = async function(feedId) {
  const item = state.feeds.find(f => f.id === feedId);
  if (!item) return;

  if (state.backendConnected) {
    try {
      const resp = await fetch(API_BASE + "/feeds/" + feedId + "/vote", { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        item.votes = data.feed.votes;
        state.userStats.reviewedCount = data.userStats.reviewedCount;
        state.userStats.xp = data.userStats.xp;
        state.userStats.totalPoints = data.userStats.totalPoints;
        updateProfileUI();
        renderFeeds();
        showToast("✓ Vouched identification in MariaDB! +50 XP awarded.");
        return;
      }
    } catch (err) {
      console.warn("Vouch API error, using local fallback:", err);
    }
  }

  item.votes += 1;
  state.userStats.reviewedCount += 1;
  state.userStats.xp += 50;
  state.userStats.totalPoints += 50;
  updateProfileUI();
  showToast("✓ Vouched identification! +50 XP awarded.");
  renderFeeds();
};

// --- RADAR IMPLEMENTATION ---

function renderRadarList() {
  const listContainer = document.querySelector('.radar-list');
  if (!listContainer) return;

  listContainer.innerHTML = state.radarPlants.map(plant => `
    <div class="stat-box" style="display:flex; align-items:center; gap:12px; padding:10px 14px; margin-bottom:8px; cursor:pointer;" onclick="openSpecimenDetailsById('${plant.id}')">
      <div style="width:44px; height:44px; border-radius:8px; background-image:url('${plant.image}'); background-size:cover; background-position:center; flex-shrink:0;"></div>
      <div style="flex:1; text-align:left;">
        <div style="font-size:0.88rem; font-weight:700; color:var(--text-primary);">${plant.name}</div>
        <div style="font-size:0.75rem; color:var(--text-secondary);">${plant.scientific}</div>
      </div>
      <div style="text-align:right;">
        <span class="milestone-badge-pill" style="font-size:0.7rem;">${plant.dist}</span>
      </div>
    </div>
  `).join('');
}

// --- SPECIMEN DETAILS DRAWER ---

window.openSpecimenDetailsById = function(plantId) {
  const plant = state.radarPlants.find(p => p.id === plantId);
  if (plant) openSpecimenDetails(plant);
};

function openSpecimenDetails(plant) {
  const sheet = document.querySelector('.detail-bottom-sheet');
  if (!sheet) return;

  sheet.querySelector('.detail-common-name').textContent = plant.name;
  sheet.querySelector('.detail-scientific-name').textContent = plant.scientific;
  
  const headerGrad = sheet.querySelector('.detail-image-grad');
  if (headerGrad) {
    headerGrad.style.backgroundImage = 'linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.85)), url(' + plant.image + ')';
    headerGrad.style.backgroundSize = 'cover';
    headerGrad.style.backgroundPosition = 'center';
  }

  // Populate pills
  const pillContainer = document.getElementById('detail-pill-container');
  if (pillContainer) {
    pillContainer.innerHTML = `
      <span class="detail-pill">${plant.rarity || 'Wild Flora'}</span>
      <span class="detail-pill">${plant.family || 'Botanical'}</span>
      <span class="detail-pill">${plant.category || 'General'}</span>
    `;
  }

  document.getElementById('detail-edible').textContent = plant.edible || 'Non-edible';
  document.getElementById('detail-medicinal').textContent = plant.medicinal || 'None';
  document.getElementById('detail-desc').textContent = plant.desc || 'Specimen documented by community botanists.';
  document.getElementById('detail-sun').textContent = plant.sun || 'Moderate';
  document.getElementById('detail-water').textContent = plant.water || 'Regular';
  document.getElementById('detail-region').textContent = 'Subtropical / Urban';
  document.getElementById('detail-flowering').textContent = plant.flowering || 'Spring';
  document.getElementById('detail-fruiting').textContent = plant.fruiting || 'Autumn';

  sheet.classList.add('active');
}

function closeSpecimenDetails() {
  const sheet = document.querySelector('.detail-bottom-sheet');
  if (sheet) sheet.classList.remove('active');
}

// --- PROFILE & SETTINGS UI SYNC ---

function updateProfileUI() {
  const discCount = document.getElementById('profile-discovered-count');
  const revCount = document.getElementById('profile-verified-count');
  const milestoneBadge = document.getElementById('milestone-status-badge');
  const milestoneFill = document.getElementById('milestone-bar-fill');
  const milestoneSubtext = document.getElementById('milestone-subtext');
  
  if (discCount) discCount.textContent = state.userStats.discoveredCount;
  if (revCount) revCount.textContent = state.userStats.reviewedCount;

  // Milestone Progress
  const count = state.userStats.discoveredCount;
  const progressPercent = Math.min(100, Math.round((count / 10) * 100));
  
  if (milestoneBadge) {
    milestoneBadge.textContent = count >= 10 ? 'Completed 🎉' : count + ' / 10';
  }
  if (milestoneFill) {
    milestoneFill.style.width = progressPercent + '%';
  }
  if (milestoneSubtext) {
    if (count >= 10) {
      milestoneSubtext.textContent = 'Milestone achieved! 10 plants identified in the field.';
    } else {
      const remaining = 10 - count;
      milestoneSubtext.textContent = remaining + ' more ' + (remaining === 1 ? 'discovery' : 'discoveries') + ' to reach milestone!';
    }
  }

  // Update top bar score badge
  const scoreBadges = document.querySelectorAll('.xp-indicator');
  scoreBadges.forEach(badge => {
    badge.textContent = state.userStats.xp + ' / ' + state.userStats.xpToNext + ' XP';
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

  // MariaDB Manual Reconnect Button
  const reconnectDbBtn = document.getElementById("btn-reconnect-db");
  if (reconnectDbBtn) {
    reconnectDbBtn.onclick = async () => {
      reconnectDbBtn.textContent = "Syncing...";
      await syncFromBackend();
      reconnectDbBtn.textContent = "Sync DB";
      showToast(state.backendConnected ? "✓ Connected to MariaDB!" : "✕ Could not reach MariaDB on port 5001");
    };
  }

  // Detail sheet vote button
  const sheetVoteBtn = document.getElementById('detail-vote-action-btn');
  if (sheetVoteBtn) {
    sheetVoteBtn.onclick = () => {
      state.userStats.reviewedCount += 1;
      state.userStats.xp += 50;
      updateProfileUI();
      showToast('✓ Specimen identification vouched! +50 XP');
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
      if (state.backendConnected) {
        try {
          await fetch(API_BASE + "/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
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

  // Quick Discover Button on Profile Screen
  const quickDiscoverBtn = document.getElementById('btn-quick-discover');
  if (quickDiscoverBtn) {
    quickDiscoverBtn.addEventListener('click', () => {
      handlePlantSubmission({
        commonName: "Chinese Rose",
        scientificName: "Rosa chinensis",
        confidence: "99.1%",
        family: "Rosaceae",
        description: "Vibrant flower specimen observed in local botanical habitat.",
        care: "Full sun and fertile soil.",
        verified: true,
        image: 'assets/plant_rose.png'
      });
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
  apiKey: "REDACTED",
  authDomain: "REDACTED",
  projectId: "REDACTED",
  storageBucket: "REDACTED",
  appId: "REDACTED"
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
        currentUser = user;
        updateAuthUI(user);
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
    if (subEl) subEl.textContent = 'Connected with Firebase Authentication';
  } else {
    if (authForm) authForm.style.display = 'flex';
    if (loggedInView) loggedInView.style.display = 'none';
    updateAuthModalMode();
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

async function handleAuthLogout() {
  try {
    if (fbAuth) {
      await fbAuth.signOut();
      showToast('Signed out of PlantGo', 'info');
      closeAuthModal();
    }
  } catch (err) {
    console.error("Sign out error:", err);
  }
}

function updateAuthUI(user) {
  const label = document.getElementById('header-auth-label');
  const icon = document.getElementById('header-auth-icon');
  const headerBtn = document.getElementById('header-auth-btn');
  const profileNameEl = document.querySelector('.profile-name');

  if (user) {
    const username = (user.email ? user.email.split('@')[0] : 'Explorer');
    if (label) label.textContent = username;
    if (icon) icon.textContent = '🌿';
    if (headerBtn) headerBtn.classList.add('logged-in');
    if (profileNameEl) profileNameEl.textContent = username;
  } else {
    if (label) label.textContent = 'Sign In';
    if (icon) icon.textContent = '👤';
    if (headerBtn) headerBtn.classList.remove('logged-in');
    if (profileNameEl) profileNameEl.textContent = 'Explorer_Forest_9';
  }
}

// Export globally so both inline HTML and JS event listeners can call them seamlessly
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.toggleAuthMode = toggleAuthMode;
window.handleAuthSubmit = handleAuthSubmit;
window.handleAuthLogout = handleAuthLogout;
window.initFirebaseAuth = initFirebaseAuth;

// Initialize Firebase immediately on script evaluation
initFirebaseAuth();
