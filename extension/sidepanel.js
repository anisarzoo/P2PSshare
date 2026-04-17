let peer = null;
let myId = null;
let pendingJoinId = null;
let hostingMode = false;
const connections = new Map();
const connectionTimers = new Map();

// DOM Elements
const setupSection = document.getElementById('setup-section');
const hostingSection = document.getElementById('hosting-section');
const shareSection = document.getElementById('share-section');
const statusBadge = document.getElementById('status-badge');
const myPeerIdEl = document.getElementById('my-peer-id');
const remotePeerIdEl = document.getElementById('remote-peer-id');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const transferList = document.getElementById('transfer-list');
const joinIdInput = document.getElementById('join-id');
const qrcodeContainer = document.getElementById('qrcode-container');
const btnPickFiles = document.getElementById('btn-pick-files');
const btnPickFolder = document.getElementById('btn-pick-folder');
const textNote = document.getElementById('text-note');
const btnSendNote = document.getElementById('btn-send-note');
const noteInbox = document.getElementById('note-inbox');

// Web app URL for QR codes
const WEB_APP_URL = "https://sharevia.netlify.app";

// Signaling Config — matches web app
const SIGNAL_CONFIG = {
  host: 'sharevia-signal.onrender.com',
  port: 443,
  path: '/peerjs',
  secure: true,
  debug: 1
};

// Transfer config — matches web app
const CHUNK_SIZE = 65536; // 64KB
const CHANNEL_BUFFER_LIMIT = 2 * 1024 * 1024;
const CONNECTION_TIMEOUT = 15000;

// Transfer state
const incomingTransfers = new Map();
const outgoingTransfers = new Map();
let isResetting = false;

// ZIP Engine
const JSZIP_CDN_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
let jsZipLoadPromise = null;

// --- Helpers ---

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatFileTimestamp(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}${(d.getMonth() + 1).toString().padStart(2, '0')}${d.getDate().toString().padStart(2, '0')}-${d.getHours().toString().padStart(2, '0')}${d.getMinutes().toString().padStart(2, '0')}`;
}

function sanitizeArchivePath(path, fallbackName) {
  if (!path) return fallbackName || 'file';
  return path.split(/[\\/]/).filter(p => p && p !== '..').join('/');
}

async function getJsZipCtor() {
  if (window.JSZip) return window.JSZip;
  if (!jsZipLoadPromise) {
    jsZipLoadPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = JSZIP_CDN_URL;
      script.async = true;
      script.onload = () => resolve(window.JSZip || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
      setTimeout(() => resolve(window.JSZip || null), 4000);
    });
  }
  const loaded = await jsZipLoadPromise;
  if (loaded) return loaded;
  alert('ZIP engine unavailable. Bundle transfer disabled.');
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytes, startTs) {
  const elapsed = Math.max((performance.now() - startTs) / 1000, 0.05);
  return `${formatBytes(bytes / elapsed)}/s`;
}

function createTransferId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePeerLabel(peerId) {
  const raw = String(peerId || '').trim();
  return raw || 'Unknown peer';
}

function makeTransferKey(peerId, transferId) {
  return `${String(peerId || 'unknown')}::${String(transferId || '')}`;
}

function getOpenConnections() {
  return Array.from(connections.values()).filter((connection) => connection && connection.open);
}

function hasOpenConnections() {
  return getOpenConnections().length > 0;
}

function updateConnectedLabel() {
  const open = getOpenConnections();
  if (!open.length) {
    remotePeerIdEl.textContent = '------';
    return;
  }

  if (open.length === 1) {
    remotePeerIdEl.textContent = normalizePeerLabel(open[0].peer);
    return;
  }

  remotePeerIdEl.textContent = `${open.length} peers`;
}

function safeSendToConnection(connection, payload) {
  if (!connection || !connection.open) return false;
  try {
    connection.send(payload);
    return true;
  } catch (error) {
    console.error('Send failed:', error);
    return false;
  }
}

function sendToPeer(peerId, payload) {
  const key = String(peerId || '').trim();
  if (!key) return false;
  const connection = connections.get(key);
  return safeSendToConnection(connection, payload);
}

function clearConnectionTimeout(peerId) {
  const key = String(peerId || '').trim();
  if (!key) return;
  const timer = connectionTimers.get(key);
  if (timer) {
    clearTimeout(timer);
  }
  connectionTimers.delete(key);
}

function closeAllConnections() {
  connections.forEach((connection, peerId) => {
    clearConnectionTimeout(peerId);
    connection.__shareviaClosing = true;
    try {
      connection.close();
    } catch (error) {
      console.warn('Connection close failed:', error);
    }
  });
  connections.clear();
  updateConnectedLabel();
}

// --- Initialization ---

function initPeer(id = null) {
  closeAllConnections();
  if (peer) {
    try {
      peer.destroy();
    } catch (error) {
      console.warn('Peer destroy failed:', error);
    }
  }

  const peerId = id || generateRoomCode();
  
  // Show the code and QR immediately to improve perceived speed
  myPeerIdEl.textContent = peerId;
  myPeerIdEl.classList.add('loading');
  generateQRCode(peerId);

  peer = new Peer(peerId, SIGNAL_CONFIG);

  peer.on('open', (openId) => {
    myId = openId;
    myPeerIdEl.textContent = openId;
    myPeerIdEl.classList.remove('loading');
    generateQRCode(openId);

    if (pendingJoinId) {
      const target = pendingJoinId;
      pendingJoinId = null;
      updateStatus('Connecting', 'waiting');
      const outgoing = peer.connect(target, { reliable: true });
      setupConnection(outgoing, 'Outgoing');
      return;
    }

    updateStatus('Waiting', 'waiting');
  });

  peer.on('connection', (connection) => {
    setupConnection(connection, 'Incoming');
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    if (err && err.type === 'peer-unavailable') {
      alert('Room not found. Check the code and try again.');
    } else {
      alert(`Connection error: ${err && err.type ? err.type : 'unknown'}`);
    }
    resetToSetup({ destroyPeer: true });
  });

  peer.on('disconnected', () => {
    updateStatus('Reconnecting', 'waiting');
    try {
      peer.reconnect();
    } catch (error) {
      console.warn('Peer reconnect failed:', error);
    }
  });

  peer.on('close', () => {
    if (!hasOpenConnections()) {
      updateStatus('Disconnected', 'disconnected');
    }
  });
}

function generateQRCode(id) {
  if (!qrcodeContainer) return;
  qrcodeContainer.classList.add('loading');
  qrcodeContainer.innerHTML = '';
  const joinUrl = `${WEB_APP_URL}/#${id}`;

  new QRCode(qrcodeContainer, {
    text: joinUrl,
    width: 140,
    height: 140,
    colorDark: "#0f3f3a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  const checkImgReady = setInterval(() => {
    const img = qrcodeContainer.querySelector('img');
    if (img && img.src && img.src !== 'undefined') {
      qrcodeContainer.classList.remove('loading');
      clearInterval(checkImgReady);
    }
  }, 50);

  setTimeout(() => {
    qrcodeContainer.classList.remove('loading');
    clearInterval(checkImgReady);
  }, 2000);
}

// --- Connection ---

function clearTransfersForPeer(peerId) {
  const key = String(peerId || '').trim();
  if (!key) return;

  outgoingTransfers.forEach((record, transferKey) => {
    if (record && record.peerId === key) {
      record.cancelled = true;
      outgoingTransfers.delete(transferKey);
      markTransferCancelled(transferKey);
    }
  });

  incomingTransfers.forEach((record, transferKey) => {
    if (record && record.peerId === key) {
      record.cancelled = true;
      incomingTransfers.delete(transferKey);
      markTransferCancelled(transferKey);
    }
  });
}

function handleConnectionClosed(peerId) {
  const key = String(peerId || '').trim();
  if (key) {
    connections.delete(key);
    clearConnectionTimeout(key);
    clearTransfersForPeer(key);
  }

  updateConnectedLabel();

  const openCount = getOpenConnections().length;
  if (openCount > 0) {
    updateStatus('Connected', 'connected');
    return;
  }

  if (hostingMode && peer && !peer.destroyed && myId) {
    showSection(hostingSection);
    updateStatus('Waiting', 'waiting');
    return;
  }

  resetToSetup({ destroyPeer: true });
}

function setupConnection(connection, sourceLabel = 'Incoming') {
  const peerId = String(connection && connection.peer ? connection.peer : '').trim();
  if (!peerId) {
    try {
      connection.close();
    } catch (error) {
      console.warn('Unnamed connection close failed:', error);
    }
    return;
  }

  const existing = connections.get(peerId);
  if (existing && existing !== connection) {
    try {
      existing.close();
    } catch (error) {
      console.warn('Existing connection close failed:', error);
    }
  }

  connections.set(peerId, connection);
  updateConnectedLabel();

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (connection.__shareviaClosing) {
      connections.delete(peerId);
      clearConnectionTimeout(peerId);
      return;
    }
    handleConnectionClosed(peerId);
  };

  clearConnectionTimeout(peerId);
  const timer = setTimeout(() => {
    if (connection.__shareviaClosing) {
      return;
    }
    if (!connection.open) {
      try {
        connection.close();
      } catch (error) {
        console.warn('Timed out connection close failed:', error);
      }
      finalize();
      if (!hostingMode) {
        alert('Connection timed out. The host may have closed the room.');
      }
    }
  }, CONNECTION_TIMEOUT);
  connectionTimers.set(peerId, timer);

  connection.on('open', () => {
    connection.__shareviaClosing = false;
    clearConnectionTimeout(peerId);
    connections.set(peerId, connection);
    showSection(shareSection);
    updateConnectedLabel();
    updateStatus('Connected', 'connected');
    const openCount = getOpenConnections().length;
    console.info(`${sourceLabel} connection open with ${peerId}. Connected peers: ${openCount}`);
  });

  connection.on('data', (data) => {
    handleIncomingData(data, peerId);
  });

  connection.on('close', () => {
    clearConnectionTimeout(peerId);
    finalize();
  });

  connection.on('error', (err) => {
    clearConnectionTimeout(peerId);
    console.error('Connection error:', err);
    finalize();
  });
}

// --- Incoming Data Handler (compatible with web app protocol) ---

function handleIncomingData(data, fromPeerId = '') {
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'file-start':
      handleIncomingFileStart(data, fromPeerId);
      break;
    case 'file-chunk':
      handleIncomingFileChunk(data, fromPeerId);
      break;
    case 'file-end':
      handleIncomingFileEnd(data, fromPeerId);
      break;
    case 'file-ack':
      handleIncomingAck(data, fromPeerId);
      break;
    case 'file-cancel':
      handleIncomingCancel(data, fromPeerId);
      break;
    case 'text-note':
      handleIncomingNote(data, fromPeerId);
      break;
    case 'capabilities':
    default:
      break;
  }
}

function handleIncomingCancel(data, fromPeerId = '') {
  const transferId = String(data.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);

  const outRecord = outgoingTransfers.get(transferKey);
  if (outRecord) {
    outRecord.cancelled = true;
  }
  const inRecord = incomingTransfers.get(transferKey);
  if (inRecord) {
    inRecord.cancelled = true;
  }
  incomingTransfers.delete(transferKey);
  outgoingTransfers.delete(transferKey);
  markTransferCancelled(transferKey);
}

function handleIncomingFileStart(data, fromPeerId = '') {
  const transferId = String(data.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const peerLabel = normalizePeerLabel(fromPeerId);

  const record = {
    transferId,
    peerId: fromPeerId,
    name: data.name,
    size: Number(data.size),
    mime: data.mime || 'application/octet-stream',
    totalChunks: Number(data.totalChunks),
    receivedChunks: 0,
    receivedBytes: 0,
    startTs: performance.now(),
    chunks: new Array(Number(data.totalChunks)),
  };

  incomingTransfers.set(transferKey, record);
  createTransferUI(transferKey, `${data.name} from ${peerLabel}`, data.size, 'incoming');
}

function handleIncomingFileChunk(data, fromPeerId = '') {
  const transferId = String(data.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const record = incomingTransfers.get(transferKey);
  if (!record || record.cancelled) return;
  if (record.chunks[data.index]) return;

  record.chunks[data.index] = data.chunk;
  record.receivedChunks += 1;
  record.receivedBytes += data.chunk.byteLength;

  const progress = (record.receivedBytes / record.size) * 100;
  updateTransferProgress(transferKey, progress, record.receivedBytes, record.size, record.startTs, 'Receiving');

  if (record.receivedChunks % 32 === 0 || record.receivedChunks === record.totalChunks) {
    sendToPeer(fromPeerId, {
      type: 'file-ack',
      transferId,
      receivedChunks: record.receivedChunks,
      receivedBytes: record.receivedBytes,
    });
  }
}

function handleIncomingFileEnd(data, fromPeerId = '') {
  const transferId = String(data.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const record = incomingTransfers.get(transferKey);
  if (!record) return;

  if (record.receivedChunks !== record.totalChunks) {
    console.warn('Transfer incomplete for', record.name);
    return;
  }

  const chunks = [];
  for (let i = 0; i < record.totalChunks; i++) {
    if (!record.chunks[i]) {
      console.warn('Missing chunk', i + 1);
      return;
    }
    chunks.push(record.chunks[i]);
  }

  const blob = new Blob(chunks, { type: record.mime });
  const url = URL.createObjectURL(blob);

  updateTransferProgress(transferKey, 100, record.size, record.size, record.startTs, 'Received');
  markTransferComplete(transferKey, `Received (${formatBytes(record.size)})`);
  addDownloadAction(transferKey, url, record.name);

  const a = document.createElement('a');
  a.href = url;
  a.download = record.name;
  a.click();

  incomingTransfers.delete(transferKey);
}

function handleIncomingAck(data, fromPeerId = '') {
  const transferId = String(data.transferId || '').trim();
  if (!transferId) return;
  const transferKey = makeTransferKey(fromPeerId, transferId);
  const record = outgoingTransfers.get(transferKey);
  if (!record) return;

  record.ackedBytes = data.receivedBytes;
  const progress = (data.receivedBytes / record.size) * 100;
  updateTransferProgress(transferKey, progress, data.receivedBytes, record.size, record.startTs, 'Delivered');
}

// --- Quick Messaging ---

function handleIncomingNote(data, fromPeerId = '') {
  if (!data.text) return;
  const fromLabel = normalizePeerLabel(fromPeerId);
  addNoteToInbox(`${fromLabel}: ${data.text}`, false);
}

function addNoteToInbox(text, isSelf) {
  const item = document.createElement('div');
  item.className = `note-item ${isSelf ? 'self' : ''}`.trim();
  item.textContent = text;
  noteInbox.prepend(item);
}

function queueNote() {
  const text = textNote.value.trim();
  if (!text) return;

  const targets = getOpenConnections();
  if (!targets.length) {
    alert('Connect to a device first to send notes.');
    return;
  }

  targets.forEach(connection => {
    safeSendToConnection(connection, {
      type: 'text-note',
      text: text
    });
  });

  addNoteToInbox(`You: ${text}`, true);
  textNote.value = '';
}

// --- Send Files (compatible with web app protocol) ---

async function waitForBufferSpace(connection) {
  const channel = connection && connection.dataChannel ? connection.dataChannel : null;
  if (!channel) return;
  while (channel.bufferedAmount > CHANNEL_BUFFER_LIMIT) {
    await sleep(20);
  }
}

async function sendFileToPeer(connection, file, options = {}) {
  if (!connection || !connection.open) return;

  const peerId = String(connection.peer || '').trim();
  const peerLabel = normalizePeerLabel(peerId);
  const transferId = createTransferId();
  const transferKey = makeTransferKey(peerId, transferId);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const transferName = options.fanoutCount > 1 ? `${file.name} -> ${peerLabel}` : file.name;

  const record = {
    id: transferKey,
    transferId,
    peerId,
    size: file.size,
    sentBytes: 0,
    ackedBytes: 0,
    startTs: performance.now(),
    totalChunks,
  };

  outgoingTransfers.set(transferKey, record);
  createTransferUI(transferKey, transferName, file.size, 'outgoing');

  const started = safeSendToConnection(connection, {
    type: 'file-start',
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    totalChunks,
  });

  if (!started) {
    record.cancelled = true;
    markTransferCancelled(transferKey);
    return;
  }

  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (record.cancelled || !connection.open) {
      markTransferCancelled(transferKey);
      return;
    }

    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();

    await waitForBufferSpace(connection);

    if (record.cancelled || !connection.open) {
      markTransferCancelled(transferKey);
      return;
    }

    const sent = safeSendToConnection(connection, {
      type: 'file-chunk',
      transferId,
      index: i,
      chunk,
    });

    if (!sent) {
      record.cancelled = true;
      markTransferCancelled(transferKey);
      return;
    }

    offset = end;
    record.sentBytes = offset;

    updateTransferProgress(transferKey, (offset / file.size) * 100, offset, file.size, record.startTs, 'Sending');

    if (i % 32 === 0) await sleep(0);
  }

  safeSendToConnection(connection, { type: 'file-end', transferId });
  markTransferComplete(transferKey, `Sent (${formatBytes(file.size)})`);
}

async function sendFile(file) {
  const targets = getOpenConnections();
  if (!targets.length) return;
  await Promise.all(targets.map((connection) => sendFileToPeer(connection, file, { fanoutCount: targets.length })));
}

// --- UI Helpers ---

function updateStatus(text, className) {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge ${className}`;
}

function showSection(section) {
  [setupSection, hostingSection, shareSection].forEach(s => {
    s.classList.add('hidden');
    s.classList.remove('active');
  });
  section.classList.remove('hidden');
  section.classList.add('active');
}

function resetToSetup(options = {}) {
  const destroyPeer = options.destroyPeer !== false;
  if (isResetting) return;
  isResetting = true;

  try {
    closeAllConnections();
    incomingTransfers.clear();
    outgoingTransfers.clear();
    connectionTimers.clear();
    pendingJoinId = null;
    hostingMode = false;
    updateConnectedLabel();
    transferList.innerHTML = '';
    noteInbox.innerHTML = '';
    if (destroyPeer && peer) {
      try {
        peer.destroy();
      } catch (error) {
        console.warn('Peer destroy failed:', error);
      }
      peer = null;
      myId = null;
    }
    showSection(setupSection);
    updateStatus('Disconnected', 'disconnected');
  } finally {
    setTimeout(() => {
      isResetting = false;
    }, 0);
  }
}

function cancelTransfer(id, direction) {
  let targetPeerId = '';
  let rawTransferId = id;

  if (direction === 'outgoing') {
    const record = outgoingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      targetPeerId = record.peerId || '';
      rawTransferId = record.transferId || id;
      outgoingTransfers.delete(id);
    }
  } else {
    const record = incomingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      targetPeerId = record.peerId || '';
      rawTransferId = record.transferId || id;
    }
    incomingTransfers.delete(id);
  }
  if (targetPeerId) {
    sendToPeer(targetPeerId, { type: 'file-cancel', transferId: rawTransferId });
  }
  markTransferCancelled(id);
}

function markTransferCancelled(id) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);
  const cancelBtn = document.getElementById(`cancel-${id}`);

  if (bar) { bar.style.background = 'var(--danger)'; bar.style.width = '100%'; }
  if (status) status.textContent = 'Cancelled';
  if (speed) speed.textContent = '—';
  if (cancelBtn) cancelBtn.remove();
}

function createTransferUI(id, name, size, direction) {
  if (document.getElementById(`transfer-${id}`)) return;

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
  cancelBtn.title = 'Cancel';
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
  speed.textContent = '—';

  foot.appendChild(status);
  foot.appendChild(speed);

  wrapper.appendChild(head);
  wrapper.appendChild(progressWrap);
  wrapper.appendChild(foot);

  transferList.prepend(wrapper);
}

function updateTransferProgress(id, progress, transferred, total, startTs, label) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (!bar || !status || !speed) return;

  const clamped = Math.max(0, Math.min(progress, 100));
  bar.style.width = `${clamped.toFixed(1)}%`;
  status.textContent = `${label} ${clamped.toFixed(1)}% (${formatBytes(transferred)} / ${formatBytes(total)})`;
  speed.textContent = formatSpeed(transferred, startTs);
}

function markTransferComplete(id, text) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const speed = document.getElementById(`speed-${id}`);

  if (bar) bar.classList.add('complete');
  if (status) status.textContent = text;
  if (speed) speed.textContent = 'Complete';
}

function addDownloadAction(id, url, fileName) {
  const item = document.getElementById(`transfer-${id}`);
  if (!item || item.querySelector('[data-download]')) return;

  const button = document.createElement('button');
  button.className = 'btn btn-secondary btn-sm';
  button.dataset.download = '1';
  button.style.marginTop = '8px';
  button.textContent = 'Save File';

  button.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  });

  item.appendChild(button);
}

// --- Event Listeners ---

document.getElementById('btn-host').addEventListener('click', () => {
  hostingMode = true;
  pendingJoinId = null;
  initPeer();
  showSection(hostingSection);
  updateStatus('Creating', 'waiting');
});

document.getElementById('btn-join').addEventListener('click', () => {
  const id = joinIdInput.value.trim();
  if (!id) return;

  if (!/^\d{6}$/.test(id)) {
    alert('Please enter a valid 6-digit room code.');
    return;
  }

  hostingMode = false;
  pendingJoinId = id;
  initPeer();
});

joinIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-join').click();
  }
});

document.getElementById('btn-copy-id').addEventListener('click', () => {
  const code = myId || myPeerIdEl.textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).then(() => {
      const btn = document.getElementById('btn-copy-id');
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<span style="font-size: 10px; font-weight: 800;">Copied!</span>';
      btn.style.background = 'rgba(13, 140, 87, 0.2)';
      setTimeout(() => { 
        btn.innerHTML = originalHtml;
        btn.style.background = ''; 
      }, 1500);
    });
  }
});

document.getElementById('btn-copy-link').addEventListener('click', () => {
  const code = myId || myPeerIdEl.textContent;
  if (code && code !== '------') {
    const joinUrl = `${WEB_APP_URL}/#${code}`;
    navigator.clipboard.writeText(joinUrl).then(() => {
      const btn = document.getElementById('btn-copy-link');
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = 'rgba(13, 140, 87, 0.2)';
      setTimeout(() => { 
        btn.textContent = originalText;
        btn.style.background = ''; 
      }, 1500);
    });
  }
});

document.getElementById('btn-cancel-host').addEventListener('click', () => {
  resetToSetup({ destroyPeer: true });
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  resetToSetup({ destroyPeer: true });
});

// Quick Messaging
btnSendNote.addEventListener('click', () => {
  queueNote();
});

textNote.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    queueNote();
  }
});

// Drag and Drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragging');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragging');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  handleFiles(e.dataTransfer.files, e.dataTransfer.items);
});

dropZone.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') {
    fileInput.click();
  }
});

btnPickFiles.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

btnPickFolder.addEventListener('click', (e) => {
  e.stopPropagation();
  folderInput.click();
});

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

folderInput.addEventListener('change', () => {
  handleFiles(folderInput.files);
  folderInput.value = '';
});

// --- File Handling ---

async function handleFiles(files, items) {
  if (!hasOpenConnections()) {
    alert('Connect to at least one peer first!');
    return;
  }

  const fileEntries = [];

  if (items && items.length > 0) {
    const allFiles = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        await getFilesFromEntry(entry, allFiles);
      }
    }
    // Convert to entries with relative paths
    for (const f of allFiles) {
      fileEntries.push({ file: f, relativePath: f.webkitRelativePath || f.name });
    }
  } else {
    for (const file of Array.from(files)) {
      if (file.size === 0 && !file.type) continue;
      fileEntries.push({ file, relativePath: file.webkitRelativePath || file.name });
    }
  }

  if (fileEntries.length === 0) return;

  const isMultiple = fileEntries.length > 1;
  const hasFolder = fileEntries.some(e => e.relativePath && e.relativePath.includes('/'));

  if (isMultiple || hasFolder) {
    const zipped = await zipFileEntries(fileEntries);
    if (zipped) {
      await sendFile(zipped);
      return;
    }
  }

  for (const entry of fileEntries) {
    await sendFile(entry.file);
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



