const DEFAULT_CONFIG = {
  signalingHost: 'sharevia-signal.onrender.com',
  signalingPort: '443',
  signalingPath: '/peerjs',
  signalingSecure: true,
  iceStunUrl: 'stun:stun.l.google.com:19302',
  chunkSize: 65536,
  ackEvery: 32,
};

let audioContextInstance = null;


const STORAGE_KEY = 'sharevia_config_ext_v1';
const HISTORY_STORAGE_KEY = 'sharevia_history_ext_v1';
const WEB_APP_URL = 'https://sharevia.netlify.app/';

const state = {
  peer: null,
  connections: new Map(),
  myId: '',
  config: loadConfig(),
  incomingTransfers: new Map(),
  outgoingTransfers: new Map(),
  transferHistory: loadTransferHistory(),
  historyFilter: 'all',
  html5QrCode: null,
  scannerActive: false,
  unreadNotesCount: 0,
};

const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** E2EE Crypto Suite **/
async function encryptPayload(data) {
  const secret = state.myId || Array.from(state.connections.keys())[0];
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
  
  const secret = state.myId || Array.from(state.connections.keys())[0];
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

async function safeSend(conn, payload) {
  if (!conn || !conn.open) return;
  const encrypted = await encryptPayload(payload);
  conn.send(encrypted);
}

const elements = {
  setupSection: document.getElementById('setup-section'),
  hostingSection: document.getElementById('hosting-section'),
  shareSection: document.getElementById('share-section'),
  transfersPanel: document.getElementById('transfers-panel'),
  noteBadge: document.getElementById('note-badge'),
  
  btnDashboardSend: document.getElementById('btn-dashboard-send'),
  webJoinIdInput: document.getElementById('web-join-id'),
  btnWebJoin: document.getElementById('btn-web-join'),
  btnWebScan: document.getElementById('btn-web-scan'),
  btnAdvanced: document.getElementById('btn-advanced'),
  advancedPanel: document.getElementById('advanced-panel'),
  setupStatus: document.getElementById('setup-status'),
  
  myPeerId: document.getElementById('my-peer-id'),
  remotePeerId: document.getElementById('remote-peer-id'),
  qrcodeContainer: document.getElementById('qrcode-container'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  btnCopyLink: document.getElementById('btn-copy-link'),
  btnHeaderDisconnect: document.getElementById('btn-header-disconnect'),
  
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  btnPickFiles: document.getElementById('btn-pick-files'),
  btnPickFolder: document.getElementById('btn-pick-folder'),
  
  textNote: document.getElementById('text-note'),
  btnSendNote: document.getElementById('btn-send-note'),
  noteInbox: document.getElementById('note-inbox'),
  
  transferList: document.getElementById('transfer-list'),
  historyTabs: Array.from(document.querySelectorAll('[data-history-tab]')),
  
  scannerModal: document.getElementById('scanner-modal'),
  qrReader: document.getElementById('qr-reader'),
  btnCloseScanner: document.getElementById('btn-close-scanner'),
};

// --- Initialization ---

function init() {
  applyConfigToUI();
  setupEventListeners();
  renderTransferHistory();
  updateInteractionState(false);

  // Wake up signaling server early (Mitigates Render.com cold start)
  if (state.config.signalingHost) {
    const protocol = state.config.signalingSecure ? 'https' : 'http';
    fetch(`${protocol}://${state.config.signalingHost}${state.config.signalingPath}`).catch(() => {});
  }
}

function loadConfig() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
}

function persistConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

function loadTransferHistory() {
  const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function persistTransferHistory() {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.transferHistory.slice(0, 50)));
}

// --- UI Helpers ---

function showSection(section) {
  [elements.setupSection, elements.hostingSection, elements.shareSection].forEach(s => s.classList.add('hidden'));
  section.classList.remove('hidden');
  
  if (section === elements.shareSection) {
    elements.transfersPanel.classList.remove('hidden');
  } else {
    document.getElementById('message-modal').classList.add('hidden');
  };

  document.getElementById('btn-close-msg-modal').onclick = () => {
    document.getElementById('message-modal').classList.add('hidden');
  };

  if (section === elements.setupSection) {
    elements.btnHeaderDisconnect.classList.add('hidden');
  } else {
    elements.btnHeaderDisconnect.classList.remove('hidden');
    elements.btnHeaderDisconnect.className = 'btn btn-danger-soft'; // Apply styled classes
    elements.btnHeaderDisconnect.textContent = (section === elements.hostingSection) ? 'Cancel' : 'Leave';
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function copyToClipboard(text, btn) {
  if (!text || !btn) return;
  navigator.clipboard.writeText(text).then(() => {
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copy-success');
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('copy-success');
    }, 1500);
  });
}

function playNotificationSound(type = 'default') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContextInstance) audioContextInstance = new AudioCtx();
    if (audioContextInstance.state === 'suspended') audioContextInstance.resume();
    
    const audioContent = audioContextInstance;
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
      playPing(880, 0.4); 
    } else if (type === 'file') {
      playPing(660, 0.2, 0.07);
      setTimeout(() => playPing(880, 0.2, 0.07), 80);
    }
  } catch (e) {}
}


// --- Peer Logic ---

function initPeer(id = null) {
  if (state.peer) state.peer.destroy();
  
  const options = {
    host: state.config.signalingHost,
    port: parseInt(state.config.signalingPort),
    path: state.config.signalingPath,
    secure: state.config.signalingSecure,
    debug: 1,
    config: { iceServers: [{ urls: state.config.iceStunUrl }] }
  };

  state.peer = id ? new Peer(id, options) : new Peer(options);

  state.peer.on('open', (myId) => {
    state.myId = myId;
    elements.myPeerId.textContent = myId;
    elements.myPeerId.classList.remove('loading-text');
    generateQRCode(myId);
    
    const h2 = elements.hostingSection.querySelector('h2');
    if (h2) h2.textContent = 'Room Ready';
    
    showSection(elements.hostingSection);
  });

  state.peer.on('connection', (conn) => {
    setupConnection(conn);
  });

  state.peer.on('error', (err) => {
    console.error('Peer error:', err);
    if (err.type === 'server-error' || err.type === 'socket-error' || err.type === 'network') {
      showSetupStatus('Signaling server is waking up. Retrying in 5s...', 'info');
      setTimeout(() => initPeer(id), 5000);
    } else {
      showSetupStatus('Peer error: ' + err.type, 'error');
      resetApp();
    }
  });
}

function showSetupStatus(msg, type = 'error') {
  if (!elements.setupStatus) return;
  elements.setupStatus.textContent = msg;
  elements.setupStatus.className = 'status-msg ' + type;
  elements.setupStatus.classList.remove('hidden');
  if (type === 'info') {
    elements.setupStatus.style.background = 'rgba(22, 159, 144, 0.1)';
    elements.setupStatus.style.color = 'var(--brand-strong)';
    elements.setupStatus.style.borderColor = 'rgba(22, 159, 144, 0.2)';
  } else {
    elements.setupStatus.style.background = 'rgba(244, 67, 54, 0.1)';
    elements.setupStatus.style.color = '#d32f2f';
    elements.setupStatus.style.borderColor = 'rgba(244, 67, 54, 0.2)';
  }
}

function updateConnectedPeersLabel() {
  if (!elements.remotePeerId) return;

  const openCount = state.connections.size;
  const pill = elements.remotePeerId.parentElement;

  if (openCount === 0) {
    elements.remotePeerId.textContent = 'Disconnected';
    elements.remotePeerId.classList.add('disconnected-text');
    if (pill) pill.classList.add('disconnected');
    updateInteractionState(false);
  } else {
    const peerId = Array.from(state.connections.keys())[0];
    elements.remotePeerId.textContent = normalizePeerLabel(peerId);
    elements.remotePeerId.classList.remove('disconnected-text');
    if (pill) pill.classList.remove('disconnected');
    updateInteractionState(true);
  }
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

function handlePeerDisconnect(peerId) {
  state.connections.delete(peerId);
  updateConnectedPeersLabel();
  
  if (state.connections.size > 0) {
    addNoteToInbox(`❌ ${normalizePeerLabel(peerId)} has left the room.`, 'System');
  } else {
    logActivity(`Connection lost with ${normalizePeerLabel(peerId)}.`, 'Warning');
  }
}

function setupConnection(conn) {
  conn.on('open', () => {
    state.connections.set(conn.peer, conn);
    updateConnectedPeersLabel();
    showSection(elements.shareSection);
    logActivity(`Connected to ${normalizePeerLabel(conn.peer)}.`);
  });

  conn.on('data', async (payload) => {
    handleIncomingData(payload, conn.peer);
  });

  conn.on('close', () => {
    handlePeerDisconnect(conn.peer);
  });

  conn.on('error', (err) => {
    console.error('Conn error:', err);
    handlePeerDisconnect(conn.peer);
  });
}

async function handleIncomingData(payload, fromPeer) {
  let data = payload;

  if (payload && payload.type === 'e2ee-wrap') {
    data = await decryptPayload(payload);
    if (!data) return; // Drop unauthenticated or corrupt data
  }

  switch (data.type) {
    case 'file-start':
      if (navigator.vibrate) navigator.vibrate(60);
      playNotificationSound('file');
      startIncomingTransfer(data, fromPeer);
      break;
    case 'file-chunk':
      receiveChunk(data, fromPeer);
      break;
    case 'file-end':
      finishIncomingTransfer(data, fromPeer);
      break;
    case 'text-note':
      playNotificationSound('message');
      addNoteToInbox(data.text, fromPeer);
      break;
    case 'file-cancel':
      handleRemoteCancel(data, fromPeer);
      break;
  }
}

// --- Transfer Logic ---

function startIncomingTransfer(data, fromPeer) {
  const key = `${fromPeer}-${data.transferId}`;
  state.incomingTransfers.set(key, {
    ...data,
    chunks: [],
    receivedBytes: 0,
    startTime: Date.now()
  });
  createTransferUI(key, data.name, data.size, 'incoming');
}

function receiveChunk(data, fromPeer) {
  const key = `${fromPeer}-${data.transferId}`;
  const transfer = state.incomingTransfers.get(key);
  if (!transfer) return;

  transfer.chunks[data.index] = data.chunk;
  transfer.receivedBytes += data.chunk.byteLength;
  
  const progress = (transfer.receivedBytes / transfer.size) * 100;
  updateTransferProgress(key, progress, `Receiving ${progress.toFixed(0)}%`);

  if (transfer.receivedBytes >= transfer.size) {
    // End logic handled by 'file-end'
  }
}

function finishIncomingTransfer(data, fromPeer) {
  const key = `${fromPeer}-${data.transferId}`;
  const transfer = state.incomingTransfers.get(key);
  if (!transfer) return;

  const blob = new Blob(transfer.chunks, { type: transfer.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  
  markTransferComplete(key, `Received at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`);
  addDownloadAction(key, url, transfer.name);
  saveToHistory('received', transfer.name, transfer.size);
  state.incomingTransfers.delete(key);
}

async function sendFiles(files) {
  const conn = Array.from(state.connections.values())[0];
  if (!conn) return;

  for (const file of files) {
    const transferId = Math.random().toString(36).substr(2, 9);
    const key = `me-${transferId}`;
    const chunkSize = state.config.chunkSize;
    const totalChunks = Math.ceil(file.size / chunkSize);

    state.outgoingTransfers.set(key, {
        id: key,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream'
    });

    createTransferUI(key, file.name, file.size, 'outgoing');

    await safeSend(conn, {
      type: 'file-start',
      transferId,
      name: file.name,
      size: file.size,
      totalChunks
    });

    let offset = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      await safeSend(conn, { type: 'file-chunk', transferId, index: i, chunk });
      offset += chunkSize;
      updateTransferProgress(key, (offset / file.size) * 100, `Sending ${(offset / file.size * 100).toFixed(0)}%`);
    }

    await safeSend(conn, { type: 'file-end', transferId });
    
    const url = URL.createObjectURL(file);
    markTransferComplete(key, `Sent at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`);
    addDownloadAction(key, url, file.name);
    
    saveToHistory('sent', file.name, file.size);
    state.outgoingTransfers.delete(key);
  }
}

// --- UI Elements Management ---

function createTransferUI(key, name, size, direction) {
  const wrapper = document.createElement('div');
  wrapper.id = `transfer-${key}`;
  wrapper.className = 'transfer-item';

  wrapper.innerHTML = `
    <div class="transfer-head">
      <div class="transfer-preview-thumb" id="thumb-${key}">
        <span class="direction-icon ${direction}">${direction === 'outgoing' ? '↑' : '↓'}</span>
      </div>
      <div class="transfer-title-wrap">
        <span class="transfer-name">${name}</span>
      </div>
      <button class="btn-cancel-small" id="cancel-${key}">X</button>
    </div>
    <div class="progress-wrap">
      <div class="progress-bar" id="progress-${key}"></div>
    </div>
    <div class="transfer-foot">
      <span class="transfer-status" id="status-${key}">Starting...</span>
    </div>
  `;

  elements.transferList.prepend(wrapper);
  
  const cancelBtn = wrapper.querySelector(`#cancel-${key}`);
  cancelBtn.onclick = (e) => {
      e.stopPropagation();
      notifyCancel(key);
      markTransferCancelled(key);
  };

  return wrapper;
}

function updateTransferProgress(key, progress, label) {
  const barEl = document.getElementById(`progress-${key}`);
  const statusEl = document.getElementById(`status-${key}`);
  
  if (!barEl || barEl.classList.contains('complete') || barEl.classList.contains('cancelled')) return;
  const p = Math.max(0, Math.min(progress, 100));
  barEl.style.width = p + '%';
  if (statusEl && label) statusEl.textContent = label;
}

function markTransferComplete(id, statusLabel) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const cancelBtn = document.getElementById(`cancel-${id}`);
  const item = document.getElementById(`transfer-${id}`);

  if (bar) bar.classList.add('complete');
  if (status && statusLabel) status.textContent = statusLabel;
  if (cancelBtn) cancelBtn.remove();
  if (item) item.classList.add('completed');
}

function markTransferCancelled(id) {
  const bar = document.getElementById(`progress-${id}`);
  const status = document.getElementById(`status-${id}`);
  const cancelBtn = document.getElementById(`cancel-${id}`);
  const item = document.getElementById(`transfer-${id}`);

  if (bar) {
    bar.classList.add('cancelled');
    bar.style.width = '100%';
  }
  if (status) status.textContent = 'Cancelled';
  if (cancelBtn) cancelBtn.remove();

  if (item) {
    item.classList.remove('completed');
    item.style.cursor = 'default';
    const thumb = document.getElementById(`thumb-${id}`);
    if (thumb) {
        // Clear thumb content except direction icon
        const icon = thumb.querySelector('.direction-icon');
        thumb.innerHTML = '';
        if (icon) thumb.appendChild(icon);
    }
  }
}

function addDownloadAction(id, url, name) {
    const item = document.getElementById(`transfer-${id}`);
    const thumbContainer = document.getElementById(`thumb-${id}`);
    if (!item || !thumbContainer) return;

    const record = state.incomingTransfers.get(id) || state.outgoingTransfers.get(id);
    const mime = (record && record.mime) || '';
    const lowerName = name.toLowerCase();

    // 1. Generate Thumbnail / Icon
    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '6px';
      thumbContainer.appendChild(img);
    } else {
      const iconSpan = document.createElement('span');
      iconSpan.style.fontSize = '1.1rem';
      
      if (mime.startsWith('audio/') || lowerName.endsWith('.mp3')) {
        iconSpan.textContent = '🎵';
      } else if (mime.startsWith('video/')) {
          iconSpan.textContent = '🎬';
      } else if (mime.includes('zip') || lowerName.endsWith('.zip') || lowerName.endsWith('.rar')) {
        iconSpan.textContent = '📦';
      } else if (mime.includes('sheet') || lowerName.endsWith('.xlsx')) {
        iconSpan.textContent = '📄';
      } else {
        iconSpan.textContent = '📄';
      }
      thumbContainer.appendChild(iconSpan);
    }

    // 2. Click to Preview
    item.onclick = () => {
        if (!item.classList.contains('completed')) return;
        window.open(url, '_blank');
    };
    
    // 3. Save Button
    const foot = item.querySelector('.transfer-foot');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-secondary';
    saveBtn.style.padding = '2px 8px';
    saveBtn.style.fontSize = '0.7rem';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
    };
    foot.appendChild(saveBtn);
}

async function notifyCancel(key) {
    const conn = Array.from(state.connections.values())[0];
    if (!conn) return;

    // In extension key is "fromPeer-transferId" or "me-transferId"
    const parts = key.split('-');
    const transferId = parts[parts.length - 1];

    await safeSend(conn, {
        type: 'file-cancel',
        transferId: transferId
    });
}

function handleRemoteCancel(data, fromPeer) {
    const key = `${fromPeer}-${data.transferId}`;
    markTransferCancelled(key);
}

function addNoteToInbox(text, sender) {
  const notesCollapsible = document.getElementById('notes-collapsible');
  const isCollapsed = notesCollapsible ? notesCollapsible.classList.contains('collapsed') : false;
  const isUnread = sender !== 'me' && isCollapsed;

  const item = document.createElement('div');
  item.className = `note-item ${isUnread ? 'unread' : ''}`.trim();

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  item.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items: baseline; margin-bottom: 2px;">
      <small style="color:var(--text-soft); font-weight:700; font-size: 0.7rem;">${sender === 'me' ? 'You' : sender}</small>
      <span style="font-size: 0.6rem; opacity: 0.5;">${time}</span>
    </div>
    <div style="font-size: 0.85rem; line-height: 1.3;">${text}</div>
  `;
  elements.noteInbox.prepend(item);

  if (isUnread) {
    state.unreadNotesCount++;
    updateNoteBadge();
  }
}

function updateNoteBadge() {
  if (!elements.noteBadge) return;
  if (state.unreadNotesCount > 0) {
    elements.noteBadge.classList.remove('hidden');
  } else {
    elements.noteBadge.classList.add('hidden');
  }
}

function saveToHistory(direction, name, size) {
  state.transferHistory.unshift({ direction, name, size, time: Date.now() });
  persistTransferHistory();
  renderTransferHistory();
}

function renderTransferHistory() {
  // Simple history can be integrated into the transfers list or a separate panel
}

function resetApp() {
  if (state.peer) state.peer.destroy();
  state.peer = null;
  state.connections.clear();
  showSection(elements.setupSection);
}

// --- Events ---

function setupEventListeners() {
  elements.btnDashboardSend.onclick = () => {
    let roomId = '';
    for (let i = 0; i < 6; i++) {
        roomId += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    }
    playNotificationSound('silent');
    
    // Instant UI
    elements.myPeerId.textContent = roomId;
    elements.myPeerId.classList.add('loading-text');
    generateQRCode(roomId);
    
    const h2 = elements.hostingSection.querySelector('h2');
    if (h2) h2.textContent = 'Creating Room...';
    
    showSection(elements.hostingSection);
    initPeer(roomId);
  };

  elements.btnCopyCode.onclick = () => {
    copyToClipboard(state.myId, elements.btnCopyCode);
  };

  elements.btnCopyLink.onclick = () => {
    const url = `${WEB_APP_URL}#${state.myId}`;
    copyToClipboard(url, elements.btnCopyLink);
  };

  elements.btnWebJoin.onclick = () => {
    const id = elements.webJoinIdInput.value.trim().toUpperCase();
    if (id.length >= 6) {
      playNotificationSound('silent');
      elements.btnWebJoin.disabled = true;
      elements.btnWebJoin.textContent = 'Joining...';
      
      showSection(elements.shareSection);
      elements.remotePeerId.textContent = `Connecting to ${id}...`;
      elements.remotePeerId.classList.add('loading-text');

      initPeer();
      state.peer.on('open', () => {
        elements.btnWebJoin.disabled = false;
        elements.btnWebJoin.textContent = 'Join';
        const conn = state.peer.connect(id);
        setupConnection(conn);
      });
    }
  };

  elements.btnHeaderDisconnect.onclick = () => resetApp();

  elements.btnAdvanced.onclick = () => {
    elements.advancedPanel.classList.toggle('hidden');
  };

  elements.btnPickFiles.onclick = () => elements.fileInput.click();
  elements.fileInput.onchange = (e) => sendFiles(e.target.files);

  elements.btnPickFolder.onclick = () => elements.folderInput.click();
  elements.folderInput.onchange = (e) => sendFiles(e.target.files);

  elements.dropZone.ondragover = (e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--brand-strong)'; };
  elements.dropZone.ondragleave = (e) => { e.preventDefault(); e.currentTarget.style.borderColor = ''; };
  elements.dropZone.ondrop = (e) => {
    e.preventDefault();
    e.currentTarget.style.borderColor = '';
    sendFiles(e.dataTransfer.files);
  };

  elements.btnSendNote.onclick = async () => {
    const text = elements.textNote.value.trim();
    if (!text) return;
    const conn = Array.from(state.connections.values())[0];
    if (conn) {
      await safeSend(conn, { type: 'text-note', text });
      addNoteToInbox(text, 'me');
      elements.textNote.value = '';
    }
  };

  const btnToggleNotes = document.getElementById('btn-toggle-notes');
  const notesCollapsible = document.getElementById('notes-collapsible');
  if (btnToggleNotes && notesCollapsible) {
    btnToggleNotes.onclick = () => {
      const isCollapsed = notesCollapsible.classList.toggle('collapsed');
      btnToggleNotes.parentElement.classList.toggle('collapsed-container', isCollapsed);
      
      if (!isCollapsed) {
        state.unreadNotesCount = 0;
        updateNoteBadge();
        document.querySelectorAll('.note-item.unread').forEach(el => el.classList.remove('unread'));
      }
    };
  }

  elements.textNote.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      elements.btnSendNote.click();
    }
  };

  elements.btnWebScan.onclick = () => startScanner();
  elements.btnCloseScanner.onclick = () => stopScanner();
}

function generateQRCode(roomId) {
  elements.qrcodeContainer.innerHTML = '';
  new QRCode(elements.qrcodeContainer, {
    text: WEB_APP_URL + '#' + roomId,
    width: 180,
    height: 180,
    colorDark: "#0b6a61",
    colorLight: "#ffffff"
  });
}

function applyConfigToUI() {
  document.getElementById('signal-host').value = state.config.signalingHost;
  document.getElementById('signal-port').value = state.config.signalingPort;
}

// --- QR Scanner ---
async function startScanner() {
  const permissionStatus = await checkCameraPermission();
  
  if (permissionStatus === 'denied') {
    showCustomModal('Camera Access Blocked', 'You have blocked camera access for this extension. \n\n1. Open Extension Settings.\n2. Enable Camera permissions.\n3. Click "Try Again" below.');
    return;
  }

  showSection(elements.shareSection);
  document.getElementById('scanner-modal').classList.remove('hidden');

  if (permissionStatus === 'prompt') {
    const readerEl = document.getElementById('qr-reader');
    readerEl.innerHTML = `
      <div class="permission-pre-prompt" style="text-align:center; padding: 40px 10px;">
        <div style="font-size: 2.5rem; margin-bottom: 15px;">📷</div>
        <p style="margin-bottom: 20px; color: rgba(255,255,255,0.9); font-size: 0.9rem;">Camera access is required.</p>
        <button id="btn-request-perm" class="btn btn-secondary full">Allow Camera</button>
      </div>
    `;
    document.getElementById('btn-request-perm').onclick = () => {
      readerEl.innerHTML = '';
      initAndStartScanner();
    };
    return;
  }

  initAndStartScanner();
}

async function checkCameraPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'prompt';
    const result = await navigator.permissions.query({ name: 'camera' });
    return result.state;
  } catch (e) {
    return 'prompt';
  }
}

async function initAndStartScanner() {
  try {
    if (!state.html5QrCode) {
      state.html5QrCode = new Html5Qrcode("qr-reader");
    }
    
    document.getElementById('qr-skeleton').classList.add('hidden');
    
    await state.html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        const id = extractRoomId(decodedText);
        if (id) {
          playNotificationSound('silent');
          elements.webJoinIdInput.value = id;
          stopScanner();
          elements.btnWebJoin.click();
        }
      }
    );
    state.scannerActive = true;
  } catch (err) {
    console.error(err);
    state.scannerActive = false;
    const errStr = String(err.name || err || '');
    if (errStr.includes('NotAllowedError') || errStr.includes('Permission denied')) {
      showCustomModal('Camera Access Denied', 'To scan QR codes, please enable camera permissions in settings.');
    } else {
      showCustomModal('Camera Error', 'We couldn\'t access your camera.');
    }
    stopScanner();
  }
}

function showCustomModal(title, message) {
  const modal = document.getElementById('message-modal');
  const titleEl = document.getElementById('msg-modal-title');
  const bodyEl = document.getElementById('msg-modal-body');
  const closeBtn = document.getElementById('btn-close-msg-modal');
  
  if (modal && titleEl && bodyEl) {
    titleEl.textContent = title;
    bodyEl.innerHTML = message.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    if (title === 'Camera Access Blocked') {
       closeBtn.textContent = 'Try Again';
       closeBtn.onclick = () => {
         modal.classList.add('hidden');
         startScanner();
       };
    } else {
       closeBtn.textContent = 'Got it';
       closeBtn.onclick = () => modal.classList.add('hidden');
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
  document.getElementById('scanner-modal').classList.add('hidden');
  document.getElementById('qr-skeleton').classList.remove('hidden');
}

function extractRoomId(text) {
  const codeRegex = /[A-Z0-9]{6}/i;
  const match = text.match(/#([A-Z0-9]{6})$/i);
  if (match) return match[1].toUpperCase();
  
  const rawMatch = text.trim().match(/^[A-Z0-9]{6}$/i);
  return rawMatch ? rawMatch[0].toUpperCase() : null;
}

// Start
init();
