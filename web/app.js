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
const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_DELAY = 2500;
const MAX_HISTORY_ENTRIES = 300;
const MAX_RECEIVED_ARCHIVE_ITEMS = 300;
const JSZIP_CDN_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const DEFAULT_APP_DOWNLOAD_URL = 'https://play.google.com/store/apps/details?id=com.ShareVia.app';
const TRANSIENT_PEER_ERROR_TYPES = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);
const V2_API = Object.freeze({
  magicLinkRequest: '/v2/auth/magic-link/request',
  magicLinkVerify: '/v2/auth/magic-link/verify',
  deviceLinkStart: '/v2/device/link/start',
  deviceLinkConfirm: '/v2/device/link/confirm',
  iceConfig: '/v2/config/ice',
  realtime: '/v2/realtime',
});
const LEGACY_TO_V2_EVENT = Object.freeze({
  'file-start': 'transfer.start',
  'file-chunk': 'transfer.chunk',
  'file-end': 'transfer.end',
  'file-ack': 'transfer.ack',
  'file-cancel': 'transfer.cancel',
  'text-note': 'transfer.note',
});

const state = {
  peer: null,
  connections: new Map(),
  myId: '',
  pendingJoinId: null,
  profileName: localStorage.getItem('sv_profile_name') || '',
  profileAvatar: localStorage.getItem('sv_profile_avatar') || '',
  html5QrCode: null,
  isResetting: false,
  config: loadConfig(),
  incomingTransfers: new Map(),
  outgoingTransfers: new Map(),
  scannerActive: false,
  connectionTimers: new Map(),
  reconnectAttempts: 0,
  wasHosting: false,
  lastRoomId: null,
  lastJoinRoomId: null,
  dashboardMode: 'idle',
  unreadNotesCount: 0,

  nativeCapabilities: null,
  transferHistory: loadTransferHistory(),
  historyFilter: 'all',
  receivedArchiveItems: [],
  webJoinOnly: false,

  appDownloadUrl: DEFAULT_APP_DOWNLOAD_URL,
};

const elements = {
  setupSection: document.getElementById('setup-section'),
  setupTitle: document.getElementById('setup-title'),
  setupSubtitle: document.getElementById('setup-subtitle'),
  hostingSection: document.getElementById('hosting-section'),
  shareSection: document.getElementById('share-section'),
  dashboardGrid: document.getElementById('dashboard-grid'),
  webAppBanner: document.getElementById('web-app-banner'),
  btnGetApp: document.getElementById('btn-get-app'),
  webJoinPanel: document.getElementById('web-join-panel'),
  webJoinIdInput: document.getElementById('web-join-id'),
  btnWebJoin: document.getElementById('btn-web-join'),
  btnWebScan: document.getElementById('btn-web-scan'),
  btnDashboardSend: document.getElementById('btn-dashboard-send'),
  myPeerId: document.getElementById('my-peer-id'),
  remotePeerId: document.getElementById('remote-peer-id'),
  qrcodeContainer: document.getElementById('qrcode-container'),
  transferList: document.getElementById('transfer-list'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  btnSaveAll: document.getElementById('btn-save-all'),
  historyTabs: Array.from(document.querySelectorAll('[data-history-tab]')),
  btnPickFiles: document.getElementById('btn-pick-files'),
  btnPickFolder: document.getElementById('btn-pick-folder'),
  noteInbox: document.getElementById('note-inbox'),
  noteBadge: document.getElementById('note-badge'),
  btnSendNote: document.getElementById('btn-send-note'),
  textNote: document.getElementById('text-note'),
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
  btnAdvanced: document.getElementById('btn-advanced'),
  formSettings: document.getElementById('form-settings'),
  btnHeaderDisconnect: document.getElementById('btn-header-disconnect'),
  qrSkeleton: document.getElementById('qr-skeleton'),
  transfersPanel: document.getElementById('transfers-panel'),
};

let initializeDone = false;
let jsZipLoadPromise = null;

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

function resolveV2ApiBase() {
  const secure = Boolean(state.config.signalingSecure);
  const host = String(state.config.signalingHost || '').trim();
  const port = String(state.config.signalingPort || '').trim();
  if (!host) {
    return '';
  }
  const protocol = secure ? 'https' : 'http';
  const defaultPort = secure ? '443' : '80';
  return `${protocol}://${host}${port && port !== defaultPort ? `:${port}` : ''}`;
}

function mapLegacyEventToV2(eventType) {
  return LEGACY_TO_V2_EVENT[eventType] || eventType;
}

async function callV2Api(path, method = 'GET', body = undefined) {
  const base = resolveV2ApiBase();
  if (!base) {
    throw new Error('Missing signaling host config for V2 API.');
  }

  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `V2 API ${path} failed`);
  }

  return payload;
}

async function syncIceConfigFromV2() {
  try {
    const payload = await callV2Api(V2_API.iceConfig);
    if (!Array.isArray(payload.iceServers)) {
      return;
    }

    const stunServer = payload.iceServers.find((entry) => Array.isArray(entry.urls) && entry.urls.length);
    if (stunServer && Array.isArray(stunServer.urls) && stunServer.urls.length > 0) {
      state.config.iceStunUrl = String(stunServer.urls[0] || state.config.iceStunUrl).trim();
      if (elements.iceStunUrl) {
        elements.iceStunUrl.value = state.config.iceStunUrl;
      }
      persistConfig();
      logActivity('Loaded ICE config from V2 backend.', 'System');
    }
  } catch (error) {
    logActivity('Could not load V2 ICE config. Using local settings.', 'Warning');
  }
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
  
  // Filter the active transfer list
  const cards = elements.transferList.querySelectorAll('.transfer-item');
  cards.forEach((card) => {
    if (next === 'all') {
      card.classList.remove('hidden');
    } else {
      card.classList.toggle('hidden', card.dataset.direction !== next);
    }
  });
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
    const action = entry.direction === 'received' ? 'received' : 'sent';
    name.textContent = `${entry.name} ${action}`;

    row.appendChild(name);

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
  // Badge removed from UI
}

function updateStatus(text, className) {
  // Badge removed from UI
}

function showSection(section) {
  [elements.setupSection, elements.hostingSection, elements.shareSection].forEach((candidate) => {
    candidate.classList.add('hidden');
    candidate.classList.remove('active');
  });

  section.classList.remove('hidden');
  section.classList.add('active');

  // Update history visibility: hide if only on setup, show once starting/joining room
  // Update transfers panel visibility: show alongside share section or hosting
  if (elements.transfersPanel) {
    if (section === elements.shareSection) {
      elements.transfersPanel.classList.remove('hidden');
    } else {
      elements.transfersPanel.classList.add('hidden');
    }
  }

  // Update header disconnect button visibility and text
  if (elements.btnHeaderDisconnect) {
    if (section === elements.setupSection) {
      elements.btnHeaderDisconnect.classList.add('hidden');
    } else {
      elements.btnHeaderDisconnect.classList.remove('hidden');
      elements.btnHeaderDisconnect.textContent = (section === elements.hostingSection) ? 'Cancel' : 'Leave';
    }
  }
}

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function logActivity(message, source = 'System') {
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

let audioContextInstance = null;

function playNotificationSound(type = 'default') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContextInstance) audioContextInstance = new AudioCtx();
    if (audioContextInstance.state === 'suspended') audioContextInstance.resume();
    
    const audioContent = audioContextInstance;
    
    // Simple, clean 'Ping' sound
    const playPing = (freq, duration, volume = 0.1) => {
      const now = audioContent.currentTime;
      const osc = audioContent.createOscillator();
      const gain = audioContent.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      
      osc.connect(gain);
      gain.connect(audioContent.destination);
      
      osc.start(now);
      osc.stop(now + duration);
    };

    if (type === 'message' || type === 'note') {
      // One crisp high ping
      playPing(880, 0.4); 
    } else if (type === 'file') {
      // Soft double-tap blip
      playPing(660, 0.2, 0.07);
      setTimeout(() => playPing(880, 0.2, 0.07), 80);
    }
  } catch (e) {}
}

const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateRoomCode() {
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
  }
  return result;
}

/** E2EE Crypto Suite **/
async function encryptPayload(data) {
  const secret = state.pendingJoinId || state.lastJoinRoomId || state.myId;
  if (!secret) return data;
  
  try {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', 
      encoder.encode(secret.padEnd(32, 's')),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      keyMaterial,
      encoder.encode(JSON.stringify(data))
    );

    return {
      type: 'e2ee-wrap',
      iv: Array.from(iv),
      cipher: Array.from(new Uint8Array(encrypted))
    };
  } catch (e) {
    console.warn('Encryption failed', e);
    return data;
  }
}

async function decryptPayload(wrapped) {
  if (!wrapped || wrapped.type !== 'e2ee-wrap') return wrapped;
  
  const secret = state.pendingJoinId || state.lastJoinRoomId || state.myId;
  if (!secret) return wrapped;

  try {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', 
      encoder.encode(secret.padEnd(32, 's')),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(wrapped.iv) },
      keyMaterial,
      new Uint8Array(wrapped.cipher)
    );

    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    console.error('Decryption failed. Room code mismatch?', e);
    return null;
  }
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

function getOpenConnections() {
  return Array.from(state.connections.values()).filter((connection) => connection && connection.open);
}

function hasOpenConnections() {
  return getOpenConnections().length > 0;
}

function hasAnyConnection() {
  return state.connections.size > 0;
}

function makeTransferKey(peerId, transferId) {
  return `${String(peerId || 'unknown')}::${String(transferId || '')}`;
}

function normalizePeerLabel(peerId) {
  const raw = String(peerId || '').trim();
  if (!raw) {
    return 'Unknown peer';
  }

  return raw;
}

function updateConnectedPeersLabel() {
  if (!elements.remotePeerId) {
    return;
  }

  const openConnections = getOpenConnections();
  const pill = elements.remotePeerId.parentElement;

  if (!openConnections.length) {
    elements.remotePeerId.textContent = 'Disconnected';
    elements.remotePeerId.classList.add('disconnected-text');
    elements.remotePeerId.classList.remove('loading-text');
    if (pill && pill.classList.contains('room-pill')) {
      pill.classList.add('disconnected');
    }
    updateInteractionState(false);
    return;
  }

  elements.remotePeerId.classList.remove('disconnected-text', 'loading-text');
  if (pill && pill.classList.contains('room-pill')) {
    pill.classList.remove('disconnected');
  }
  updateInteractionState(true);

  if (openConnections.length === 1) {
    elements.remotePeerId.textContent = normalizePeerLabel(openConnections[0].peer);
    return;
  }

  elements.remotePeerId.textContent = `${openConnections.length} peers`;
}

function updateInteractionState(isEnabled) {
  const elementsToToggle = [
    elements.btnSendNote,
    elements.btnPickFiles,
    elements.btnPickFolder,
    elements.textNote,
    elements.fileInput,
    elements.folderInput
  ];

  elementsToToggle.forEach(el => {
    if (el) el.disabled = !isEnabled;
  });

  if (elements.dropZone) {
    elements.dropZone.classList.toggle('disabled', !isEnabled);
  }
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

function resolveAppDownloadUrl() {
  const meta = document.querySelector('meta[name="sharevia-app-url"]');
  const candidate = String((meta && meta.content) || '').trim();
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return DEFAULT_APP_DOWNLOAD_URL;
}

function configurePlatformMode() {
  const nativeMode = hasNativeBridge();
  state.appDownloadUrl = resolveAppDownloadUrl();
  state.webJoinOnly = false; // website now has full P2P; this flag is no longer used for gating

  document.body.classList.toggle('native-mode', nativeMode);
  document.body.classList.remove('web-join-mode');

  if (elements.btnGetApp) {
    elements.btnGetApp.href = state.appDownloadUrl;
  }

  // Mode toggle: visible only in Android native mode
  setElementHidden(elements.shareModeToggle, !nativeMode);

  // App banner: show on website (encourages app download), hide in app
  setElementHidden(elements.webAppBanner, nativeMode);

  // Dashboard grid: always visible
  setElementHidden(elements.dashboardGrid, false);



  if (elements.setupTitle) {
    elements.setupTitle.textContent = nativeMode ? 'Quick Share' : 'Share Files Online';
  }
  if (elements.setupSubtitle) {
    elements.setupSubtitle.textContent = 'Send or receive files with anyone, anywhere. No account needed.';
  }
}

async function disableBrowserOfflineCache() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((reg) => reg.unregister()));
  } catch (error) {
    console.warn('Service worker unregister failed:', error);
  }

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('sharevia-'))
          .map((key) => caches.delete(key)),
      );
    } catch (error) {
      console.warn('Cache cleanup failed:', error);
    }
  }
}

function applyNativeSafeTopInset() {
  const nativeMode = hasNativeBridge();
  const isAndroid = /Android/i.test(navigator.userAgent || '');

  if (!nativeMode || !isAndroid) {
    return;
  }

  const visualTop = Math.max(0, Math.round(window.visualViewport ? window.visualViewport.offsetTop : 0));
  const fallbackTop = 24;
  const safeTop = Math.max(visualTop, fallbackTop);
  document.documentElement.style.setProperty('--safe-top', `${safeTop}px`);
}



function copyText(text, label, btnElement = null) {
  if (!text) return;

  const provideFeedback = () => {
    logActivity(`${label} copied to clipboard.`);
    if (btnElement) {
      const originalText = btnElement.textContent;
      const isButton = btnElement.tagName === 'BUTTON';
      
      if (isButton) {
        btnElement.textContent = 'Copied!';
        btnElement.classList.add('copy-success');
        setTimeout(() => {
          btnElement.textContent = originalText;
          btnElement.classList.remove('copy-success');
        }, 1500);
      }
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      provideFeedback();
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
    provideFeedback();
  } catch (error) {
    console.warn('ExecCommand copy failed', error);
    logActivity(`Could not copy ${label.toLowerCase()} automatically.`, 'Warning');
  }
  document.body.removeChild(input);
}







async function getJsZipCtor() {
  if (window.JSZip) {
    return window.JSZip;
  }

  if (!jsZipLoadPromise) {
    jsZipLoadPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = JSZIP_CDN_URL;
      script.async = true;
      script.onload = () => resolve(window.JSZip || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);

      setTimeout(() => {
        resolve(window.JSZip || null);
      }, 3500);
    });
  }

  const loaded = await jsZipLoadPromise;
  if (loaded) {
    return loaded;
  }

  showCustomModal('Archive Unavailable', 'The ZIP engine is currently unavailable. Please check your internet connection and try again.');
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
  const count = state.receivedArchiveItems.length;
  // Only show the "Save All" tool if we have more than one item to archive
  elements.btnSaveAll.classList.toggle('hidden', count <= 1);
  elements.btnSaveAll.disabled = count === 0;
}

async function saveAllReceivedArchive() {
  if (!state.receivedArchiveItems.length) {
    showCustomModal('Notice', 'There are no received files to archive yet.');
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

  if (data.type === 'native-capabilities') {
    // Platform detection logic already handles this globally
    return;
  }

  if (data.type === 'info' && data.message) {
    logActivity(data.message);
  }
};


async function safeSendToConnection(connection, payload, options = {}) {
  if (!connection || !connection.open) {
    return false;
  }

  try {
    const finalPayload = await encryptPayload(payload);
    connection.send(finalPayload);
    return true;
  } catch (error) {
    console.error('Send failed:', error);
    if (!options.silent) {
      logActivity(`Message send failed for ${normalizePeerLabel(connection.peer)}.`, 'Warning');
    }
    return false;
  }
}

function getConnectionByPeer(peerId) {
  const normalized = String(peerId || '').trim();
  if (!normalized) {
    return null;
  }
  return state.connections.get(normalized) || null;
}

async function sendToPeer(peerId, payload, options = {}) {
  const connection = getConnectionByPeer(peerId);
  if (!connection || !connection.open) {
    return false;
  }

  return await safeSendToConnection(connection, payload, options);
}

async function broadcastToConnections(payload, options = {}) {
  const targets = getOpenConnections();
  if (!targets.length) {
    return false;
  }

  let sent = false;
  for (const connection of targets) {
    if (await safeSendToConnection(connection, payload, options)) {
      sent = true;
    }
  }
  return sent;
}

function safeSend(payload, options = {}) {
  return broadcastToConnections(payload, options);
}

function clearConnectionTimeout(peerId) {
  const key = String(peerId || '').trim();
  if (!key) {
    return;
  }

  const timer = state.connectionTimers.get(key);
  if (timer) {
    clearTimeout(timer);
  }
  state.connectionTimers.delete(key);
}

function closeAllConnections() {
  state.connections.forEach((connection, peerId) => {
    clearConnectionTimeout(peerId);
    connection.__shareviaClosing = true;
    try {
      connection.close();
    } catch (error) {
      console.warn('Connection close failed', error);
    }
  });
  state.connections.clear();
  updateConnectedPeersLabel();
}

function initPeer(preferredId = undefined) {
  closeAllConnections();

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
    
    // Ensure UI is updated (in case it wasn't set optimistically or ID changed)
    elements.myPeerId.textContent = id;
    elements.myPeerId.classList.remove('loading');
    generateQRCode(id);

    // Update titles for 'Ready' state
    const titleEl = elements.hostingSection.querySelector('h2');
    const subEl = elements.hostingSection.querySelector('.subtitle');
    if (titleEl) titleEl.textContent = 'Room Ready';
    if (subEl) subEl.textContent = 'Share this room code or QR. Keep this app open until the receiver connects.';

    const joiningTarget = state.pendingJoinId;

    if (joiningTarget) {
      const target = joiningTarget;
      state.pendingJoinId = null;
      logActivity(`Connecting to room ${target}.`);
      
      // Update Join button back to original state (it's hidden now anyway)
      if (elements.btnWebJoin) {
        elements.btnWebJoin.disabled = false;
        elements.btnWebJoin.textContent = 'Join';
        elements.btnWebJoin.classList.remove('pulse');
      }

      if (elements.remotePeerId) {
        elements.remotePeerId.textContent = `Establishing P2P: ${target}`;
      }

      const outgoing = state.peer.connect(target, { reliable: true });
      setupConnection(outgoing, 'Outgoing');
      updateStatus('Connecting', 'waiting');
      return;
    }

    state.wasHosting = true;
    state.lastRoomId = id;
    updateStatus('Waiting', 'waiting');
    logActivity(`Room ${id} is ready.`);
  });

  state.peer.on('connection', (incoming) => {
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

function isTransientPeerError(error) {
  const type = String(error && error.type ? error.type : '').toLowerCase();
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (TRANSIENT_PEER_ERROR_TYPES.has(type)) {
    return true;
  }

  return (
    message.includes('lost connection') ||
    message.includes('websocket') ||
    message.includes('socket') ||
    message.includes('network')
  );
}

function recoverHostRoomAfterSignalLoss() {
  if (!state.wasHosting || !state.lastRoomId) {
    return false;
  }

  state.pendingJoinId = null;
  showSection(elements.hostingSection);
  updateStatus('Reconnecting', 'waiting');
  logActivity(`Reopening sender room ${state.lastRoomId}...`, 'System');
  initPeer(state.lastRoomId);
  return true;
}

function recoverJoinRoomAfterSignalLoss() {
  if (!state.lastJoinRoomId) {
    return false;
  }

  state.pendingJoinId = state.lastJoinRoomId;
  showSection(elements.setupSection);
  updateStatus('Reconnecting', 'waiting');
  logActivity(`Rejoining room ${state.lastJoinRoomId}...`, 'System');
  initPeer();
  return true;
}

function handlePeerError(error) {
  console.error('Peer error:', error);

  if (error && error.type === 'peer-unavailable') {
    logActivity('Room unavailable or not found.', 'Warning');
    resetToSetup({ destroyPeer: true });
    return;
  }

  if (isTransientPeerError(error)) {
    logActivity('Signaling connection interrupted. Attempting automatic recovery...', 'Warning');
    updateStatus('Reconnecting', 'waiting');

    if (state.peer && !state.peer.destroyed) {
      attemptReconnect();
      return;
    }

    if (recoverHostRoomAfterSignalLoss()) {
      return;
    }

    if (recoverJoinRoomAfterSignalLoss()) {
      return;
    }

    logActivity('Could not recover session automatically. Please reconnect.', 'Warning');
    resetToSetup({ destroyPeer: true });
    return;
  }

  const type = error && error.type ? error.type : 'unknown';
  showCustomModal('Connection Error', `A connection error occurred: ${type}`);
  logActivity(`Peer error: ${type}`, 'Warning');
  resetToSetup({ destroyPeer: true });
}

function attemptReconnect() {
  if (!state.peer || state.peer.destroyed) {
    logActivity('Peer was destroyed. Cannot reconnect.', 'Warning');
    return;
  }

  if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    logActivity(`Reconnection failed after ${RECONNECT_MAX_ATTEMPTS} attempts.`, 'Warning');
    if (!hasOpenConnections()) {
      if (recoverHostRoomAfterSignalLoss()) {
        return;
      }

      if (recoverJoinRoomAfterSignalLoss()) {
        return;
      }
    }

    if (!hasOpenConnections()) {
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
  if (state.myId && state.peer && !state.peer.destroyed) {
    elements.myPeerId.textContent = state.myId;
    elements.myPeerId.classList.remove('loading');
    generateQRCode(state.myId);
    showSection(elements.hostingSection);
    return;
  }

  elements.myPeerId.classList.add('loading');
  elements.myPeerId.textContent = '------';
  if (elements.qrcodeContainer) elements.qrcodeContainer.classList.add('loading');

  const roomId = generateRoomCode();
  state.dashboardMode = 'send';
  state.pendingJoinId = null;
  state.lastJoinRoomId = null;
  state.wasHosting = true;
  state.lastRoomId = roomId;

  showSection(elements.hostingSection);
  updateStatus('Creating room', 'waiting');
  logActivity(`Creating room ${roomId}.`);
  initPeer(roomId);
}

function beginSendDiscovery() {
  if (hasAnyConnection()) {
    showCustomModal('Active Session', 'You are already connected. Please disconnect the current session before starting a new one.');
    return;
  }
  
  // Audio unlock for mobile browsers
  playNotificationSound('silent'); 

  const roomId = generateRoomCode();
  
  // Optimistic UI: show the code and QR immediately
  elements.myPeerId.textContent = roomId;
  elements.myPeerId.classList.remove('loading');
  generateQRCode(roomId);
  
  if (elements.qrcodeContainer) elements.qrcodeContainer.classList.remove('loading');

  state.dashboardMode = 'send';
  state.pendingJoinId = null;
  state.lastJoinRoomId = null;
  state.wasHosting = true;
  state.lastRoomId = roomId;
  
  showSection(elements.hostingSection);
  
  // Update UI titles/subtitles for 'Connecting' state
  const titleEl = elements.hostingSection.querySelector('h2');
  const subEl = elements.hostingSection.querySelector('.subtitle');
  if (titleEl) titleEl.textContent = 'Creating Room...';
  if (subEl) subEl.textContent = 'Connecting to signaling server...';

  updateStatus('Creating room', 'waiting');
  logActivity(`Creating room ${roomId}.`);
  initPeer(roomId);
}

function beginReceiveDiscovery() {
  if (hasAnyConnection()) {
    showCustomModal('Active Session', 'You are already connected. Please disconnect the current session before joining another one.');
    return;
  }

  elements.webJoinIdInput && elements.webJoinIdInput.focus();
  updateStatus('Joining', 'waiting');
}

function shareRoomLink() {
  if (!state.myId) {
    showCustomModal('Starting Room', 'The room is still being prepared. Please wait a second and try again.');
    return;
  }

  const link = generateJoinUrl(state.myId);
  const text = `Join my ShareVia room: ${state.myId}`;

  if (navigator.share) {
    navigator.share({ title: 'ShareVia Room', text, url: link }).catch(() => {
      copyText(link, 'Join link');
    });
    return;
  }

  copyText(link, 'Join link', elements.btnShareOnlineLink);
}

function joinRoom(inputRoomId) {
  const roomId = String(inputRoomId || '').trim().toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(roomId)) {
    showCustomModal('Invalid Code', 'Please enter a valid **6-character alphanumeric** room code.');
    return;
  }

  // Visual feedback on the button
  if (elements.btnWebJoin) {
    elements.btnWebJoin.disabled = true;
    elements.btnWebJoin.textContent = 'Joining...';
    elements.btnWebJoin.classList.add('pulse');
  }

  state.dashboardMode = 'receive';
  state.pendingJoinId = roomId;
  state.lastJoinRoomId = roomId;
  state.wasHosting = false;
  
  // Transition to share section immediately with "Connecting" status
  showSection(elements.shareSection);
  if (elements.remotePeerId) {
    elements.remotePeerId.textContent = `Connecting to ${roomId}...`;
    elements.remotePeerId.classList.add('loading-text');
  }

  updateStatus('Preparing', 'waiting');
  logActivity(`Preparing to join room ${roomId}.`);
  
  // Audio unlock for mobile browsers
  playNotificationSound('silent');

  initPeer();
}

function clearTransfersForPeer(peerId) {
  const normalizedPeerId = String(peerId || '').trim();
  if (!normalizedPeerId) {
    return;
  }

  state.outgoingTransfers.forEach((record, transferKey) => {
    if (record && record.peerId === normalizedPeerId) {
      record.cancelled = true;
      state.outgoingTransfers.delete(transferKey);
      markTransferCancelled(transferKey);
    }
  });

  state.incomingTransfers.forEach((record, transferKey) => {
    if (record && record.peerId === normalizedPeerId) {
      record.cancelled = true;
      state.incomingTransfers.delete(transferKey);
      markTransferCancelled(transferKey);
    }
  });
}

function handlePeerConnectionClosed(peerId, options = {}) {
  const normalizedPeerId = String(peerId || '').trim();
  if (normalizedPeerId) {
    state.connections.delete(normalizedPeerId);
    clearConnectionTimeout(normalizedPeerId);
    clearTransfersForPeer(normalizedPeerId);
  }

  updateConnectedPeersLabel();

  const openCount = getOpenConnections().length;
  if (openCount > 0) {
    updateStatus('Connected', 'connected');
    logActivity(`${normalizePeerLabel(peerId)} disconnected. ${openCount} peer(s) still connected.`, 'Warning');
    addNoteToInbox(`❌ ${normalizePeerLabel(peerId)} has left the room.`, false);
    return;
  }

  invokeNativeAction('stopTransferService', {}, { silentIfUnavailable: true });

  if (state.wasHosting && state.peer && !state.peer.destroyed && state.myId) {
    showSection(elements.hostingSection);
    updateStatus('Waiting', 'waiting');
    logActivity('All peers disconnected. Room is still open for new connections.', 'System');
    return;
  }


  resetToSetup({ destroyPeer: true });
}

function setupConnection(connection, sourceLabel) {
  const peerId = String(connection && connection.peer ? connection.peer : '').trim();
  if (!peerId) {
    try {
      connection.close();
    } catch (error) {
      console.warn('Unnamed connection close failed', error);
    }
    return;
  }

  const existing = state.connections.get(peerId);
  if (existing && existing !== connection) {
    try {
      existing.close();
    } catch (error) {
      console.warn('Previous connection close failed', error);
    }
  }

  state.connections.set(peerId, connection);
  updateConnectedPeersLabel();

  clearConnectionTimeout(peerId);
  const timer = setTimeout(() => {
    if (connection.__shareviaClosing) {
      return;
    }
    if (!connection.open) {
      logActivity(`Connection to ${normalizePeerLabel(peerId)} timed out.`, 'Warning');
      try {
        connection.close();
      } catch (error) {
        console.warn('Connection timeout close failed', error);
      }
      finalizeConnection(false);
      if (!state.wasHosting) {
        showCustomModal('Connection Timeout', 'The connection timed out. The host might have closed their app or the room has expired. Please ask for a new code.');
      }
    }
  }, CONNECTION_TIMEOUT);
  state.connectionTimers.set(peerId, timer);

  let finalized = false;
  const finalizeConnection = (showSenderOfflineHint = true) => {
    if (finalized) {
      return;
    }
    finalized = true;
    if (connection.__shareviaClosing) {
      state.connections.delete(peerId);
      clearConnectionTimeout(peerId);
      return;
    }
    handlePeerConnectionClosed(peerId, { showSenderOfflineHint });
  };

  connection.on('open', () => {
    connection.__shareviaClosing = false;
    clearConnectionTimeout(peerId);
    state.connections.set(peerId, connection);
    showSection(elements.shareSection);
    updateConnectedPeersLabel();
    updateStatus('Connected', 'connected');
    const openCount = getOpenConnections().length;
    logActivity(`${sourceLabel} connection open with ${normalizePeerLabel(peerId)}${openCount > 1 ? ` (${openCount} peers connected)` : ''}.`);
    announceCapabilities(peerId);
  });

  connection.on('data', async (payload) => {
    handleIncomingData(payload, peerId);
  });

  connection.on('close', () => {
    handlePeerConnectionClosed(peerId);
  });

  connection.on('error', (error) => {
    clearConnectionTimeout(peerId);
    console.error('Data connection error:', error);
    logActivity(`Data connection error with ${normalizePeerLabel(peerId)}.`, 'Warning');
    finalizeConnection(false);
  });
}

function announceCapabilities(targetPeerId = null) {
  const payload = {
    type: 'capabilities',
    data: {
      webrtc: Boolean(window.RTCPeerConnection),
      bluetooth: Boolean(navigator.bluetooth),
      nfc: Boolean(window.NDEFReader),
      geolocation: Boolean(navigator.geolocation),
      nativeBridge: hasNativeBridge(),
    },
  };

  if (targetPeerId) {
    sendToPeer(targetPeerId, payload, { silent: true });
    return;
  }

  broadcastToConnections(payload, { silent: true });
}
function resetToSetup(options = {}) {
  const destroyPeer = options.destroyPeer !== false;

  if (state.isResetting) return;
  state.isResetting = true;

  try {
    state.dashboardMode = 'idle';
    state.wasHosting = false;
    state.lastRoomId = null;
    state.lastJoinRoomId = null;



    // Re-show join panel
    setElementHidden(elements.webJoinPanel, false);

    closeAllConnections();

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
    state.connectionTimers.clear();

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
  wrapper.className = `transfer-item ${direction}`;
  wrapper.dataset.direction = direction === 'outgoing' ? 'sent' : 'received';
  
  // Applied current filter if any
  if (state.historyFilter !== 'all' && wrapper.dataset.direction !== state.historyFilter) {
    wrapper.classList.add('hidden');
  }

  const head = document.createElement('div');
  head.className = 'transfer-head';

  // Preview container for completed files
  const previewThumb = document.createElement('div');
  previewThumb.className = 'transfer-preview-thumb';
  const icon = document.createElement('span');
  icon.className = `direction-icon ${direction}`;
  icon.textContent = direction === 'outgoing' ? '↑' : '↓';
  
  previewThumb.appendChild(icon);
  head.appendChild(previewThumb);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'transfer-title-wrap';

  const title = document.createElement('span');
  title.className = 'transfer-name';
  
  title.appendChild(document.createTextNode(name));
  titleWrap.appendChild(title);

  const headRight = document.createElement('div');
  headRight.className = 'transfer-head-right';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.id = `cancel-${id}`;
  cancelBtn.title = 'Cancel transfer';
  cancelBtn.textContent = 'X';
  cancelBtn.addEventListener('click', () => cancelTransfer(id, direction));

  headRight.appendChild(cancelBtn);

  head.appendChild(titleWrap);
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
  let targetPeerId = '';
  let rawTransferId = id;

  if (direction === 'outgoing') {
    const record = state.outgoingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      targetPeerId = record.peerId || '';
      rawTransferId = record.transferId || id;
      state.outgoingTransfers.delete(id);
    }
  } else {
    const record = state.incomingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      targetPeerId = record.peerId || '';
      rawTransferId = record.transferId || id;
    }
    state.incomingTransfers.delete(id);
  }

  if (targetPeerId) {
    sendToPeer(
      targetPeerId,
      { type: 'file-cancel', v2Type: mapLegacyEventToV2('file-cancel'), transferId: rawTransferId },
      { silent: true },
    );
  }

  markTransferCancelled(id);
  logActivity(`Transfer cancelled${targetPeerId ? ` for ${normalizePeerLabel(targetPeerId)}` : ''}.`);
}

function markTransferCancelled(id) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);
  const cancelBtn = document.getElementById(`cancel-${id}`);
  const item = document.getElementById(`transfer-${id}`);

  if (bar) { 
    bar.style.background = 'var(--danger, #c84334)'; 
    bar.style.width = '100%'; 
    bar.classList.remove('complete');
  }
  if (status) status.textContent = 'Cancelled';
  if (speed) speed.textContent = '-';
  if (cancelBtn) cancelBtn.remove();
  
  // Clean up Preview/Interactivity
  if (item) {
    item.classList.remove('completed');
    item.style.cursor = 'default';
    item.title = '';
    
    // Remove the action buttons
    const actions = item.querySelector('.transfer-actions');
    if (actions) actions.remove();

    // Remove the copy overlay (if any)
    const overlay = item.querySelector('.native-copy-overlay');
    if (overlay) overlay.remove();

    // Remove any link overlays
    const linkLayer = item.querySelector('a');
    if (linkLayer && linkLayer.style.position === 'absolute') linkLayer.remove();

    // Restore the preview thumb to empty (or hide it)
    const thumb = item.querySelector('.transfer-preview-thumb');
    if (thumb) {
        thumb.innerHTML = '';
        // If it was a video, the src should be cleared
        const video = thumb.querySelector('video');
        if (video) video.src = '';
    }
  }

  // Remove from archive list if it was there
  state.receivedArchiveItems = state.receivedArchiveItems.filter(i => i.id !== id);
  updateSaveAllButtonState();
}

function updateTransferProgress(id, progress, transferredBytes, totalBytes, startTs, statusLabel) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (!bar || !status || !speed) return;
  
  // Don't overwrite "Finished" / "Received" status once complete
  if (bar.classList.contains('complete')) return;

  const clamped = Math.max(0, Math.min(progress, 100));
  bar.style.width = `${clamped.toFixed(1)}%`;

  const left = `${statusLabel || ''} ${clamped.toFixed(1)}%`.trim();
  const right = `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}`;
  status.textContent = `${left} (${right})`;
  speed.textContent = formatThroughput(transferredBytes, startTs);

  // UX Improvement: Dynamic Tab Title for multitasking
  if (progress > 0 && progress < 100) {
    document.title = `(${Math.round(progress)}%) ShareVia`;
  }
}

function markTransferComplete(id, statusLabel) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (bar) bar.classList.add('complete');
  if (status && statusLabel) status.textContent = statusLabel;
  if (speed) speed.textContent = 'Finished';
  
  // UX Improvement: Reset tab title when transfer completes
  document.title = 'ShareVia - P2P File Transfer';
}

function addDownloadAction(id, url, fileName) {
  const item = document.getElementById(`transfer-${id}`);
  if (!item || item.querySelector('[data-download]')) return;

  const headRight = item.querySelector('.transfer-head-right');
  if (!headRight) return;

  const record = state.incomingTransfers.get(id) || 
                 state.outgoingTransfers.get(id) ||
                 state.receivedArchiveItems.find(i => i.id === id); 

  // Make the whole card clickable for preview
  item.classList.add('completed');
  item.style.cursor = 'pointer';
  item.title = 'Click to preview / open';
  item.addEventListener('click', (e) => {
    // Only allow preview if the card is actually marked as completed
    if (!item.classList.contains('completed')) return;
    
    // Don't trigger if clicking buttons specifically
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    window.open(url, '_blank');
  });

  // Handle Right-Click & Native Features
  if (record && record.mime && record.mime.startsWith('image/')) {
    // 1. Visible Thumbnail for Images
    const thumbContainer = item.querySelector('.transfer-preview-thumb');
    if (thumbContainer) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Preview';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      thumbContainer.appendChild(img);
    }

    // 2. Transparent Overlay for whole-card Right-Click "Copy Image"
    const nativeLayer = document.createElement('img');
    nativeLayer.src = url;
    nativeLayer.className = 'native-copy-overlay';
    nativeLayer.style.position = 'absolute';
    nativeLayer.style.inset = '0';
    nativeLayer.style.width = '100%';
    nativeLayer.style.height = '100%';
    nativeLayer.style.opacity = '0.01';
    nativeLayer.style.zIndex = '1';
    nativeLayer.style.pointerEvents = 'auto';
    item.style.position = 'relative';
    item.appendChild(nativeLayer);
  } else {
    // Handle Previews/Icons for other formats
    const thumbContainer = item.querySelector('.transfer-preview-thumb');
    if (thumbContainer) {
      const iconSpan = document.createElement('span');
      iconSpan.style.fontSize = '1.2rem';
      
      const mime = (record && record.mime) || '';
      const lowerName = (record.name || '').toLowerCase();
      if (mime.startsWith('audio/') || lowerName.endsWith('.mp3') || lowerName.endsWith('.wav')) {
        iconSpan.textContent = '🎵';
      } else if (mime.startsWith('video/')) {
        // Video Thumbnail: Use a video element at the 1-second mark
        const videoThumb = document.createElement('video');
        videoThumb.src = `${url}#t=1`; // Show frame at 1s
        videoThumb.muted = true;
        videoThumb.playsInline = true;
        videoThumb.style.width = '100%';
        videoThumb.style.height = '100%';
        videoThumb.style.objectFit = 'cover';
        thumbContainer.appendChild(videoThumb);
        return; // Skip the iconSpan append
      } else if (mime.includes('zip') || mime.includes('archive') || lowerName.endsWith('.zip') || lowerName.endsWith('.rar') || lowerName.endsWith('.7z')) {
        iconSpan.textContent = '📦';
      } else if (mime.startsWith('text/') || mime.includes('pdf') || mime.includes('document') || mime.includes('sheet') || mime.includes('presentation') || 
                 lowerName.endsWith('.pdf') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.docx') || lowerName.endsWith('.doc') || lowerName.endsWith('.pptx') || lowerName.endsWith('.txt')) {
        iconSpan.textContent = '📄';
      } else {
        iconSpan.textContent = '📁';
      }
      thumbContainer.appendChild(iconSpan);
    }

    // 2. Transparent Link Overlay for non-images (enables "Copy link address" menu)
    const linkLayer = document.createElement('a');
    linkLayer.href = url;
    linkLayer.download = record.name;
    linkLayer.style.position = 'absolute';
    linkLayer.style.inset = '0';
    linkLayer.style.width = '100%';
    linkLayer.style.height = '100%';
    linkLayer.style.zIndex = '1';
    linkLayer.style.cursor = 'pointer';
    item.style.position = 'relative';
    item.appendChild(linkLayer);
  }

  const buttonGroup = document.createElement('div');
  buttonGroup.className = 'transfer-actions';
  buttonGroup.style.display = 'flex';
  buttonGroup.style.gap = '6px';
  buttonGroup.dataset.download = '1';

  // Save Button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-secondary';
  saveBtn.style.fontSize = '0.72rem';
  saveBtn.style.padding = '4px 8px';
  saveBtn.style.height = 'auto';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent card click
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  });

  buttonGroup.appendChild(saveBtn);

  // Prepend to the right actions group
  headRight.prepend(buttonGroup);
}

async function handleIncomingData(payload, fromPeerId = '') {
  let data = payload;

  if (payload && payload.type === 'e2ee-wrap') {
    data = await decryptPayload(payload);
    if (!data) return; // Drop unauthenticated or corrupt data
  }

  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'file-start':
      handleIncomingFileStart(payload, fromPeerId);
      break;
    case 'file-chunk':
      handleIncomingFileChunk(payload, fromPeerId);
      break;
    case 'file-end':
      handleIncomingFileEnd(payload, fromPeerId);
      break;
    case 'file-ack':
      handleIncomingAck(payload, fromPeerId);
      break;
    case 'file-cancel':
      handleIncomingCancel(payload, fromPeerId);
      break;
    case 'text-note':
      handleIncomingNote(payload, fromPeerId);
      break;
    case 'capabilities':
      logActivity('Remote device capabilities received.');
      break;
    default:
      break;
  }
}

function handleIncomingCancel(payload, fromPeerId = '') {
  const transferId = String(payload.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);

  const outRecord = state.outgoingTransfers.get(transferKey);
  if (outRecord) {
    outRecord.cancelled = true;
  }
  const inRecord = state.incomingTransfers.get(transferKey);
  if (inRecord) {
    inRecord.cancelled = true;
  }

  state.incomingTransfers.delete(transferKey);
  state.outgoingTransfers.delete(transferKey);
  markTransferCancelled(transferKey);
  logActivity(`Remote peer cancelled a transfer${fromPeerId ? ` (${normalizePeerLabel(fromPeerId)})` : ''}.`);
}

function handleIncomingFileStart(payload, fromPeerId = '') {
  const transferId = String(payload.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const fromLabel = normalizePeerLabel(fromPeerId);
  const record = {
    transferId,
    peerId: fromPeerId,
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

  state.incomingTransfers.set(transferKey, record);
  createTransferUI(transferKey, `${payload.name} from ${fromLabel}`, payload.size, 'incoming', record.startedAt);
  logActivity(`Receiving file: ${payload.name} from ${fromLabel}`);
  playNotificationSound('file');

  // UX Improvement: Short vibration pulse for incoming file
  if (navigator.vibrate) navigator.vibrate(60);
}

function handleIncomingFileChunk(payload, fromPeerId = '') {
  const transferId = String(payload.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const record = state.incomingTransfers.get(transferKey);
  if (!record || record.cancelled) return;

  if (record.chunks[payload.index]) {
    return;
  }

  record.chunks[payload.index] = payload.chunk;
  record.receivedChunks += 1;
  record.receivedBytes += payload.chunk.byteLength;

  const progress = (record.receivedBytes / record.size) * 100;
  updateTransferProgress(
    transferKey,
    progress,
    record.receivedBytes,
    record.size,
    record.startTs,
    'Receiving',
  );

  if (record.receivedChunks % state.config.ackEvery === 0 || record.receivedChunks === record.totalChunks) {
    sendToPeer(fromPeerId, {
      type: 'file-ack',
      v2Type: mapLegacyEventToV2('file-ack'),
      transferId,
      receivedChunks: record.receivedChunks,
      receivedBytes: record.receivedBytes,
    }, { silent: true });
  }
}

function handleIncomingFileEnd(payload, fromPeerId = '') {
  const transferId = String(payload.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const record = state.incomingTransfers.get(transferKey);
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
  addDownloadAction(transferKey, url, record.name);
  pushReceivedArchiveItem(record.name, blob, Date.now());
  updateTransferProgress(transferKey, 100, record.size, record.size, record.startTs, 'Received');
  markTransferComplete(transferKey, `Received (${formatBytes(record.size)}) at ${formatClockTime(Date.now())}`);
  logActivity(`Received file: ${record.name}${fromPeerId ? ` from ${normalizePeerLabel(fromPeerId)}` : ''}`);
  addTransferHistoryEntry({
    direction: 'received',
    name: record.name,
    size: record.size,
    status: 'Completed',
    timestamp: Date.now(),
  });
  state.incomingTransfers.delete(transferKey);
}

function handleIncomingAck(payload, fromPeerId = '') {
  const transferId = String(payload.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const transfer = state.outgoingTransfers.get(transferKey);
  if (!transfer) return;

  transfer.ackedBytes = payload.receivedBytes;
  const progress = (payload.receivedBytes / transfer.size) * 100;

  updateTransferProgress(
    transferKey,
    progress,
    payload.receivedBytes,
    transfer.size,
    transfer.startTs,
    'Delivered',
  );
}

function handleIncomingNote(payload, fromPeerId = '') {
  if (!payload.text) return;
  const fromLabel = normalizePeerLabel(fromPeerId);
  addNoteToInbox(`${fromLabel}: ${payload.text}`, false);
  logActivity(`Text note received from ${fromLabel}.`);
  playNotificationSound('message');
}

function addNoteToInbox(text, isSelf) {
  const notesCollapsible = document.getElementById('notes-collapsible');
  const isCollapsed = notesCollapsible ? notesCollapsible.classList.contains('collapsed') : false;
  const isUnread = !isSelf && isCollapsed;

  const item = document.createElement('div');
  item.className = `note-item ${isSelf ? 'self' : ''} ${isUnread ? 'unread' : ''}`.trim();

  const content = document.createElement('div');
  content.className = 'note-content';
  content.textContent = text;

  const time = document.createElement('span');
  time.className = 'note-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  item.appendChild(content);
  item.appendChild(time);
  elements.noteInbox.prepend(item);

  if (isUnread) {
    state.unreadNotesCount++;
    updateNoteBadge();
  }
}

function updateNoteBadge() {
  if (!elements.noteBadge) return;
  if (state.unreadNotesCount > 0) {
    elements.noteBadge.textContent = state.unreadNotesCount;
    elements.noteBadge.classList.remove('hidden');
  } else {
    elements.noteBadge.classList.add('hidden');
  }
}

async function waitForBufferSpace(connection) {
  const channel = connection && connection.dataChannel ? connection.dataChannel : null;

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
  if (!hasOpenConnections()) {
    showCustomModal('Not Connected', 'Please connect to another device before attempting to send files.');
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

  const isMultiple = fileEntries.length > 1;
  const hasFolderShape =
    options.source === 'folder' ||
    fileEntries.some((entry) => String(entry.relativePath || '').includes('/'));

  if (hasFolderShape || isMultiple) {
    const zipped = await zipFileEntries(fileEntries);
    if (zipped) {
      logActivity(`${hasFolderShape ? 'Folder' : 'Multiple files'} bundled as ${zipped.name} (${fileEntries.length} items).`);
      await sendFile(zipped, { bundledFromFolder: true });
      return;
    }
  }

  for (const entry of fileEntries) {
    await sendFile(entry.file);
  }
}

function recoverSessionOnResume() {
  if (hasOpenConnections()) {
    return;
  }

  if (state.peer && !state.peer.destroyed) {
    if (state.peer.disconnected) {
      logActivity('Tab resumed. Reconnecting to signaling server...', 'System');
      updateStatus('Reconnecting', 'waiting');
      state.reconnectAttempts = 0;
      attemptReconnect();
    }
    return;
  }

  if (recoverHostRoomAfterSignalLoss()) {
    return;
  }

  recoverJoinRoomAfterSignalLoss();
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

async function sendFileToPeer(connection, file, options = {}) {
  if (!connection || !connection.open) {
    return;
  }

  const peerId = String(connection.peer || '').trim();
  const peerLabel = normalizePeerLabel(peerId);
  const transferId = createTransferId();
  const transferKey = makeTransferKey(peerId, transferId);
  const totalChunks = Math.ceil(file.size / state.config.chunkSize);
  const startedAt = Date.now();
  const transferName = options.fanoutCount > 1 ? `${file.name} -> ${peerLabel}` : file.name;

  const transferRecord = {
    id: transferKey,
    transferId,
    peerId,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sentBytes: 0,
    ackedBytes: 0,
    startedAt,
    startTs: performance.now(),
    totalChunks,
  };

  state.outgoingTransfers.set(transferKey, transferRecord);
  createTransferUI(transferKey, transferName, file.size, 'outgoing', startedAt);

  const started = safeSendToConnection(connection, {
    type: 'file-start',
    v2Type: mapLegacyEventToV2('file-start'),
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    timestamp: startedAt,
    totalChunks,
  });

  if (!started) {
    transferRecord.cancelled = true;
    markTransferCancelled(transferKey);
    return;
  }

  let offset = 0;

  for (let index = 0; index < totalChunks; index += 1) {
    if (transferRecord.cancelled || !connection.open) {
      markTransferCancelled(transferKey);
      return;
    }

    const end = Math.min(offset + state.config.chunkSize, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();

    await waitForBufferSpace(connection);

    if (transferRecord.cancelled || !connection.open) {
      markTransferCancelled(transferKey);
      return;
    }

    const sent = safeSendToConnection(connection, {
      type: 'file-chunk',
      v2Type: mapLegacyEventToV2('file-chunk'),
      transferId,
      index,
      chunk,
    }, { silent: true });

    if (!sent) {
      transferRecord.cancelled = true;
      markTransferCancelled(transferKey);
      return;
    }

    offset = end;
    transferRecord.sentBytes = offset;

    updateTransferProgress(
      transferKey,
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

  safeSendToConnection(connection, {
    type: 'file-end',
    v2Type: mapLegacyEventToV2('file-end'),
    transferId,
  }, { silent: true });

  const statusSuffix = options.bundledFromFolder ? 'Folder archive sent' : 'Sent';
  markTransferComplete(transferKey, `${statusSuffix} (${formatBytes(file.size)}) at ${formatClockTime(Date.now())}`);
  
  // Show preview for sender too
  const url = URL.createObjectURL(file);
  addDownloadAction(transferKey, url, file.name);

  logActivity(`Sent file: ${file.name} to ${peerLabel}`);
  addTransferHistoryEntry({
    direction: 'sent',
    name: transferName,
    size: file.size,
    status: 'Completed',
    timestamp: Date.now(),
  });
}

async function sendFile(file, options = {}) {
  const targets = getOpenConnections();
  if (!targets.length) {
    showCustomModal('Not Connected', 'Please connect to another device before attempting to send files.');
    return;
  }

  await Promise.all(targets.map((connection) => sendFileToPeer(connection, file, {
    ...options,
    fanoutCount: targets.length,
  })));
}

function queueNote() {
  const text = elements.textNote.value.trim();
  if (!text) {
    return;
  }

  const openCount = getOpenConnections().length;
  if (!openCount) {
    showCustomModal('Not Connected', 'You must be connected to a room before sending notes.');
    return;
  }

  safeSend({
    type: 'text-note',
    v2Type: mapLegacyEventToV2('text-note'),
    text,
  }, { silent: true });

  addNoteToInbox(`You: ${text}`, true);
  elements.textNote.value = '';
  logActivity(`Text note sent to ${openCount} peer(s).`);
}

function generateQRCode(roomId) {
  if (!elements.qrcodeContainer) return;
  
  elements.qrcodeContainer.classList.add('loading');
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

  // QRCode lib usually renders synchronously but populating the img src might take a tick
  // We check for the img and remove loading when it's ready
  const checkImgReady = setInterval(() => {
    const img = elements.qrcodeContainer.querySelector('img');
    if (img && img.src && img.src !== 'undefined') {
      elements.qrcodeContainer.classList.remove('loading');
      clearInterval(checkImgReady);
    }
  }, 50);

  // Safety timeout
  setTimeout(() => {
    elements.qrcodeContainer.classList.remove('loading');
    clearInterval(checkImgReady);
  }, 2000);
}

function extractRoomId(rawText) {
  if (!rawText) return null;

  const trimmed = String(rawText).trim();
  const codeRegex = /^[A-Z0-9]{6}$/i;
  
  if (codeRegex.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  try {
    const parsedUrl = new URL(trimmed);
    const hash = parsedUrl.hash.replace('#', '').trim();
    if (codeRegex.test(hash)) {
      return hash.toUpperCase();
    }

    const queryRoom = parsedUrl.searchParams.get('room');
    if (queryRoom && codeRegex.test(queryRoom)) {
      return queryRoom.toUpperCase();
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function startScanner() {
  const permissionStatus = await checkCameraPermission();
  
  if (permissionStatus === 'denied') {
    showCustomModal('Camera Access Blocked', 'You have blocked camera access. To fix this: \n\n1. Click the **Lock icon** in the address bar.\n2. Set **Camera** to **Allow**.\n3. Click "Try Again" below.');
    return;
  }

  lockScroll(true);
  elements.scannerModal.classList.remove('hidden');
  
  if (permissionStatus === 'prompt') {
    if (elements.qrSkeleton) elements.qrSkeleton.classList.add('hidden');
    // Show a pre-prompt UI inside the scanner area
    const readerEl = document.getElementById('qr-reader');
    readerEl.innerHTML = `
      <div class="permission-pre-prompt" style="text-align:center; padding: 40px 20px;">
        <div style="font-size: 3rem; margin-bottom: 20px;">📷</div>
        <p style="margin-bottom: 25px; color: rgba(255,255,255,0.9);">Camera access is required to scan QR codes.</p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button id="btn-request-perm" class="btn btn-secondary full">Allow Camera</button>
          <button id="btn-cancel-perm" class="btn btn-ghost full">Not Now</button>
        </div>
      </div>
    `;
    document.getElementById('btn-request-perm').onclick = () => {
      readerEl.innerHTML = '';
      if (elements.qrSkeleton) elements.qrSkeleton.classList.remove('hidden');
      initAndStartScanner();
    };
    document.getElementById('btn-cancel-perm').onclick = () => {
      stopScanner();
    };
    return;
  }

  initAndStartScanner();
}

async function checkCameraPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'prompt';
    const result = await navigator.permissions.query({ name: 'camera' });
    return result.state; // 'granted', 'denied', or 'prompt'
  } catch (e) {
    return 'prompt';
  }
}

async function initAndStartScanner() {
  if (!window.Html5Qrcode) {
    showCustomModal('Unavailable', 'QR scanner is unavailable in this browser.');
    return;
  }
  
  elements.scannerModal.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 100));

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

    if (elements.qrSkeleton) {
      elements.qrSkeleton.classList.add('hidden');
    }
    logActivity('Scanner started.');
  } catch (error) {
    console.error('Scanner start error:', error);
    state.scannerActive = false; // Reset state if start fails
    
    const errStr = String(error.name || error || '');
    if (errStr.includes('NotAllowedError') || errStr.includes('Permission denied')) {
      showCustomModal('Camera Access Denied', 'To scan QR codes, please click the **Lock icon** in your browser search bar (top left) and set Camera to **Allow**.');
    } else if (errStr.includes('NotFoundError') || errStr.includes('DevicesNotFound')) {
      showCustomModal('No Camera Found', 'We couldn\'t find a camera on this device. Please enter the room code manually.');
    } else {
      showCustomModal('Camera Error', 'We ran into a problem starting the camera. Please try refreshing or enter the code manually.');
    }
    stopScanner();
  }
}

function showCustomModal(title, message, options = {}) {
  const modal = document.getElementById('message-modal');
  const titleEl = document.getElementById('msg-modal-title');
  const bodyEl = document.getElementById('msg-modal-body');
  const closeBtn = document.getElementById('btn-close-msg-modal');
  const optBtn = document.getElementById('btn-opt-msg-modal');
  
  if (modal && titleEl && bodyEl) {
    lockScroll(true);
    titleEl.textContent = title;
    bodyEl.innerHTML = message.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    if (title === 'Camera Access Blocked') {
       closeBtn.textContent = 'Try Again';
       closeBtn.onclick = () => {
         modal.classList.add('hidden');
         startScanner();
       };
       if (optBtn) {
         optBtn.textContent = 'Close';
         optBtn.classList.remove('hidden');
         optBtn.onclick = () => {
           modal.classList.add('hidden');
           lockScroll(false);
         };
       }
    } else {
       closeBtn.textContent = 'Got it';
       closeBtn.onclick = () => {
         modal.classList.add('hidden');
         lockScroll(false);
       };
       if (optBtn) optBtn.classList.add('hidden');
    }

    modal.classList.remove('hidden');
  }
}

function stopScanner() {
  if (state.html5QrCode && state.scannerActive) {
    try {
      state.html5QrCode.stop().catch(() => {});
    } catch (e) {}
  }

  state.scannerActive = false;
  elements.scannerModal.classList.add('hidden');
  lockScroll(false);
  if (elements.qrSkeleton) {
    elements.qrSkeleton.classList.remove('hidden');
  }
}

function lockScroll(lock) {
  document.body.classList.toggle('no-scroll', lock);
}

function handleScanResult(decodedText) {
  const roomId = extractRoomId(decodedText);
  if (!roomId) {
    return;
  }

  // UX Improvement: Success vibration feedback
  if (navigator.vibrate) navigator.vibrate([40, 30, 40]);

  stopScanner();
  if (elements.webJoinIdInput) {
    elements.webJoinIdInput.value = roomId;
  }
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
  if (hasNativeBridge()) {
    return; // Native app uses local assets; no cache management needed
  }

  disableBrowserOfflineCache();
}

function bindEvents() {
  elements.btnDashboardSend && elements.btnDashboardSend.addEventListener('click', beginSendDiscovery);
  elements.btnWebJoin && elements.btnWebJoin.addEventListener('click', () => {
    const roomId = elements.webJoinIdInput.value.trim().toUpperCase();
    if (roomId) joinRoom(roomId);
  });
  elements.btnWebScan && elements.btnWebScan.addEventListener('click', startScanner);

  const btnCloseScanner = document.getElementById('btn-close-scanner');
  if (btnCloseScanner) btnCloseScanner.addEventListener('click', stopScanner);

  const btnCloseMsgModal = document.getElementById('btn-close-msg-modal');
  if (btnCloseMsgModal) {
    btnCloseMsgModal.onclick = () => {
      document.getElementById('message-modal').classList.add('hidden');
    };
  }

  if (elements.btnHeaderDisconnect) {
    elements.btnHeaderDisconnect.addEventListener('click', () => resetToSetup({ destroyPeer: true }));
  }

  document.getElementById('btn-advanced').addEventListener('click', toggleAdvancedPanel);
  elements.formSettings.addEventListener('submit', (event) => {
    event.preventDefault();
    saveAdvancedConfig();
  });

  elements.historyTabs.forEach((button) => {
    button.addEventListener('click', () => {
      setHistoryFilter(button.dataset.historyTab || 'all');
    });
  });
  elements.btnShowMyCode && elements.btnShowMyCode.addEventListener('click', hostRoom);
  elements.btnShareOnlineLink && elements.btnShareOnlineLink.addEventListener('click', shareRoomLink);



  document.getElementById('btn-copy-code').addEventListener('click', (e) => {
    copyText(state.myId, 'Room code', e.currentTarget);
  });

  document.getElementById('btn-copy-link').addEventListener('click', (e) => {
    copyText(generateJoinUrl(state.myId), 'Join link', e.currentTarget);
  });

  elements.btnSaveAll && elements.btnSaveAll.addEventListener('click', saveAllReceivedArchive);

  elements.historyTabs.forEach((button) => {
    button.addEventListener('click', () => {
      setHistoryFilter(button.dataset.historyTab || 'all');
    });
  });

  elements.webJoinIdInput && elements.webJoinIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom(elements.webJoinIdInput.value);
    }
  });

  elements.btnSendNote.addEventListener('click', queueNote);

  const btnToggleNotes = document.getElementById('btn-toggle-notes');
  const notesCollapsible = document.getElementById('notes-collapsible');
  if (btnToggleNotes && notesCollapsible) {
    btnToggleNotes.onclick = () => {
      const isCollapsed = notesCollapsible.classList.toggle('collapsed');
      btnToggleNotes.parentElement.classList.toggle('collapsed-container', isCollapsed);
      
      if (!isCollapsed) {
        state.unreadNotesCount = 0;
        updateNoteBadge();
        // Clear all unread highlights
        document.querySelectorAll('.note-item.unread').forEach(el => el.classList.remove('unread'));
      }
    };
  }

  elements.textNote.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
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
  if (initializeDone) {
    return;
  }
  initializeDone = true;

  configurePlatformMode();

  applyConfigToUI();
  // syncIceConfigFromV2();
  updateTransportBadge();
  updateStatus('Disconnected', 'disconnected');
  updateInteractionState(false);

  bindEvents();
  setHistoryFilter('all');
  updateSaveAllButtonState();
  applyNativeSafeTopInset();
  window.addEventListener('resize', applyNativeSafeTopInset);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyNativeSafeTopInset);
    window.visualViewport.addEventListener('scroll', applyNativeSafeTopInset);
  }
  registerServiceWorker();

  // Wake up signaling server early (Render.com free tier cold start mitigation)
  if (state.config.signalingHost) {
    const protocol = state.config.signalingSecure ? 'https' : 'http';
    fetch(`${protocol}://${state.config.signalingHost}${state.config.signalingPath}`).catch(() => {});
  }

  setupSidebarEvents();

  // Mobile tab suspension resilience: when user returns from WhatsApp etc.,
  // check if the peer is still alive and reconnect if needed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    recoverSessionOnResume();
  });

  const roomIdFromUrl = extractRoomId(window.location.href);
  if (roomIdFromUrl) {
    if (elements.webJoinIdInput) {
      elements.webJoinIdInput.value = roomIdFromUrl;
    }
    joinRoom(roomIdFromUrl);

  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}






function setupSidebarEvents() {
  if (!elements.btnMenuOpen) return;
  
  // Load initial profile data to UI
  if (state.profileName) elements.profileNameInput.value = state.profileName;
  if (state.profileAvatar) elements.profileAvatarPreview.src = state.profileAvatar;

  // Open/Close
  elements.btnMenuOpen.addEventListener('click', () => {
    elements.sidebarOverlay.classList.remove('hidden');
    elements.sidebarMenu.classList.remove('closed');
  });
  
  const closeMenu = () => {
    elements.sidebarOverlay.classList.add('hidden');
    elements.sidebarMenu.classList.add('closed');
  };
  
  elements.btnMenuClose.addEventListener('click', closeMenu);
  elements.sidebarOverlay.addEventListener('click', closeMenu);
  
  // Save Profile
  elements.btnSaveProfile.addEventListener('click', () => {
    const name = elements.profileNameInput.value.trim();
    state.profileName = name;
    localStorage.setItem('sv_profile_name', name);
    showCustomModal('Success', 'Your profile settings have been saved successfully.');
    elements.btnSaveProfile.textContent = "Saved";
    setTimeout(() => { elements.btnSaveProfile.textContent = "Save"; }, 2000);
  });
  
  // Avatar logic
  elements.btnChangeAvatar.addEventListener('click', () => {
    elements.profileAvatarInput.click();
  });
  
  elements.profileAvatarInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const url = event.target.result;
        state.profileAvatar = url;
        localStorage.setItem('sv_profile_avatar', url);
        elements.profileAvatarPreview.src = url;
    };
    reader.readAsDataURL(file);
  });
  
}
