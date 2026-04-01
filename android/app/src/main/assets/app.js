const DEFAULT_CONFIG = {
  signalingHost: '',
  signalingPort: '',
  signalingPath: '/peerjs',
  signalingSecure: true,
  chunkSize: 65536,
  ackEvery: 32,
};

const STORAGE_KEY = 'connectvia_config_v2';
const CHANNEL_BUFFER_LIMIT = 2 * 1024 * 1024;

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
};

const elements = {
  setupSection: document.getElementById('setup-section'),
  hostingSection: document.getElementById('hosting-section'),
  shareSection: document.getElementById('share-section'),
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
  chunkSize: document.getElementById('chunk-size'),
  ackEvery: document.getElementById('ack-every'),
  capWebrtc: document.getElementById('cap-webrtc'),
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

function applyConfigToUI() {
  elements.signalHost.value = state.config.signalingHost;
  elements.signalPort.value = state.config.signalingPort;
  elements.signalPath.value = state.config.signalingPath;
  elements.signalSecure.checked = Boolean(state.config.signalingSecure);
  elements.chunkSize.value = String(state.config.chunkSize);
  elements.ackEvery.value = String(state.config.ackEvery);
}

function readConfigFromUI() {
  const pathRaw = (elements.signalPath.value || '/peerjs').trim();
  state.config.signalingHost = elements.signalHost.value.trim();
  state.config.signalingPort = elements.signalPort.value.trim();
  state.config.signalingPath = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
  state.config.signalingSecure = elements.signalSecure.checked;
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

  return options;
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
  element.classList.remove('supported', 'unavailable');
  element.classList.add(supported ? 'supported' : 'unavailable');
  element.textContent = `${label}: ${detail}`;
}

function detectCapabilities() {
  setCapabilityChip(elements.capWebrtc, 'WebRTC', Boolean(window.RTCPeerConnection), window.RTCPeerConnection ? 'supported' : 'missing');
  setCapabilityChip(elements.capBluetooth, 'Bluetooth', Boolean(navigator.bluetooth), navigator.bluetooth ? 'supported' : 'native app preferred');
  setCapabilityChip(elements.capNfc, 'NFC', Boolean(window.NDEFReader), window.NDEFReader ? 'supported' : 'native app preferred');
  setCapabilityChip(elements.capLocation, 'Location', Boolean(navigator.geolocation), navigator.geolocation ? 'supported' : 'not available');
  setCapabilityChip(elements.capNative, 'Native Bridge', hasNativeBridge(), hasNativeBridge() ? 'available' : 'web mode');
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

function invokeNativeAction(action) {
  try {
    if (window.NativeP2PBridge && typeof window.NativeP2PBridge[action] === 'function') {
      window.NativeP2PBridge[action]();
      logActivity(`Native action requested: ${action}`);
      return;
    }

    if (window.NativeP2PBridge && typeof window.NativeP2PBridge.postMessage === 'function') {
      window.NativeP2PBridge.postMessage(JSON.stringify({ action }));
      logActivity(`Native bridge postMessage requested: ${action}`);
      return;
    }

    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.NativeP2PBridge) {
      window.webkit.messageHandlers.NativeP2PBridge.postMessage({ action });
      logActivity(`iOS bridge action requested: ${action}`);
      return;
    }

    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage({ action });
      logActivity(`Windows bridge action requested: ${action}`);
      return;
    }
  } catch (error) {
    console.error(error);
    logActivity(`Native action failed: ${action}`, 'Warning');
    return;
  }

  logActivity(`Native bridge unavailable for action: ${action}`, 'Warning');
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
    elements.joinIdInput.value = String(data.code).trim();
    logActivity(`Native pairing code received: ${data.code}`);
    return;
  }

  if (data.type === 'location-room-hint' && data.code) {
    elements.joinIdInput.value = String(data.code).trim();
    logActivity('Location-assisted room suggestion received.');
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
    elements.myPeerId.textContent = id;
    generateQRCode(id);

    if (state.pendingJoinId) {
      const target = state.pendingJoinId;
      state.pendingJoinId = null;
      logActivity(`Connecting to room ${target}.`);
      const outgoing = state.peer.connect(target, { reliable: true });
      setupConnection(outgoing, 'Outgoing');
      updateStatus('Connecting', 'waiting');
      return;
    }

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

function hostRoom() {
  const roomId = generateRoomCode();
  state.pendingJoinId = null;
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

  state.pendingJoinId = roomId;
  updateStatus('Preparing', 'waiting');
  logActivity(`Preparing to join room ${roomId}.`);
  initPeer();
}

function setupConnection(connection, sourceLabel) {
  state.conn = connection;

  connection.on('open', () => {
    showSection(elements.shareSection);
    elements.remotePeerId.textContent = connection.peer;
    updateStatus('Connected', 'connected');
    logActivity(`${sourceLabel} connection open with ${connection.peer}.`);
    announceCapabilities();
  });

  connection.on('data', (payload) => {
    handleIncomingData(payload);
  });

  connection.on('close', () => {
    logActivity('Peer disconnected.');
    resetToSetup({ destroyPeer: true });
  });

  connection.on('error', (error) => {
    console.error('Data connection error:', error);
    logActivity('Data connection error.', 'Warning');
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

function createTransferUI(id, name, size, direction) {
  const existing = document.getElementById(`transfer-${id}`);
  if (existing) return existing;

  const wrapper = document.createElement('article');
  wrapper.id = `transfer-${id}`;
  wrapper.className = 'transfer-item';

  const head = document.createElement('div');
  head.className = 'transfer-head';

  const title = document.createElement('span');
  title.className = 'transfer-name';
  title.textContent = `${direction === 'outgoing' ? 'Sending' : 'Receiving'} — ${name}`;

  const headRight = document.createElement('div');
  headRight.className = 'transfer-head-right';

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'transfer-meta';
  sizeLabel.textContent = formatBytes(size);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.id = `cancel-${id}`;
  cancelBtn.title = 'Cancel transfer';
  cancelBtn.innerHTML = '✕';
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
  if (speed) speed.textContent = '—';
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
    totalChunks: Number(payload.totalChunks),
    receivedChunks: 0,
    receivedBytes: 0,
    startTs: performance.now(),
    chunks: new Array(Number(payload.totalChunks)),
  };

  state.incomingTransfers.set(payload.transferId, record);
  createTransferUI(payload.transferId, payload.name, payload.size, 'incoming');
  logActivity(`Receiving file: ${payload.name}`);
}

function handleIncomingFileChunk(payload) {
  const record = state.incomingTransfers.get(payload.transferId);
  if (!record) return;

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
  updateTransferProgress(payload.transferId, 100, record.size, record.size, record.startTs, 'Received');
  markTransferComplete(payload.transferId, `Received (${formatBytes(record.size)})`);
  logActivity(`Received file: ${record.name}`);
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

async function sendSelectedFiles(fileList, items) {
  if (!state.conn || !state.conn.open) {
    alert('Connect to a room before sending files.');
    return;
  }

  const files = [];
  
  if (items && items.length > 0) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        await getFilesFromEntry(entry, files);
      }
    }
  } else {
    for (const file of Array.from(fileList || [])) {
      if (file.size === 0 && !file.type) continue;
      files.push(file);
    }
  }

  if (!files.length) {
    return;
  }

  for (const file of files) {
    await sendFile(file);
  }
}

async function getFilesFromEntry(entry, fileList) {
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    fileList.push(file);
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
    for (const e of entries) {
      await getFilesFromEntry(e, fileList);
    }
  }
}

async function sendFile(file) {
  const transferId = createTransferId();
  const totalChunks = Math.ceil(file.size / state.config.chunkSize);
  const transferRecord = {
    id: transferId,
    size: file.size,
    sentBytes: 0,
    ackedBytes: 0,
    startTs: performance.now(),
    totalChunks,
  };

  state.outgoingTransfers.set(transferId, transferRecord);
  createTransferUI(transferId, file.name, file.size, 'outgoing');

  safeSend({
    type: 'file-start',
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
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

  markTransferComplete(transferId, `Sent (${formatBytes(file.size)})`);
  logActivity(`Sent file: ${file.name}`);
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
  elements.advancedPanel.classList.toggle('hidden');
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
  document.getElementById('btn-host').addEventListener('click', hostRoom);
  document.getElementById('btn-scan').addEventListener('click', startScanner);
  document.getElementById('btn-close-scanner').addEventListener('click', stopScanner);
  document.getElementById('btn-cancel-host').addEventListener('click', () => resetToSetup({ destroyPeer: true }));
  document.getElementById('btn-join').addEventListener('click', () => joinRoom(elements.joinIdInput.value));
  document.getElementById('btn-disconnect').addEventListener('click', () => resetToSetup({ destroyPeer: true }));
  document.getElementById('btn-advanced').addEventListener('click', toggleAdvancedPanel);
  document.getElementById('btn-save-config').addEventListener('click', saveAdvancedConfig);
  document.getElementById('btn-send-note').addEventListener('click', queueNote);

  document.getElementById('btn-native-bluetooth').addEventListener('click', () => invokeNativeAction('startBluetoothPairing'));
  document.getElementById('btn-native-nfc').addEventListener('click', () => invokeNativeAction('startNfcPairing'));
  document.getElementById('btn-native-location').addEventListener('click', () => invokeNativeAction('startLocationPairing'));

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    copyText(state.myId, 'Room code');
  });

  document.getElementById('btn-copy-link').addEventListener('click', () => {
    copyText(generateJoinUrl(state.myId), 'Join link');
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
    await sendSelectedFiles(elements.fileInput.files);
    elements.fileInput.value = '';
  });

  elements.folderInput.addEventListener('change', async () => {
    await sendSelectedFiles(elements.folderInput.files);
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
    await sendSelectedFiles(event.dataTransfer.files, event.dataTransfer.items);
  });
}

function initialize() {
  applyConfigToUI();
  updateTransportBadge();
  updateStatus('Disconnected', 'disconnected');
  detectCapabilities();
  bindEvents();
  registerServiceWorker();

  const roomIdFromUrl = extractRoomId(window.location.href);
  if (roomIdFromUrl) {
    elements.joinIdInput.value = roomIdFromUrl;
    joinRoom(roomIdFromUrl);
  }
}

window.addEventListener('load', initialize);
