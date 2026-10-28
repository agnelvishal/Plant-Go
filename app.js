// Imports from Capacitor
const { Camera, CameraResultType, CameraSource, Geolocation, Permissions } = Capacitor.Plugins;

// --- STATE MANAGEMENT ---
const state = {
  activeTab: 'map',
  layout: 'glass-dock',
  theme: 'light-mint',
  mapFilter: 'all',
  selectedPlantId: null,
  photoData: null,
  map: null,
  userMarker: null,
  mapInitialized: false,
  locationWatcher: null,
};

// --- CORE UTILITY FUNCTIONS ---

function changeTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".app-screen").forEach(screen => {
    screen.classList.remove("active");
  });
  document.getElementById('screen-' + tabName).classList.add("active");

  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.remove("active");
    if (item.getAttribute("data-tab") === tabName) {
      item.classList.add("active");
    }
  });

  // Special handling for the Map and AI Identify tabs
  if (tabName === 'map' && !state.mapInitialized) {
    initMap();
  }
  if (tabName === 'ai-identify') {
    initCameraFlow();
  }
}

// --- PERMISSION AND DIALOG UTILITIES ---

function showPermissionDeniedDialog(permissionName, onGrant, onGallery) {
  const dialogHtml = 
    '<div id="permission-dialog" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; justify-content:center; align-items:center; z-index:9999;">' +
      '<div style="background:white; padding:20px; border-radius:10px; text-align:center; max-width: 300px; color: black;">' +
        '<h4 style="margin-bottom: 10px;">' + permissionName + ' Access Required</h4>' +
        '<p style="margin-bottom: 20px;">' + permissionName + ' access is needed to use this feature. Please grant permission or choose an alternative.</p>' +
        '<button id="btn-grant-again" class="btn-primary" style="width:100%; margin-bottom: 10px;">Grant Permission Again</button>' +
        '<button id="btn-open-settings" class="btn-secondary" style="width:100%; margin-bottom: 10px;">Open App Settings</button>' +
        (onGallery ? '<button id="btn-gallery-alt" class="btn-secondary" style="width:100%;">Choose From Gallery</button>' : '') +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', dialogHtml);
  
  document.getElementById('btn-grant-again').onclick = () => {
    document.getElementById('permission-dialog').remove();
    onGrant();
  };
  document.getElementById('btn-open-settings').onclick = () => {
    // Note: This is a placeholder for a native call to open settings, which is not available in web context
    alert("Opening app settings...");
    document.getElementById('permission-dialog').remove();
  };
  if (onGallery) {
    document.getElementById('btn-gallery-alt').onclick = () => {
      document.getElementById('permission-dialog').remove();
      onGallery();
    };
  }
}

// --- MAP IMPLEMENTATION (Leaflet) ---

function initMap() {
  if (state.mapInitialized) return;

  // 1. Request Location Permission
  checkAndRequestLocationPermission();
  
  // 2. Initialize Leaflet Map
  state.map = L.map('map', { zoomControl: false }).setView([20, 0], 2); // Default view
  
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(state.map);

  state.userMarker = L.circleMarker([0, 0], { 
      radius: 8, 
      color: '#2196f3', 
      fillColor: '#2196f3', 
      fillOpacity: 1 
  }).addTo(state.map);

  addMapControls();
  state.mapInitialized = true;
}

function addMapControls() {
  const mapContainer = document.querySelector('.map-canvas-container');
  
  // Recenter GPS Button (floating map action)
  const recenterBtn = document.createElement('button');
  recenterBtn.innerHTML = '📍';
  recenterBtn.className = 'map-fab-btn';
  recenterBtn.style.position = 'absolute';
  recenterBtn.style.bottom = '24px';
  recenterBtn.style.left = '12px';
  recenterBtn.style.zIndex = '1000';
  recenterBtn.onclick = () => {
      if (state.userMarker.getLatLng().lat !== 0 || state.userMarker.getLatLng().lng !== 0) {
          state.map.setView(state.userMarker.getLatLng(), 16);
      } else {
          alert("Location not yet determined. Please wait for GPS lock.");
      }
  };
  mapContainer.appendChild(recenterBtn);
  
  // Heatmap Toggle (floating map action)
  const heatmapBtn = document.createElement('button');
  heatmapBtn.innerHTML = '🔥';
  heatmapBtn.className = 'map-fab-btn';
  heatmapBtn.style.position = 'absolute';
  heatmapBtn.style.bottom = '76px';
  heatmapBtn.style.left = '12px';
  heatmapBtn.style.zIndex = '1000';
  heatmapBtn.onclick = () => {
      heatmapBtn.classList.toggle('active');
      alert("Heatmap layer toggled. (Not actually implemented yet)");
  };
  mapContainer.appendChild(heatmapBtn);

  // Note: Plant markers would be added here via L.marker()
}

async function checkAndRequestLocationPermission() {
  const permission = await Geolocation.checkPermissions();
  
  if (permission.location === 'granted') {
    startLocationWatch();
  } else {
    try {
      const result = await Geolocation.requestPermissions();
      if (result.location === 'granted') {
        startLocationWatch();
      } else {
        // Handle denied (but re-requestable)
        showPermissionDeniedDialog('Location', checkAndRequestLocationPermission);
      }
    } catch (e) {
        // Handle permanently denied / error
        showPermissionDeniedDialog('Location', checkAndRequestLocationPermission);
    }
  }
}

function startLocationWatch() {
  if (state.locationWatcher) return;
  
  state.locationWatcher = Geolocation.watchPosition({
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  }, (position, err) => {
    if (err) {
      console.error('Location Watch Error:', err);
      return;
    }
    
    const latLng = [position.coords.latitude, position.coords.longitude];
    
    // Update marker position
    state.userMarker.setLatLng(latLng);
    
    // Initial centering of the map
    if (state.map.getZoom() < 10) {
      state.map.setView(latLng, 16);
    }
  });
}

// --- NATIVE CAMERA & IDENTIFICATION FLOW ---

const cameraControls = document.getElementById('camera-controls-bottom');
const viewfinder = document.querySelector('.camera-viewfinder');

function renderCameraControls(mode) {
  cameraControls.innerHTML = '';
  viewfinder.style.backgroundImage = 'none';
  viewfinder.style.backgroundColor = '#111';

  if (mode === 'initial') {
    cameraControls.innerHTML = 
      '<div class="camera-initial-menu">' +
        '<button class="btn-secondary" id="btn-gallery">🖼 Choose from Gallery</button>' +
        '<button class="btn-primary" id="btn-camera">📸 Scan Plant</button>' +
      '</div>';
    document.getElementById('btn-camera').onclick = () => checkAndRequestCameraPermission();
    document.getElementById('btn-gallery').onclick = () => checkAndRequestGalleryPermission();

  } else if (mode === 'preview') {
    cameraControls.innerHTML = 
      '<div class="camera-preview-menu">' +
        '<button class="btn-secondary" id="btn-retake">🔄 Retake</button>' +
        '<button class="btn-primary" id="btn-use-photo">✅ Use Photo</button>' +
      '</div>';
    document.getElementById('btn-retake').onclick = () => checkAndRequestCameraPermission();
    document.getElementById('btn-use-photo').onclick = () => runIdentification(state.photoData);

  } else if (mode === 'analyzing') {
    cameraControls.innerHTML = 
      '<div class="camera-analyzing-overlay">' +
        '<h3>Analyzing Plant...</h3>' +
        '<p>This may take a few moments as we consult the database.</p>' +
        '<div class="loading-spinner"></div>' +
      '</div>';
  }
}

// Camera/Gallery permission flow
async function checkAndRequestCameraPermission() {
    const permission = await Permissions.query({ name: 'camera' });
    if (permission.state === 'granted') {
        takePhoto('camera');
    } else {
        try {
            const result = await Permissions.requestPermissions({ permissions: ['camera'] });
            if (result.camera === 'granted') {
                takePhoto('camera');
            } else {
                showPermissionDeniedDialog('Camera', checkAndRequestCameraPermission, checkAndRequestGalleryPermission);
            }
        } catch (e) {
            showPermissionDeniedDialog('Camera', checkAndRequestCameraPermission, checkAndRequestGalleryPermission);
        }
    }
}

async function checkAndRequestGalleryPermission() {
    // For older Android versions, we need read_media_images or similar.
    // For simplicity, we rely on the Camera.getPhoto(Source.Photos) which handles permissions internally on modern devices.
    // We can call takePhoto('photos') directly.
    takePhoto('photos');
}

async function takePhoto(source) {
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      quality: 90,
    });
    
    state.photoData = photo.webPath;
    viewfinder.style.backgroundImage = 'url(' + photo.webPath + ')';
    viewfinder.style.backgroundSize = 'cover';
    viewfinder.style.backgroundPosition = 'center';
    
    renderCameraControls('preview');

  } catch (e) {
    // Handle error when user closes the camera/gallery picker
    console.error("Camera/Gallery Error:", e);
    // If the error indicates a denial (not just closing the picker), show the custom dialog.
    if (e.message && (e.message.includes('permission') || e.message.includes('denied'))) {
        handleCameraError(e);
    } else {
        // User likely cancelled the operation
        renderCameraControls('initial');
    }
  }
}

function handleCameraError(e) {
    // This function can be expanded to check specific error types if needed, but for now we centralize the denial flow
    showPermissionDeniedDialog('Camera', checkAndRequestCameraPermission, checkAndRequestGalleryPermission);
}

function initCameraFlow() {
  renderCameraControls('initial');
}

// Mock service for plant identification
function runIdentification(photoPath) {
  renderCameraControls('analyzing');
  
  // Simulate network request and analysis time
  setTimeout(() => {
    // Mock result data
    const result = {
      commonName: "Sacred Banyan Tree",
      scientificName: "Ficus benghalensis",
      confidence: "98%",
      family: "Moraceae",
      description: "A large, fast-growing evergreen tree provides dense shade. Its aerial prop roots grow down into the soil, forming accessory trunks.",
      care: "Requires large space, full sun to partial shade, and moderate watering.",
      verified: true,
    };
    
    displayIdentificationResult(result);
  }, 2500);
}

function displayIdentificationResult(result) {
  const overlay = document.querySelector('.ai-results-overlay');
  
  // Update the confirmation question and details
  overlay.querySelector('h3').textContent = 'Identified: ' + result.commonName;
  overlay.querySelector('p').textContent = result.scientificName + ' - Confidence: ' + result.confidence;
  
  // Add verification step
  const detailsHtml = 
    '<div class="result-details" style="padding: 1rem 0; font-size: 0.9rem;">' +
      '<p><b>Family:</b> ' + result.family + '</p>' +
      '<p><b>Care:</b> ' + result.care + '</p>' +
      '<p><b>Description:</b> ' + result.description.substring(0, 80) + '...</p>' +
      '<p style="margin-top: 10px;">Is this the correct plant?</p>' +
    '</div>';
  
  overlay.querySelector('.ai-result-list').innerHTML = detailsHtml;

  // Repurpose the buttons for user verification
  overlay.querySelector('.confirm-action-row').innerHTML = 
    '<button class="btn-secondary" id="btn-retake-final">❌ No, identify again</button>' +
    '<button class="btn-primary" id="btn-confirm-final">✅ Yes, this is correct</button>';
  
  document.getElementById('btn-retake-final').onclick = () => changeTab('ai-identify');
  document.getElementById('btn-confirm-final').onclick = () => alert("Plant verified and submitted to your profile!");

  // Show the overlay
  overlay.classList.add('active');
}

// --- APP INITIALIZATION ---

function initApp() {
  // Navigation event listeners
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = item.getAttribute("data-tab");
      changeTab(tabName);
    });
  });

  // Initial tab setup: Map tab calls initMap, which handles permission flow
  changeTab('map');
}

document.addEventListener('DOMContentLoaded', initApp);