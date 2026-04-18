const DEFAULT_CONFIG = {
  signalingHost: 'sharevia-signal.onrender.com',
  signalingPort: '443',
  signalingPath: '/peerjs',
  signalingSecure: true,
  iceStunUrl: 'stun:stun.l.google.com:19302',
  chunkSize: 65536,
  ackEvery: 32,
};

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
};

const elements = {
  setupSection: document.getElementById('setup-section'),
  hostingSection: document.getElementById('hosting-section'),
  shareSection: document.getElementById('share-section'),
  transfersPanel: document.getElementById('transfers-panel'),
  
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
    elements.transfersPanel.classList.add('hidden');
  }

  if (section === elements.setupSection) {
    elements.btnHeaderDisconnect.classList.add('hidden');
  } else {
    elements.btnHeaderDisconnect.classList.remove('hidden');
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
    generateQRCode(myId);
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

function setupConnection(conn) {
  conn.on('open', () => {
    state.connections.set(conn.peer, conn);
    elements.remotePeerId.textContent = conn.peer;
    showSection(elements.shareSection);
  });

  conn.on('data', (data) => {
    handleIncomingData(data, conn.peer);
  });

  conn.on('close', () => {
    state.connections.delete(conn.peer);
    if (state.connections.size === 0) resetApp();
  });
}

function handleIncomingData(data, fromPeer) {
  switch (data.type) {
    case 'file-start':
      startIncomingTransfer(data, fromPeer);
      break;
    case 'file-chunk':
      receiveChunk(data, fromPeer);
      break;
    case 'file-end':
      finishIncomingTransfer(data, fromPeer);
      break;
    case 'text-note':
      addNoteToInbox(data.text, fromPeer);
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

  const blob = new Blob(transfer.chunks);
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

    conn.send({
      type: 'file-start',
      transferId,
      name: file.name,
      size: file.size,
      totalChunks
    });

    let offset = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      conn.send({ type: 'file-chunk', transferId, index: i, chunk });
      offset += chunkSize;
      updateTransferProgress(key, (offset / file.size) * 100, `Sending ${(offset / file.size * 100).toFixed(0)}%`);
    }

    conn.send({ type: 'file-end', transferId });
    
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
      markTransferCancelled(key);
  };

  return wrapper;
}

function updateTransferProgress(key, progress, label) {
  const bar = document.getElementById(`progress-${key}`);
  const status = document.getElementById(`status-${id}`); // Wait, id vs key
  
  // Re-identifying the elements by ID as we do in web
  const barEl = document.getElementById(`progress-${key}`);
  const statusEl = document.getElementById(`status-${key}`);
  
  if (!barEl || barEl.classList.contains('complete')) return;

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

function addNoteToInbox(text, sender) {
  const item = document.createElement('div');
  item.className = 'note-item';
  item.style.padding = '10px';
  item.style.background = '#fff';
  item.style.borderRadius = '10px';
  item.style.border = '1px solid var(--panel-border)';
  item.innerHTML = `<small style="color:var(--text-soft); font-weight:700;">${sender === 'me' ? 'You' : sender}:</small><div style="margin-top:2px;">${text}</div>`;
  elements.noteInbox.prepend(item);
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
    const roomId = Math.floor(100000 + Math.random() * 900000).toString();
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
    const id = elements.webJoinIdInput.value.trim();
    if (id.length === 6) {
      initPeer();
      state.peer.on('open', () => {
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

  elements.btnSendNote.onclick = () => {
    const text = elements.textNote.value.trim();
    if (!text) return;
    const conn = Array.from(state.connections.values())[0];
    if (conn) {
      conn.send({ type: 'text-note', text });
      addNoteToInbox(text, 'me');
      elements.textNote.value = '';
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
  elements.scannerModal.classList.remove('hidden');
  if (!state.html5QrCode) state.html5QrCode = new Html5Qrcode("qr-reader");
  try {
    await state.html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 200 },
      (decodedText) => {
        const id = extractRoomId(decodedText);
        if (id) {
          elements.webJoinIdInput.value = id;
          stopScanner();
          elements.btnWebJoin.click();
        }
      }
    );
    state.scannerActive = true;
  } catch (err) {
    console.error(err);
    alert("Camera access failed");
    stopScanner();
  }
}

function stopScanner() {
  if (state.html5QrCode && state.scannerActive) {
    state.html5QrCode.stop();
    state.scannerActive = false;
  }
  elements.scannerModal.classList.add('hidden');
}

function extractRoomId(text) {
  const match = text.match(/#(\d{6})$/);
  return match ? match[1] : (text.match(/^\d{6}$/) ? text : null);
}

// Start
init();
