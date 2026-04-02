const DEFAULT_CONFIG = {
  signalingHost: 'sharevia-signal.onrender.com',
  signalingPort: '443',
  signalingPath: '/peerjs',
  signalingSecure: true,
  iceStunUrl: 'stun:stun.l.google.com:19302',
  iceTurnUrls: '',
  iceTurnUsername: '',
  iceTurnCredential: '',
  chunkSize: 65536,
  ackEvery: 32,
};

const STORAGE_KEY = 'sharevia_config_v1';
const HISTORY_STORAGE_KEY = 'sharevia_transfer_history_v1';
const CHANNEL_BUFFER_LIMIT = 2 * 1024 * 1024;
const CONNECTION_TIMEOUT = 15000;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;
const MAX_HISTORY_ENTRIES = 300;
const MAX_RECEIVED_ARCHIVE_ITEMS = 300;

const state = {
  peer: null,
  conn: null,
  myId: '',
  pendingJoinId: null,
  html5QrCode: null,
  isResetting: false,
  config: loadConfig(),
  incomingTransfers: new Map(),
  outgoingTransfers: new Map(),
  scannerActive: false,
  connectionTimer: null,
  reconnectAttempts: 0,
  wasHosting: false,
  lastRoomId: null,
  dashboardMode: 'idle',
  radarActive: false,
  radarScanStartedAt: 0,
  nearbyDevices: new Map(),
  nativeCapabilities: null,
  transferHistory: loadTransferHistory(),
  historyFilter: 'all',
  receivedArchiveItems: [],
};

const elements = {
  setupSection: document.getElementById('setup-section'),
  hostingSection: document.getElementById('hosting-section'),
  shareSection: document.getElementById('share-section'),
  btnDashboardSend: document.getElementById('btn-dashboard-send'),
  btnDashboardReceive: document.getElementById('btn-dashboard-receive'),
  radarPanel: document.getElementById('radar-panel'),
  radarPulse: document.getElementById('radar-pulse'),
  radarStatus: document.getElementById('radar-status'),
  nearbyDeviceList: document.getElementById('nearby-device-list'),
  statusBadge: document.getElementById('status-badge'),
  transportBadge: document.getElementById('transport-badge'),
  myPeerId: document.getElementById('my-peer-id'),
  remotePeerId: document.getElementById('remote-peer-id'),
  joinIdInput: document.getElementById('join-id'),
  qrcodeContainer: document.getElementById('qrcode-container'),
  transferList: document.getElementById('transfer-list'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  btnSaveAll: document.getElementById('btn-save-all'),
  historyList: document.getElementById('history-list'),
  historyTabs: Array.from(document.querySelectorAll('[data-history-tab]')),
  btnPickFiles: document.getElementById('btn-pick-files'),
  btnPickFolder: document.getElementById('btn-pick-folder'),
  noteInbox: document.getElementById('note-inbox'),
  textNote: document.getElementById('text-note'),
  activityLog: document.getElementById('activity-log'),
  scannerModal: document.getElementById('scanner-modal'),
  advancedPanel: document.getElementById('advanced-panel'),
  signalHost: document.getElementById('signal-host'),
  signalPort: document.getElementById('signal-port'),
  signalPath: document.getElementById('signal-path'),
  signalSecure: document.getElementById('signal-secure'),
  iceStunUrl: document.getElementById('ice-stun-url'),
  iceTurnUrls: document.getElementById('ice-turn-urls'),
  iceTurnUsername: document.getElementById('ice-turn-username'),
  iceTurnCredential: document.getElementById('ice-turn-credential'),
  chunkSize: document.getElementById('chunk-size'),
  ackEvery: document.getElementById('ack-every'),
  technicalCapabilities: document.getElementById('technical-capabilities'),
  capabilityNote: document.getElementById('capability-note'),
  capabilityGrid: document.getElementById('capability-grid'),
  nativeActions: document.getElementById('native-actions'),
  btnNativeWifi: document.getElementById('btn-native-wifi'),
  btnNativeBluetooth: document.getElementById('btn-native-bluetooth'),
  btnNativeNfc: document.getElementById('btn-native-nfc'),
  btnNativeLocation: document.getElementById('btn-native-location'),
  formSettings: document.getElementById('form-settings'),
  capWebrtc: document.getElementById('cap-webrtc'),
  capWifi: document.getElementById('cap-wifi'),
  capBluetooth: document.getElementById('cap-bluetooth'),
  capNfc: document.getElementById('cap-nfc'),
  capLocation: document.getElementById('cap-location'),
  capNative: document.getElementById('cap-native'),
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      iceStunUrl: String(parsed.iceStunUrl || DEFAULT_CONFIG.iceStunUrl).trim(),
      iceTurnUrls: String(parsed.iceTurnUrls || DEFAULT_CONFIG.iceTurnUrls).trim(),
      iceTurnUsername: String(parsed.iceTurnUsername || DEFAULT_CONFIG.iceTurnUsername).trim(),
      iceTurnCredential: String(parsed.iceTurnCredential || DEFAULT_CONFIG.iceTurnCredential),
      chunkSize: Number(parsed.chunkSize || DEFAULT_CONFIG.chunkSize),
      ackEvery: Number(parsed.ackEvery || DEFAULT_CONFIG.ackEvery),
    };
  } catch (error) {
    console.warn('Config load failed:', error);
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

function loadTransferHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || createTransferId()),
        direction: item.direction === 'received' ? 'received' : 'sent',
        name: String(item.name || 'Unknown file'),
        size: Number(item.size || 0),
        status: String(item.status || 'Completed'),
        timestamp: Number(item.timestamp || Date.now()),
      }))
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch (error) {
    console.warn('History load failed:', error);
    return [];
  }
}

function persistTransferHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.transferHistory.slice(0, MAX_HISTORY_ENTRIES)));
  } catch (error) {
    console.warn('History persist failed:', error);
  }
}

function formatClockTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatHistoryTimestamp(ts) {
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${formatClockTime(date)}`;
}

function formatFileTimestamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeArchivePath(path, fallbackName) {
  const raw = String(path || fallbackName || '').trim().replace(/\\/g, '/');
  const clean = raw.replace(/^\/+/, '').replace(/\.\.(\/|\\)/g, '').trim();
  return clean || String(fallbackName || 'file.bin').trim() || 'file.bin';
}

function addTransferHistoryEntry(entry) {
  const normalized = {
    id: createTransferId(),
    direction: entry.direction === 'received' ? 'received' : 'sent',
    name: String(entry.name || 'Unknown file'),
    size: Number(entry.size || 0),
    status: String(entry.status || 'Completed'),
    timestamp: Number(entry.timestamp || Date.now()),
  };

  state.transferHistory.unshift(normalized);
  if (state.transferHistory.length > MAX_HISTORY_ENTRIES) {
    state.transferHistory.length = MAX_HISTORY_ENTRIES;
  }
  persistTransferHistory();
  renderTransferHistory();
}

function setHistoryFilter(tab) {
  const next = ['all', 'received', 'sent'].includes(tab) ? tab : 'all';
  state.historyFilter = next;
  elements.historyTabs.forEach((button) => {
    button.classList.toggle('active', button.dataset.historyTab === next);
  });
  renderTransferHistory();
}

function renderTransferHistory() {
  if (!elements.historyList) return;

  const filtered = state.transferHistory.filter((item) => {
    if (state.historyFilter === 'all') return true;
    return item.direction === state.historyFilter;
  });

  elements.historyList.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No transfers yet.';
    elements.historyList.appendChild(empty);
    return;
  }

  filtered.forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'history-item';

    const row = document.createElement('div');
    row.className = 'history-row';

    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = entry.name;

    const type = document.createElement('span');
    type.className = 'history-type';
    type.textContent = entry.direction === 'received' ? 'Received' : 'Sent';

    row.appendChild(name);
    row.appendChild(type);

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = `${formatBytes(entry.size)} • ${entry.status} • ${formatHistoryTimestamp(entry.timestamp)}`;

    item.appendChild(row);
    item.appendChild(meta);
    elements.historyList.appendChild(item);
  });
}

function applyConfigToUI() {
  elements.signalHost.value = state.config.signalingHost;
  elements.signalPort.value = state.config.signalingPort;
  elements.signalPath.value = state.config.signalingPath;
  elements.signalSecure.checked = Boolean(state.config.signalingSecure);
  elements.iceStunUrl.value = state.config.iceStunUrl;
  elements.iceTurnUrls.value = state.config.iceTurnUrls;
  elements.iceTurnUsername.value = state.config.iceTurnUsername;
  elements.iceTurnCredential.value = state.config.iceTurnCredential;
  elements.chunkSize.value = String(state.config.chunkSize);
  elements.ackEvery.value = String(state.config.ackEvery);
}

function readConfigFromUI() {
  const pathRaw = (elements.signalPath.value || '/peerjs').trim();
  state.config.signalingHost = elements.signalHost.value.trim();
  state.config.signalingPort = elements.signalPort.value.trim();
  state.config.signalingPath = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
  state.config.signalingSecure = elements.signalSecure.checked;
  state.config.iceStunUrl = elements.iceStunUrl.value.trim();
  state.config.iceTurnUrls = elements.iceTurnUrls.value.trim();
  state.config.iceTurnUsername = elements.iceTurnUsername.value.trim();
  state.config.iceTurnCredential = elements.iceTurnCredential.value;
  state.config.chunkSize = Number(elements.chunkSize.value);
  state.config.ackEvery = Number(elements.ackEvery.value);
}

function buildPeerOptions() {
  const options = { debug: 1 };

  if (state.config.signalingHost) {
    options.host = state.config.signalingHost;
    options.port = Number(state.config.signalingPort || (state.config.signalingSecure ? 443 : 80));
    options.path = state.config.signalingPath;
    options.secure = Boolean(state.config.signalingSecure);
  }

  const iceConfig = buildIceConfig();
  if (iceConfig) {
    options.config = iceConfig;
  }

  return options;
}

function parseCsvList(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildIceConfig() {
  const iceServers = [];
  const stunUrl = String(state.config.iceStunUrl || '').trim();
  const turnUrls = parseCsvList(state.config.iceTurnUrls);

  if (stunUrl) {
    iceServers.push({ urls: stunUrl });
  }

  if (turnUrls.length > 0) {
    const turnServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
    if (state.config.iceTurnUsername) {
      turnServer.username = state.config.iceTurnUsername;
    }
    if (state.config.iceTurnCredential) {
      turnServer.credential = state.config.iceTurnCredential;
    }
    iceServers.push(turnServer);
  }

  return iceServers.length ? { iceServers } : null;
}

function updateTransportBadge() {
  const isCustomHost = Boolean(state.config.signalingHost);
  elements.transportBadge.textContent = isCustomHost ? 'LAN Signaling' : 'Cloud Signaling';
}

function updateStatus(text, className) {
  elements.statusBadge.textContent = text;
  elements.statusBadge.className = `status-badge ${className}`;
}

function showSection(section) {
  [elements.setupSection, elements.hostingSection, elements.shareSection].forEach((candidate) => {
    candidate.classList.add('hidden');
    candidate.classList.remove('active');
  });

  section.classList.remove('hidden');
  section.classList.add('active');
}

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function logActivity(message, source = 'System') {
  const line = document.createElement('li');
  const prefix = document.createElement('span');
  prefix.textContent = `${source} ${nowLabel()}`;
  line.appendChild(prefix);
  line.append(` ${message}`);
  elements.activityLog.prepend(line);

  while (elements.activityLog.children.length > 120) {
    elements.activityLog.removeChild(elements.activityLog.lastChild);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatThroughput(transferredBytes, startTs) {
  const elapsedSec = Math.max((performance.now() - startTs) / 1000, 0.05);
  const perSec = transferredBytes / elapsedSec;
  return `${formatBytes(perSec)}/s`;
}

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateJoinUrl(roomId) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#${roomId}`;
}

function createTransferId() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasNativeBridge() {
  return Boolean(
    window.NativeP2PBridge ||
      (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.NativeP2PBridge) ||
      (window.chrome && window.chrome.webview),
  );
}

function setCapabilityChip(element, label, supported, detail) {
  if (!element) return;
  element.classList.remove('supported', 'unavailable');
  element.classList.add(supported ? 'supported' : 'unavailable');
  element.textContent = `${label}: ${detail}`;
}

function setElementHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle('hidden', hidden);
}

function detectCapabilities() {
  const nativeMode = hasNativeBridge();
  const webrtcSupported = Boolean(window.RTCPeerConnection);

  setCapabilityChip(elements.capWebrtc, 'WebRTC', webrtcSupported, webrtcSupported ? 'supported' : 'missing');
  setCapabilityChip(elements.capWifi, 'Wi-Fi', nativeMode, nativeMode ? 'native app available' : 'native app required');
  setCapabilityChip(elements.capBluetooth, 'Bluetooth', nativeMode, nativeMode ? 'native app available' : 'native app required');
  setCapabilityChip(elements.capNfc, 'NFC', nativeMode, nativeMode ? 'native app available' : 'native app required');
  setCapabilityChip(elements.capLocation, 'Location', nativeMode, nativeMode ? 'native app available' : 'native app required');
  setCapabilityChip(elements.capNative, 'Native Bridge', nativeMode, nativeMode ? 'app mode' : 'web mode');

  if (elements.capabilityNote) {
    elements.capabilityNote.textContent = nativeMode
      ? 'Native app mode detected. Pairing helpers and hardware permissions are enabled here.'
      : 'Browser mode detected. Use the Android app for Bluetooth/NFC pairing, background transfers, and OS-level permissions.';
  }

  // Keep technical feature chips hidden in production UI.
  setElementHidden(elements.technicalCapabilities, true);

  if (!nativeMode) {
    setElementHidden(elements.btnNativeWifi, true);
    setElementHidden(elements.btnNativeBluetooth, true);
    setElementHidden(elements.btnNativeLocation, true);
    setElementHidden(elements.btnNativeNfc, !Boolean(window.NDEFReader));
    return;
  }

  setElementHidden(elements.btnNativeWifi, false);
  setElementHidden(elements.btnNativeBluetooth, false);
  setElementHidden(elements.btnNativeLocation, false);
  setElementHidden(elements.btnNativeNfc, false);
  invokeNativeAction('getNativeCapabilities', {}, { silentIfUnavailable: true });
}

function applyNativeCapabilities(data) {
  state.nativeCapabilities = data || null;

  const hasWifiHardware = !data || data.wifiSupported !== false;
  const hasBluetoothHardware = !data || data.bluetoothSupported !== false;
  const hasLocationHardware = !data || data.locationSupported !== false;
  const hasNfcHardware = !data || data.nfcSupported !== false;

  setElementHidden(elements.btnNativeWifi, !hasWifiHardware);
  setElementHidden(elements.btnNativeBluetooth, !hasBluetoothHardware);
  setElementHidden(elements.btnNativeLocation, !hasLocationHardware);
  setElementHidden(elements.btnNativeNfc, !hasNfcHardware);

  if (!hasNfcHardware) {
    logActivity('NFC hardware not detected. NFC pairing option hidden.');
  }

  const unavailable = [];
  if (!hasWifiHardware) unavailable.push('Wi-Fi');
  if (!hasBluetoothHardware) unavailable.push('Bluetooth');
  if (!hasLocationHardware) unavailable.push('Location');

  if (unavailable.length > 0) {
    logActivity(`Limited hardware support detected: ${unavailable.join(', ')}.`);
  }

  if (state.radarActive && (!hasWifiHardware || !hasBluetoothHardware)) {
    setRadarStatus('Limited hardware support on this phone. Use QR or room code if radar results are sparse.');
  }
}

function copyText(text, label) {
  if (!text) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      logActivity(`${label} copied to clipboard.`);
    }).catch((error) => {
      console.warn('Clipboard write failed', error);
      logActivity(`Could not copy ${label.toLowerCase()} automatically.`, 'Warning');
    });
    return;
  }

  const input = document.createElement('textarea');
  input.value = text;
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
    logActivity(`${label} copied to clipboard.`);
  } catch (error) {
    logActivity(`Could not copy ${label.toLowerCase()} automatically.`, 'Warning');
  }
  document.body.removeChild(input);
}

function invokeNativeAction(action, payload = {}, options = {}) {
  const silentIfUnavailable = Boolean(options.silentIfUnavailable);
  const hasPayload = payload && typeof payload === 'object' && Object.keys(payload).length > 0;

  try {
    if (!hasPayload && window.NativeP2PBridge && typeof window.NativeP2PBridge[action] === 'function') {
      window.NativeP2PBridge[action]();
      logActivity(`Native action requested: ${action}`);
      return true;
    }

    if (window.NativeP2PBridge && typeof window.NativeP2PBridge.postMessage === 'function') {
      window.NativeP2PBridge.postMessage(JSON.stringify({ action, ...payload }));
      logActivity(`Native bridge postMessage requested: ${action}`);
      return true;
    }

    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.NativeP2PBridge) {
      window.webkit.messageHandlers.NativeP2PBridge.postMessage({ action, ...payload });
      logActivity(`iOS bridge action requested: ${action}`);
      return true;
    }

    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage({ action, ...payload });
      logActivity(`Windows bridge action requested: ${action}`);
      return true;
    }
  } catch (error) {
    console.error(error);
    logActivity(`Native action failed: ${action}`, 'Warning');
    return false;
  }

  if (!silentIfUnavailable) {
    logActivity(`Native bridge unavailable for action: ${action}`, 'Warning');
  }
  return false;
}

function setRadarStatus(message) {
  if (!elements.radarStatus) return;
  elements.radarStatus.textContent = message;
}

function clearNearbyDevices() {
  state.nearbyDevices.clear();
  renderNearbyDevices();
}

function renderNearbyDevices() {
  if (!elements.nearbyDeviceList) return;

  const items = Array.from(state.nearbyDevices.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, 25);

  elements.nearbyDeviceList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'nearby-empty';
    empty.textContent = state.radarActive
      ? 'Scanning for nearby devices...'
      : 'No nearby devices yet.';
    elements.nearbyDeviceList.appendChild(empty);
    return;
  }

  items.forEach((device) => {
    const item = document.createElement('li');
    item.className = 'nearby-item';

    const main = document.createElement('div');
    main.className = 'nearby-main';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'nearby-name';
    name.textContent = device.deviceName || `Nearby device ${device.code}`;
    left.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'nearby-meta';
    meta.textContent = `${device.sourceLabel} • ${device.code} • seen ${formatClockTime(device.lastSeenAt)}`;
    left.appendChild(meta);

    const connectBtn = document.createElement('button');
    connectBtn.className = 'btn btn-secondary';
    connectBtn.type = 'button';
    connectBtn.textContent = 'Connect';
    connectBtn.addEventListener('click', () => {
      joinRoom(device.code);
    });

    main.appendChild(left);
    main.appendChild(connectBtn);
    item.appendChild(main);
    elements.nearbyDeviceList.appendChild(item);
  });
}

function upsertNearbyDevice(data) {
  const code = extractRoomId(data.code);
  if (!code) return;

  const source = String(data.source || 'native');
  const sourceLabelMap = {
    bluetooth: 'Bluetooth',
    ble: 'Bluetooth',
    nearby: 'Wi-Fi Direct',
    wifi: 'Wi-Fi',
    'wifi-fingerprint': 'Wi-Fi Hint',
    location: 'Location Hint',
    'location-room': 'Location Hint',
    nfc: 'NFC',
  };

  const key = String(data.deviceId || `${source}:${code}:${String(data.deviceName || '').trim()}`);
  const current = state.nearbyDevices.get(key) || {};
  const next = {
    key,
    code,
    source,
    sourceLabel: sourceLabelMap[source] || source,
    deviceName: normalizeDeviceName(data.deviceName, code) || current.deviceName || '',
    lastSeenAt: Date.now(),
  };

  state.nearbyDevices.set(key, next);
  renderNearbyDevices();
}

function normalizeDeviceName(rawName, code) {
  const value = String(rawName || '').trim();
  if (!value) return '';
  if (value === code) return '';
  if (value.toUpperCase() === `CV-${code}`) return '';
  return value;
}

function startOfflineRadarDiscovery() {
  state.radarActive = true;
  state.radarScanStartedAt = Date.now();
  state.dashboardMode = 'receive';
  setElementHidden(elements.radarPanel, false);
  clearNearbyDevices();
  setRadarStatus('Scanning nearby devices...');

  const nativeMode = hasNativeBridge();
  if (!nativeMode) {
    setRadarStatus('Offline Radar requires the Android app. Use QR or room code in browser mode.');
    return;
  }

  invokeNativeAction('startWifiPairing', {}, { silentIfUnavailable: true });
  invokeNativeAction('startBluetoothPairing', {}, { silentIfUnavailable: true });
  invokeNativeAction('startLocationPairing', {}, { silentIfUnavailable: true });
  logActivity('Offline Radar started (Wi-Fi + Bluetooth + location hints).');
}

function stopOfflineRadarDiscovery() {
  state.radarActive = false;
  invokeNativeAction('stopPairing', {}, { silentIfUnavailable: true });
}

async function getJsZipCtor() {
  if (window.JSZip) {
    return window.JSZip;
  }

  alert('ZIP engine is unavailable right now. Reopen the app with internet once to cache JSZip.');
  return null;
}

function deriveFolderArchiveName(fileEntries) {
  const firstPath = String(fileEntries[0] && fileEntries[0].relativePath ? fileEntries[0].relativePath : '');
  const topLevel = firstPath.split('/').filter(Boolean)[0];
  return (topLevel || 'folder').replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function zipFileEntries(fileEntries) {
  const JSZipCtor = await getJsZipCtor();
  if (!JSZipCtor) return null;

  const zip = new JSZipCtor();
  for (const entry of fileEntries) {
    const archivePath = sanitizeArchivePath(entry.relativePath || entry.file.name, entry.file.name);
    zip.file(archivePath, entry.file);
  }

  const archiveBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const base = deriveFolderArchiveName(fileEntries);
  const archiveName = `${base}-${formatFileTimestamp()}.zip`;
  return new File([archiveBlob], archiveName, { type: 'application/zip' });
}

function pushReceivedArchiveItem(name, blob, timestamp) {
  state.receivedArchiveItems.unshift({
    name: String(name || 'file.bin'),
    blob,
    timestamp: Number(timestamp || Date.now()),
  });

  if (state.receivedArchiveItems.length > MAX_RECEIVED_ARCHIVE_ITEMS) {
    state.receivedArchiveItems.length = MAX_RECEIVED_ARCHIVE_ITEMS;
  }
  updateSaveAllButtonState();
}

function updateSaveAllButtonState() {
  if (!elements.btnSaveAll) return;
  elements.btnSaveAll.disabled = state.receivedArchiveItems.length === 0;
}

async function saveAllReceivedArchive() {
  if (!state.receivedArchiveItems.length) {
    alert('No received files to archive yet.');
    return;
  }

  const JSZipCtor = await getJsZipCtor();
  if (!JSZipCtor) return;

  const zip = new JSZipCtor();
  state.receivedArchiveItems.forEach((item, index) => {
    const stamped = `${formatFileTimestamp(item.timestamp)}-${String(index + 1).padStart(3, '0')}-${item.name}`;
    const fileName = sanitizeArchivePath(stamped, item.name);
    zip.file(fileName, item.blob);
  });

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `ShareVia-received-${formatFileTimestamp()}.zip`;
  anchor.click();

  setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
  }, 1500);

  logActivity(`Saved ${state.receivedArchiveItems.length} received files as archive.`);
}

window.handleNativeBridgeMessage = function handleNativeBridgeMessage(payload) {
  let data = payload;

  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch (error) {
      data = { type: 'text', message: payload };
    }
  }

  if (!data || typeof data !== 'object') {
    return;
  }

  if (data.type === 'pairing-code' && data.code) {
    const code = String(data.code).trim();
    if (!elements.joinIdInput.value.trim()) {
      elements.joinIdInput.value = code;
    }
    upsertNearbyDevice({
      code,
      source: data.source || 'native',
      deviceName: data.deviceName || '',
      deviceId: data.deviceId || '',
    });
    setRadarStatus('Nearby device discovered. Tap Connect.');
    logActivity(`Native pairing code discovered: ${code}`);
    return;
  }

  if (data.type === 'location-room-hint' && data.code) {
    const code = String(data.code).trim();
    if (!elements.joinIdInput.value.trim()) {
      elements.joinIdInput.value = code;
    }
    upsertNearbyDevice({
      code,
      source: data.source || 'location',
      deviceName: data.deviceName || 'Location hint',
      deviceId: data.deviceId || '',
    });
    setRadarStatus('Location/Wi-Fi hint received.');
    logActivity('Location-assisted room suggestion received.');
    return;
  }

  if (data.type === 'nearby-device' && data.code) {
    upsertNearbyDevice(data);
    setRadarStatus('Nearby device discovered. Tap Connect.');
    return;
  }

  if (data.type === 'native-capabilities') {
    applyNativeCapabilities(data);
    return;
  }

  if (data.type === 'permissions-requested') {
    logActivity(`Native permissions requested for ${data.reason || 'transfer'}.`);
    return;
  }

  if (data.type === 'permissions-denied') {
    const denied = String(data.permissions || '').trim();
    logActivity(`Permissions denied${denied ? `: ${denied}` : ''}.`, 'Warning');
    setRadarStatus('Some permissions are denied. Enable Bluetooth/Wi-Fi/Location for full Offline Radar.');
    return;
  }

  if (data.type === 'info' && data.message) {
    logActivity(data.message);
  }
};

function safeSend(payload) {
  if (!state.conn || !state.conn.open) return false;

  try {
    state.conn.send(payload);
    return true;
  } catch (error) {
    console.error('Send failed:', error);
    logActivity('Message send failed.', 'Warning');
    return false;
  }
}

function initPeer(preferredId = undefined) {
  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('Previous peer destroy failed', error);
    }
  }

  const options = buildPeerOptions();
  const peerId = preferredId || generateRoomCode();
  state.peer = new Peer(peerId, options);

  state.peer.on('open', (id) => {
    state.myId = id;
    state.reconnectAttempts = 0;
    elements.myPeerId.textContent = id;
    generateQRCode(id);

    const joiningTarget = state.pendingJoinId;
    invokeNativeAction(
      'setRoomContext',
      {
        roomCode: id,
        role: joiningTarget ? 'joiner' : 'host',
        targetRoom: joiningTarget || '',
      },
      { silentIfUnavailable: true },
    );

    if (joiningTarget) {
      const target = joiningTarget;
      state.pendingJoinId = null;
      logActivity(`Connecting to room ${target}.`);
      const outgoing = state.peer.connect(target, { reliable: true });
      setupConnection(outgoing, 'Outgoing');
      updateStatus('Connecting', 'waiting');
      return;
    }

    state.wasHosting = true;
    state.lastRoomId = id;
    updateStatus('Waiting', 'waiting');
    logActivity(`Room ${id} is online and waiting.`);
  });

  state.peer.on('connection', (incoming) => {
    if (state.conn && state.conn.open) {
      incoming.close();
      logActivity(`Rejected extra connection from ${incoming.peer}.`, 'Warning');
      return;
    }

    setupConnection(incoming, 'Incoming');
  });

  state.peer.on('error', (error) => {
    handlePeerError(error);
  });

  state.peer.on('disconnected', () => {
    logActivity('Signaling connection lost. Attempting to reconnect...', 'Warning');
    updateStatus('Reconnecting', 'waiting');
    attemptReconnect();
  });

  state.peer.on('close', () => {
    logActivity('Peer session closed.', 'System');
  });
}

function handlePeerError(error) {
  console.error('Peer error:', error);

  if (error && error.type === 'peer-unavailable') {
    alert('Room was not found. Please check the room code or QR.');
    logActivity('Room not found.', 'Warning');
  } else {
    const type = error && error.type ? error.type : 'unknown';
    alert(`Connection error: ${type}`);
    logActivity(`Peer error: ${type}`, 'Warning');
  }

  resetToSetup({ destroyPeer: true });
}

function attemptReconnect() {
  if (!state.peer || state.peer.destroyed) {
    logActivity('Peer was destroyed. Cannot reconnect.', 'Warning');
    return;
  }

  if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    logActivity(`Reconnection failed after ${RECONNECT_MAX_ATTEMPTS} attempts.`, 'Warning');
    if (!state.conn || !state.conn.open) {
      resetToSetup({ destroyPeer: true });
    }
    return;
  }

  state.reconnectAttempts += 1;
  logActivity(`Reconnect attempt ${state.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}...`);

  try {
    state.peer.reconnect();
  } catch (error) {
    console.warn('Reconnect call failed:', error);
    setTimeout(() => attemptReconnect(), RECONNECT_DELAY);
  }
}

function hostRoom() {
  const roomId = generateRoomCode();
  state.dashboardMode = 'send';
  state.pendingJoinId = null;
  state.wasHosting = true;
  state.lastRoomId = roomId;
  stopOfflineRadarDiscovery();
  showSection(elements.hostingSection);
  updateStatus('Creating room', 'waiting');
  logActivity(`Creating room ${roomId}.`);
  initPeer(roomId);
}

function joinRoom(inputRoomId) {
  const roomId = String(inputRoomId || '').trim();

  if (!/^\d{6}$/.test(roomId)) {
    alert('Please enter a valid 6-digit room code.');
    return;
  }

  state.dashboardMode = 'receive';
  state.pendingJoinId = roomId;
  updateStatus('Preparing', 'waiting');
  logActivity(`Preparing to join room ${roomId}.`);
  initPeer();
}

function setupConnection(connection, sourceLabel) {
  state.conn = connection;

  // Start connection timeout — if 'open' doesn't fire in time, abort
  clearTimeout(state.connectionTimer);
  state.connectionTimer = setTimeout(() => {
    if (!connection.open) {
      logActivity('Connection timed out. The room may no longer be available.', 'Warning');
      try { connection.close(); } catch (e) {}
      state.conn = null;
      alert('Connection timed out. The host may have closed their browser or the room expired. Please ask them to create a new room.');
      resetToSetup({ destroyPeer: true });
    }
  }, CONNECTION_TIMEOUT);

  connection.on('open', () => {
    clearTimeout(state.connectionTimer);
    state.connectionTimer = null;
    showSection(elements.shareSection);
    elements.remotePeerId.textContent = connection.peer;
    updateStatus('Connected', 'connected');
    logActivity(`${sourceLabel} connection open with ${connection.peer}.`);
    stopOfflineRadarDiscovery();
    invokeNativeAction('startTransferService', {}, { silentIfUnavailable: true });
    announceCapabilities();
  });

  connection.on('data', (payload) => {
    handleIncomingData(payload);
  });

  connection.on('close', () => {
    clearTimeout(state.connectionTimer);
    logActivity('Peer disconnected.');
    invokeNativeAction('stopTransferService', {}, { silentIfUnavailable: true });
    resetToSetup({ destroyPeer: true });
  });

  connection.on('error', (error) => {
    clearTimeout(state.connectionTimer);
    console.error('Data connection error:', error);
    logActivity('Data connection error.', 'Warning');
    invokeNativeAction('stopTransferService', {}, { silentIfUnavailable: true });
    resetToSetup({ destroyPeer: true });
  });
}

function announceCapabilities() {
  safeSend({
    type: 'capabilities',
    data: {
      webrtc: Boolean(window.RTCPeerConnection),
      bluetooth: Boolean(navigator.bluetooth),
      nfc: Boolean(window.NDEFReader),
      geolocation: Boolean(navigator.geolocation),
      nativeBridge: hasNativeBridge(),
    },
  });
}

function resetToSetup(options = {}) {
  const destroyPeer = options.destroyPeer !== false;

  if (state.isResetting) return;
  state.isResetting = true;

  try {
    state.dashboardMode = 'idle';
    state.radarActive = false;
    clearNearbyDevices();
    setElementHidden(elements.radarPanel, true);
    setRadarStatus('Tap Receive to start nearby scan.');

    invokeNativeAction('stopTransferService', {}, { silentIfUnavailable: true });
    invokeNativeAction('stopPairing', {}, { silentIfUnavailable: true });
    invokeNativeAction('setRoomContext', { roomCode: '', role: 'idle', targetRoom: '' }, { silentIfUnavailable: true });

    if (state.conn) {
      const active = state.conn;
      state.conn = null;
      try {
        active.close();
      } catch (error) {
        console.warn('Connection close failed', error);
      }
    }

    if (destroyPeer && state.peer) {
      try {
        state.peer.destroy();
      } catch (error) {
        console.warn('Peer destroy failed', error);
      }
      state.peer = null;
      state.myId = '';
    }

    state.pendingJoinId = null;
    state.incomingTransfers.clear();
    state.outgoingTransfers.clear();

    elements.transferList.innerHTML = '';
    elements.noteInbox.innerHTML = '';
    elements.remotePeerId.textContent = '------';

    showSection(elements.setupSection);
    updateStatus('Disconnected', 'disconnected');
    window.location.hash = '';
  } finally {
    setTimeout(() => {
      state.isResetting = false;
    }, 0);
  }
}

function createTransferUI(id, name, size, direction, timestamp = Date.now()) {
  const existing = document.getElementById(`transfer-${id}`);
  if (existing) return existing;

  const wrapper = document.createElement('article');
  wrapper.id = `transfer-${id}`;
  wrapper.className = 'transfer-item';

  const head = document.createElement('div');
  head.className = 'transfer-head';

  const title = document.createElement('span');
  title.className = 'transfer-name';
  title.textContent = `${direction === 'outgoing' ? 'Sending' : 'Receiving'} - ${name}`;

  const headRight = document.createElement('div');
  headRight.className = 'transfer-head-right';

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'transfer-meta';
  sizeLabel.textContent = `${formatBytes(size)} - ${formatClockTime(timestamp)}`;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.id = `cancel-${id}`;
  cancelBtn.title = 'Cancel transfer';
  cancelBtn.textContent = 'X';
  cancelBtn.addEventListener('click', () => cancelTransfer(id, direction));

  headRight.appendChild(sizeLabel);
  headRight.appendChild(cancelBtn);

  head.appendChild(title);
  head.appendChild(headRight);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'progress-wrap';

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  progressBar.id = `progress-${id}`;

  progressWrap.appendChild(progressBar);

  const foot = document.createElement('div');
  foot.className = 'transfer-foot';

  const status = document.createElement('span');
  status.className = 'transfer-status';
  status.id = `status-${id}`;
  status.textContent = '0%';

  const speed = document.createElement('span');
  speed.className = 'transfer-speed';
  speed.id = `speed-${id}`;
  speed.textContent = '0 KB/s';

  foot.appendChild(status);
  foot.appendChild(speed);

  wrapper.appendChild(head);
  wrapper.appendChild(progressWrap);
  wrapper.appendChild(foot);

  elements.transferList.prepend(wrapper);
  return wrapper;
}

function cancelTransfer(id, direction) {
  if (direction === 'outgoing') {
    const record = state.outgoingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      state.outgoingTransfers.delete(id);
    }
  } else {
    const record = state.incomingTransfers.get(id);
    if (record) {
      record.cancelled = true;
    }
    state.incomingTransfers.delete(id);
  }

  safeSend({ type: 'file-cancel', transferId: id });

  markTransferCancelled(id);
  logActivity(`Transfer cancelled.`);
}

function markTransferCancelled(id) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);
  const cancelBtn = document.getElementById(`cancel-${id}`);

  if (bar) { bar.style.background = 'var(--danger, #c84334)'; bar.style.width = '100%'; }
  if (status) status.textContent = 'Cancelled';
  if (speed) speed.textContent = '-';
  if (cancelBtn) cancelBtn.remove();
}

function updateTransferProgress(id, progress, transferredBytes, totalBytes, startTs, statusLabel) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (!bar || !status || !speed) return;

  const clamped = Math.max(0, Math.min(progress, 100));
  bar.style.width = `${clamped.toFixed(1)}%`;

  const left = `${statusLabel || ''} ${clamped.toFixed(1)}%`.trim();
  const right = `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}`;
  status.textContent = `${left} (${right})`;
  speed.textContent = formatThroughput(transferredBytes, startTs);
}

function markTransferComplete(id, statusLabel) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (bar) bar.classList.add('complete');
  if (status && statusLabel) status.textContent = statusLabel;
  if (speed) speed.textContent = 'Complete';
}

function addDownloadAction(id, url, fileName) {
  const item = document.getElementById(`transfer-${id}`);
  if (!item || item.querySelector('[data-download]')) return;

  const button = document.createElement('button');
  button.className = 'btn btn-secondary';
  button.dataset.download = '1';
  button.style.marginTop = '10px';
  button.textContent = 'Save File';

  button.addEventListener('click', () => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  });

  item.appendChild(button);
}

function handleIncomingData(payload) {
  if (!payload || typeof payload !== 'object') return;

  switch (payload.type) {
    case 'file-start':
      handleIncomingFileStart(payload);
      break;
    case 'file-chunk':
      handleIncomingFileChunk(payload);
      break;
    case 'file-end':
      handleIncomingFileEnd(payload);
      break;
    case 'file-ack':
      handleIncomingAck(payload);
      break;
    case 'file-cancel':
      handleIncomingCancel(payload);
      break;
    case 'text-note':
      handleIncomingNote(payload);
      break;
    case 'capabilities':
      logActivity('Remote device capabilities received.');
      break;
    default:
      break;
  }
}

function handleIncomingCancel(payload) {
  const id = payload.transferId;

  // CRITICAL: Set cancelled flag on the record object BEFORE deleting.
  // The sendFile() loop holds a local reference to this object and checks
  // record.cancelled — if we only delete from the Map without setting the
  // flag, the loop's reference still sees cancelled === undefined and
  // keeps pumping chunks.
  const outRecord = state.outgoingTransfers.get(id);
  if (outRecord) {
    outRecord.cancelled = true;
  }
  const inRecord = state.incomingTransfers.get(id);
  if (inRecord) {
    inRecord.cancelled = true;
  }

  state.incomingTransfers.delete(id);
  state.outgoingTransfers.delete(id);
  markTransferCancelled(id);
  logActivity('Remote peer cancelled a transfer.');
}

function handleIncomingFileStart(payload) {
  const record = {
    transferId: payload.transferId,
    name: payload.name,
    size: Number(payload.size),
    mime: payload.mime || 'application/octet-stream',
    startedAt: Number(payload.timestamp || Date.now()),
    totalChunks: Number(payload.totalChunks),
    receivedChunks: 0,
    receivedBytes: 0,
    startTs: performance.now(),
    chunks: new Array(Number(payload.totalChunks)),
  };

  state.incomingTransfers.set(payload.transferId, record);
  createTransferUI(payload.transferId, payload.name, payload.size, 'incoming', record.startedAt);
  logActivity(`Receiving file: ${payload.name}`);
}

function handleIncomingFileChunk(payload) {
  const record = state.incomingTransfers.get(payload.transferId);
  if (!record || record.cancelled) return;

  if (record.chunks[payload.index]) {
    return;
  }

  record.chunks[payload.index] = payload.chunk;
  record.receivedChunks += 1;
  record.receivedBytes += payload.chunk.byteLength;

  const progress = (record.receivedBytes / record.size) * 100;
  updateTransferProgress(
    payload.transferId,
    progress,
    record.receivedBytes,
    record.size,
    record.startTs,
    'Receiving',
  );

  if (record.receivedChunks % state.config.ackEvery === 0 || record.receivedChunks === record.totalChunks) {
    safeSend({
      type: 'file-ack',
      transferId: payload.transferId,
      receivedChunks: record.receivedChunks,
      receivedBytes: record.receivedBytes,
    });
  }
}

function handleIncomingFileEnd(payload) {
  const record = state.incomingTransfers.get(payload.transferId);
  if (!record) return;

  if (record.receivedChunks !== record.totalChunks) {
    logActivity(`Transfer incomplete for ${record.name}. Waiting for remaining chunks.`, 'Warning');
    return;
  }

  const chunks = [];
  for (let i = 0; i < record.totalChunks; i += 1) {
    const chunk = record.chunks[i];
    if (!chunk) {
      logActivity(`Missing chunk ${i + 1} in ${record.name}.`, 'Warning');
      return;
    }
    chunks.push(chunk);
  }

  const blob = new Blob(chunks, { type: record.mime });
  const url = URL.createObjectURL(blob);
  addDownloadAction(payload.transferId, url, record.name);
  pushReceivedArchiveItem(record.name, blob, Date.now());
  updateTransferProgress(payload.transferId, 100, record.size, record.size, record.startTs, 'Received');
  markTransferComplete(payload.transferId, `Received (${formatBytes(record.size)}) at ${formatClockTime(Date.now())}`);
  logActivity(`Received file: ${record.name}`);
  addTransferHistoryEntry({
    direction: 'received',
    name: record.name,
    size: record.size,
    status: 'Completed',
    timestamp: Date.now(),
  });
  state.incomingTransfers.delete(payload.transferId);
}

function handleIncomingAck(payload) {
  const transfer = state.outgoingTransfers.get(payload.transferId);
  if (!transfer) return;

  transfer.ackedBytes = payload.receivedBytes;
  const progress = (payload.receivedBytes / transfer.size) * 100;

  updateTransferProgress(
    payload.transferId,
    progress,
    payload.receivedBytes,
    transfer.size,
    transfer.startTs,
    'Delivered',
  );
}

function handleIncomingNote(payload) {
  if (!payload.text) return;
  addNoteToInbox(payload.text, false);
  logActivity('Text note received.');
}

function addNoteToInbox(text, isSelf) {
  const item = document.createElement('div');
  item.className = `note-item ${isSelf ? 'self' : ''}`.trim();
  item.textContent = text;
  elements.noteInbox.prepend(item);
}

async function waitForBufferSpace() {
  const channel = state.conn && state.conn.dataChannel ? state.conn.dataChannel : null;

  if (!channel) {
    return;
  }

  while (channel.bufferedAmount > CHANNEL_BUFFER_LIMIT) {
    await sleep(20);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sendSelectedFiles(fileList, items, options = {}) {
  if (!state.conn || !state.conn.open) {
    alert('Connect to a room before sending files.');
    return;
  }

  const fileEntries = [];
  
  if (items && items.length > 0) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        await getFilesFromEntry(entry, fileEntries);
      }
    }
  } else {
    for (const file of Array.from(fileList || [])) {
      if (file.size === 0 && !file.type) continue;
      const relativePath = sanitizeArchivePath(file.webkitRelativePath || file.name, file.name);
      fileEntries.push({
        file,
        relativePath,
      });
    }
  }

  if (!fileEntries.length) {
    return;
  }

  const hasFolderShape =
    options.source === 'folder' ||
    fileEntries.some((entry) => String(entry.relativePath || '').includes('/'));

  if (hasFolderShape) {
    const zipped = await zipFileEntries(fileEntries);
    if (zipped) {
      logActivity(`Folder bundled as ${zipped.name} (${fileEntries.length} files).`);
      await sendFile(zipped, { bundledFromFolder: true });
      return;
    }
  }

  for (const entry of fileEntries) {
    await sendFile(entry.file);
  }
}

async function readDirectoryEntries(entry) {
  const reader = entry.createReader();
  const entries = [];

  while (true) {
    const chunk = await new Promise((resolve) => reader.readEntries(resolve));
    if (!chunk || chunk.length === 0) break;
    entries.push(...chunk);
  }

  return entries;
}

async function getFilesFromEntry(entry, fileEntries, parentPath = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    const relativePath = sanitizeArchivePath(`${parentPath}${file.name}`, file.name);
    fileEntries.push({
      file,
      relativePath,
    });
  } else if (entry.isDirectory) {
    const entries = await readDirectoryEntries(entry);
    for (const e of entries) {
      await getFilesFromEntry(e, fileEntries, `${parentPath}${entry.name}/`);
    }
  }
}

async function sendFile(file, options = {}) {
  const transferId = createTransferId();
  const totalChunks = Math.ceil(file.size / state.config.chunkSize);
  const startedAt = Date.now();
  const transferRecord = {
    id: transferId,
    size: file.size,
    sentBytes: 0,
    ackedBytes: 0,
    startedAt,
    startTs: performance.now(),
    totalChunks,
  };

  state.outgoingTransfers.set(transferId, transferRecord);
  createTransferUI(transferId, file.name, file.size, 'outgoing', startedAt);

  safeSend({
    type: 'file-start',
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    timestamp: startedAt,
    totalChunks,
  });

  let offset = 0;

  for (let index = 0; index < totalChunks; index += 1) {
    if (transferRecord.cancelled) {
      markTransferCancelled(transferId);
      return;
    }

    const end = Math.min(offset + state.config.chunkSize, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();

    await waitForBufferSpace();

    if (transferRecord.cancelled) {
      markTransferCancelled(transferId);
      return;
    }

    safeSend({
      type: 'file-chunk',
      transferId,
      index,
      chunk,
    });

    offset = end;
    transferRecord.sentBytes = offset;

    updateTransferProgress(
      transferId,
      (offset / file.size) * 100,
      transferRecord.sentBytes,
      file.size,
      transferRecord.startTs,
      'Sending',
    );

    if (index % 32 === 0) {
      await sleep(0);
    }
  }

  safeSend({
    type: 'file-end',
    transferId,
  });

  const statusSuffix = options.bundledFromFolder ? 'Folder archive sent' : 'Sent';
  markTransferComplete(transferId, `${statusSuffix} (${formatBytes(file.size)}) at ${formatClockTime(Date.now())}`);
  logActivity(`Sent file: ${file.name}`);
  addTransferHistoryEntry({
    direction: 'sent',
    name: file.name,
    size: file.size,
    status: 'Completed',
    timestamp: Date.now(),
  });
}

function queueNote() {
  const text = elements.textNote.value.trim();
  if (!text) {
    return;
  }

  if (!state.conn || !state.conn.open) {
    alert('Connect first to send notes.');
    return;
  }

  safeSend({
    type: 'text-note',
    text,
  });

  addNoteToInbox(text, true);
  elements.textNote.value = '';
  logActivity('Text note sent.');
}

function generateQRCode(roomId) {
  elements.qrcodeContainer.innerHTML = '';

  const joinUrl = generateJoinUrl(roomId);
  new QRCode(elements.qrcodeContainer, {
    text: joinUrl,
    width: 220,
    height: 220,
    colorDark: '#0f3f3a',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function extractRoomId(rawText) {
  if (!rawText) return null;

  const trimmed = String(rawText).trim();
  if (/^\d{6}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsedUrl = new URL(trimmed);
    const hash = parsedUrl.hash.replace('#', '').trim();
    if (/^\d{6}$/.test(hash)) {
      return hash;
    }

    const queryRoom = parsedUrl.searchParams.get('room');
    if (queryRoom && /^\d{6}$/.test(queryRoom)) {
      return queryRoom;
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function startScanner() {
  elements.scannerModal.classList.remove('hidden');

  if (!window.Html5Qrcode) {
    alert('QR scanner is unavailable in this browser.');
    return;
  }

  try {
    if (!state.html5QrCode) {
      state.html5QrCode = new Html5Qrcode('qr-reader');
    }

    state.scannerActive = true;

    await state.html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => {
        handleScanResult(decodedText);
      },
    );

    logActivity('Scanner started.');
  } catch (error) {
    console.error('Scanner start error:', error);
    alert('Unable to start camera. Use room code instead.');
    stopScanner();
  }
}

function stopScanner() {
  if (state.html5QrCode && state.scannerActive) {
    state.html5QrCode.stop().catch((error) => {
      console.warn('Scanner stop error:', error);
    });
  }

  state.scannerActive = false;
  elements.scannerModal.classList.add('hidden');
}

function handleScanResult(decodedText) {
  const roomId = extractRoomId(decodedText);
  if (!roomId) {
    return;
  }

  stopScanner();
  elements.joinIdInput.value = roomId;
  joinRoom(roomId);
}

function toggleAdvancedPanel() {
  const isHidden = elements.advancedPanel.classList.toggle('hidden');
  const btn = document.getElementById('btn-advanced');
  btn.setAttribute('aria-expanded', !isHidden);
}

function saveAdvancedConfig() {
  readConfigFromUI();
  persistConfig();
  updateTransportBadge();
  logActivity('Settings saved.');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.register('./sw.js').then(() => {
    logActivity('Offline cache enabled.');
  }).catch((error) => {
    console.warn('Service worker registration failed:', error);
  });
}

function bindEvents() {
  elements.btnDashboardSend && elements.btnDashboardSend.addEventListener('click', hostRoom);
  elements.btnDashboardReceive && elements.btnDashboardReceive.addEventListener('click', startOfflineRadarDiscovery);

  document.getElementById('btn-scan').addEventListener('click', startScanner);
  document.getElementById('btn-close-scanner').addEventListener('click', stopScanner);
  document.getElementById('btn-cancel-host').addEventListener('click', () => resetToSetup({ destroyPeer: true }));
  document.getElementById('btn-join').addEventListener('click', () => joinRoom(elements.joinIdInput.value));
  document.getElementById('btn-disconnect').addEventListener('click', () => resetToSetup({ destroyPeer: true }));
  document.getElementById('btn-advanced').addEventListener('click', toggleAdvancedPanel);
  elements.formSettings.addEventListener('submit', (event) => {
    event.preventDefault();
    saveAdvancedConfig();
  });
  document.getElementById('btn-send-note').addEventListener('click', queueNote);

  elements.btnNativeWifi && elements.btnNativeWifi.addEventListener('click', () => invokeNativeAction('startWifiPairing'));
  elements.btnNativeBluetooth && elements.btnNativeBluetooth.addEventListener('click', () => invokeNativeAction('startBluetoothPairing'));
  elements.btnNativeNfc && elements.btnNativeNfc.addEventListener('click', () => invokeNativeAction('startNfcPairing'));
  elements.btnNativeLocation && elements.btnNativeLocation.addEventListener('click', () => invokeNativeAction('startLocationPairing'));

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    copyText(state.myId, 'Room code');
  });

  document.getElementById('btn-copy-link').addEventListener('click', () => {
    copyText(generateJoinUrl(state.myId), 'Join link');
  });

  elements.btnSaveAll && elements.btnSaveAll.addEventListener('click', saveAllReceivedArchive);

  elements.historyTabs.forEach((button) => {
    button.addEventListener('click', () => {
      setHistoryFilter(button.dataset.historyTab || 'all');
    });
  });

  elements.joinIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom(elements.joinIdInput.value);
    }
  });

  elements.textNote.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      queueNote();
    }
  });

  elements.btnPickFiles.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.fileInput.click();
  });

  elements.btnPickFolder.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.folderInput.click();
  });

  elements.fileInput.addEventListener('change', async () => {
    await sendSelectedFiles(elements.fileInput.files, null, { source: 'files' });
    elements.fileInput.value = '';
  });

  elements.folderInput.addEventListener('change', async () => {
    await sendSelectedFiles(elements.folderInput.files, null, { source: 'folder' });
    elements.folderInput.value = '';
  });

  elements.dropZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') {
      elements.fileInput.click();
    }
  });

  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragging');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragging');
  });

  elements.dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragging');
    await sendSelectedFiles(event.dataTransfer.files, event.dataTransfer.items, { source: 'drop' });
  });
}

function initialize() {
  applyConfigToUI();
  updateTransportBadge();
  updateStatus('Disconnected', 'disconnected');
  setElementHidden(elements.radarPanel, true);
  setRadarStatus('Tap Receive to start nearby scan.');
  detectCapabilities();
  bindEvents();
  setHistoryFilter('all');
  updateSaveAllButtonState();
  registerServiceWorker();

  // Mobile tab suspension resilience: when user returns from WhatsApp etc.,
  // check if the peer is still alive and reconnect if needed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    if (state.peer && !state.peer.destroyed && state.peer.disconnected) {
      logActivity('Tab resumed. Reconnecting to signaling server...', 'System');
      updateStatus('Reconnecting', 'waiting');
      state.reconnectAttempts = 0;
      attemptReconnect();
    }
  });

  const roomIdFromUrl = extractRoomId(window.location.href);
  if (roomIdFromUrl) {
    elements.joinIdInput.value = roomIdFromUrl;
    joinRoom(roomIdFromUrl);
  }
}

window.addEventListener('load', initialize);

