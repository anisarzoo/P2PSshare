let peer = null;
let conn = null;
let myId = null;

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
let connectionTimer = null;

// --- Helpers ---

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

// --- Initialization ---

function initPeer(id = null) {
  if (peer) peer.destroy();

  const peerId = id || generateRoomCode();
  peer = new Peer(peerId, SIGNAL_CONFIG);

  peer.on('open', (openId) => {
    myId = openId;
    myPeerIdEl.textContent = openId;
    updateStatus('Waiting', 'waiting');
    generateQRCode(openId);
  });

  peer.on('connection', (connection) => {
    if (conn && conn.open) {
      connection.close();
      return;
    }
    setupConnection(connection);
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    if (err && err.type === 'peer-unavailable') {
      alert('Room not found. Check the code and try again.');
    } else {
      alert('Connection error: ' + (err.type || 'unknown'));
    }
    resetToSetup();
  });

  peer.on('disconnected', () => {
    updateStatus('Disconnected', 'disconnected');
  });
}

function generateQRCode(id) {
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
}

// --- Connection ---

function setupConnection(connection) {
  conn = connection;

  // Start connection timeout — if 'open' doesn't fire in time, abort
  clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    if (!connection.open) {
      alert('Connection timed out. The host may have closed their browser or the room expired.');
      try { connection.close(); } catch (e) {}
      conn = null;
      resetToSetup();
    }
  }, CONNECTION_TIMEOUT);

  conn.on('open', () => {
    clearTimeout(connectionTimer);
    connectionTimer = null;
    showSection(shareSection);
    remotePeerIdEl.textContent = conn.peer;
    updateStatus('Connected', 'connected');
  });

  conn.on('data', (data) => {
    handleIncomingData(data);
  });

  conn.on('close', () => {
    clearTimeout(connectionTimer);
    resetToSetup();
  });

  conn.on('error', (err) => {
    clearTimeout(connectionTimer);
    console.error('Connection error:', err);
    resetToSetup();
  });
}

// --- Incoming Data Handler (compatible with web app protocol) ---

function handleIncomingData(data) {
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'file-start':
      handleIncomingFileStart(data);
      break;
    case 'file-chunk':
      handleIncomingFileChunk(data);
      break;
    case 'file-end':
      handleIncomingFileEnd(data);
      break;
    case 'file-ack':
      handleIncomingAck(data);
      break;
    case 'file-cancel':
      handleIncomingCancel(data);
      break;
    case 'text-note':
      break;
    case 'capabilities':
      break;
    default:
      break;
  }
}

function handleIncomingCancel(data) {
  const id = data.transferId;
  // CRITICAL: Set cancelled flag on the record object BEFORE deleting.
  // The sendFile() loop holds a local reference and checks record.cancelled.
  const outRecord = outgoingTransfers.get(id);
  if (outRecord) {
    outRecord.cancelled = true;
  }
  const inRecord = incomingTransfers.get(id);
  if (inRecord) {
    inRecord.cancelled = true;
  }
  incomingTransfers.delete(id);
  outgoingTransfers.delete(id);
  markTransferCancelled(id);
}

function handleIncomingFileStart(data) {
  const record = {
    transferId: data.transferId,
    name: data.name,
    size: Number(data.size),
    mime: data.mime || 'application/octet-stream',
    totalChunks: Number(data.totalChunks),
    receivedChunks: 0,
    receivedBytes: 0,
    startTs: performance.now(),
    chunks: new Array(Number(data.totalChunks)),
  };

  incomingTransfers.set(data.transferId, record);
  createTransferUI(data.transferId, data.name, data.size, 'incoming');
}

function handleIncomingFileChunk(data) {
  const record = incomingTransfers.get(data.transferId);
  if (!record || record.cancelled) return;
  if (record.chunks[data.index]) return;

  record.chunks[data.index] = data.chunk;
  record.receivedChunks += 1;
  record.receivedBytes += data.chunk.byteLength;

  const progress = (record.receivedBytes / record.size) * 100;
  updateTransferProgress(data.transferId, progress, record.receivedBytes, record.size, record.startTs, 'Receiving');

  // Send ACK every 32 chunks (matches web app)
  if (record.receivedChunks % 32 === 0 || record.receivedChunks === record.totalChunks) {
    if (conn && conn.open) {
      conn.send({
        type: 'file-ack',
        transferId: data.transferId,
        receivedChunks: record.receivedChunks,
        receivedBytes: record.receivedBytes,
      });
    }
  }
}

function handleIncomingFileEnd(data) {
  const record = incomingTransfers.get(data.transferId);
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

  updateTransferProgress(data.transferId, 100, record.size, record.size, record.startTs, 'Received');
  markTransferComplete(data.transferId, `Received (${formatBytes(record.size)})`);

  // Add download button
  addDownloadAction(data.transferId, url, record.name);

  // Auto-download
  const a = document.createElement('a');
  a.href = url;
  a.download = record.name;
  a.click();

  incomingTransfers.delete(data.transferId);
}

function handleIncomingAck(data) {
  const record = outgoingTransfers.get(data.transferId);
  if (!record) return;

  record.ackedBytes = data.receivedBytes;
  const progress = (data.receivedBytes / record.size) * 100;
  updateTransferProgress(data.transferId, progress, data.receivedBytes, record.size, record.startTs, 'Delivered');
}

// --- Send Files (compatible with web app protocol) ---

async function waitForBufferSpace() {
  const channel = conn && conn.dataChannel ? conn.dataChannel : null;
  if (!channel) return;
  while (channel.bufferedAmount > CHANNEL_BUFFER_LIMIT) {
    await sleep(20);
  }
}

async function sendFile(file) {
  if (!conn || !conn.open) return;

  const transferId = createTransferId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const record = {
    id: transferId,
    size: file.size,
    sentBytes: 0,
    ackedBytes: 0,
    startTs: performance.now(),
    totalChunks,
  };

  outgoingTransfers.set(transferId, record);
  createTransferUI(transferId, file.name, file.size, 'outgoing');

  conn.send({
    type: 'file-start',
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    totalChunks,
  });

  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (record.cancelled) {
      markTransferCancelled(transferId);
      return;
    }

    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();

    await waitForBufferSpace();

    if (record.cancelled) {
      markTransferCancelled(transferId);
      return;
    }

    conn.send({
      type: 'file-chunk',
      transferId,
      index: i,
      chunk,
    });

    offset = end;
    record.sentBytes = offset;

    updateTransferProgress(transferId, (offset / file.size) * 100, offset, file.size, record.startTs, 'Sending');

    if (i % 32 === 0) await sleep(0);
  }

  conn.send({ type: 'file-end', transferId });
  markTransferComplete(transferId, `Sent (${formatBytes(file.size)})`);
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

function resetToSetup() {
  if (conn) { try { conn.close(); } catch (e) {} }
  conn = null;
  incomingTransfers.clear();
  outgoingTransfers.clear();
  transferList.innerHTML = '';
  showSection(setupSection);
  updateStatus('Disconnected', 'disconnected');
}

function cancelTransfer(id, direction) {
  if (direction === 'outgoing') {
    const record = outgoingTransfers.get(id);
    if (record) {
      record.cancelled = true;
      outgoingTransfers.delete(id);
    }
  } else {
    const record = incomingTransfers.get(id);
    if (record) {
      record.cancelled = true;
    }
    incomingTransfers.delete(id);
  }
  if (conn && conn.open) {
    conn.send({ type: 'file-cancel', transferId: id });
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
  initPeer();
  showSection(hostingSection);
});

document.getElementById('btn-join').addEventListener('click', () => {
  const id = joinIdInput.value.trim();
  if (!id) return;

  if (!/^\d{6}$/.test(id)) {
    alert('Please enter a valid 6-digit room code.');
    return;
  }

  initPeer();
  peer.on('open', () => {
    const connection = peer.connect(id, { reliable: true });
    setupConnection(connection);
  });
});

joinIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-join').click();
  }
});

document.getElementById('btn-copy-id').addEventListener('click', () => {
  if (myId) {
    navigator.clipboard.writeText(myId).then(() => {
      const btn = document.getElementById('btn-copy-id');
      btn.style.background = 'rgba(13, 140, 87, 0.2)';
      setTimeout(() => { btn.style.background = ''; }, 800);
    });
  }
});

document.getElementById('btn-cancel-host').addEventListener('click', () => {
  if (peer) peer.destroy();
  resetToSetup();
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  if (peer) peer.destroy();
  resetToSetup();
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
  if (!conn || !conn.open) {
    alert('Connect to a peer first!');
    return;
  }

  if (items && items.length > 0) {
    const allFiles = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        await getFilesFromEntry(entry, allFiles);
      }
    }
    if (allFiles.length > 0) {
      for (const f of allFiles) {
        await sendFile(f);
      }
      return;
    }
  }

  for (const file of Array.from(files)) {
    if (file.size === 0 && !file.type) continue;
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
