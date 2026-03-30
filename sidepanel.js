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
const transferList = document.getElementById('transfer-list');
const joinIdInput = document.getElementById('join-id');

// --- Initialization ---

function initPeer(id = null) {
  if (peer) peer.destroy();
  
  peer = new Peer(id, {
    debug: 2
  });

  peer.on('open', (id) => {
    myId = id;
    myPeerIdEl.textContent = id;
    updateStatus('Waiting', 'waiting');
    console.log('My peer ID is: ' + id);
  });

  peer.on('connection', (connection) => {
    if (conn) {
      connection.close();
      return;
    }
    setupConnection(connection);
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    alert('Error: ' + err.type);
    resetToSetup();
  });

  peer.on('disconnected', () => {
    updateStatus('Disconnected', 'disconnected');
  });
}

// --- Connection Handling ---

function setupConnection(connection) {
  conn = connection;
  
  conn.on('open', () => {
    showSection(shareSection);
    remotePeerIdEl.textContent = conn.peer;
    updateStatus('Connected', 'connected');
    console.log('Connected to: ' + conn.peer);
  });

  conn.on('data', (data) => {
    handleIncomingData(data);
  });

  conn.on('close', () => {
    console.log('Connection closed');
    resetToSetup();
  });

  conn.on('error', (err) => {
    console.error('Connection error:', err);
    resetToSetup();
  });
}

function handleIncomingData(data) {
  if (data.type === 'file-start') {
    createTransferUI(data.transferId, data.name, data.size, 'receiving');
  } else if (data.type === 'file-chunk') {
    handleFileChunk(data);
  } else if (data.type === 'file-end') {
    finalizeFile(data.transferId);
  }
}

// --- File Transfer Logic ---

const incomingFiles = {}; // Store chunks by transferId

function handleFileChunk(data) {
  const { transferId, chunk, index } = data;
  if (!incomingFiles[transferId]) {
    incomingFiles[transferId] = {
      chunks: [],
      receivedSize: 0
    };
  }
  
  incomingFiles[transferId].chunks[index] = chunk;
  incomingFiles[transferId].receivedSize += chunk.byteLength;
  
  const progress = (incomingFiles[transferId].receivedSize / data.totalSize) * 100;
  updateTransferProgress(transferId, progress);
}

function finalizeFile(transferId) {
  const fileData = incomingFiles[transferId];
  if (!fileData) return;

  const blob = new Blob(fileData.chunks);
  const url = URL.createObjectURL(blob);
  
  // Update UI to show download link
  const item = document.getElementById(`transfer-${transferId}`);
  if (item) {
    const info = item.querySelector('.transfer-info');
    info.innerHTML += `<span>✅ Done</span>`;
    const progressBar = item.querySelector('.progress-bar');
    progressBar.style.width = '100%';
    progressBar.classList.add('complete');
    
    // Auto-download or show link
    const a = document.createElement('a');
    a.href = url;
    a.download = item.dataset.filename;
    a.click();
  }
  
  delete incomingFiles[transferId];
}

async function sendFile(file) {
  if (!conn || !conn.open) return;

  const transferId = Math.random().toString(36).substr(2, 9);
  const chunkSize = 16384; // 16KB chunks
  const totalChunks = Math.ceil(file.size / chunkSize);

  createTransferUI(transferId, file.name, file.size, 'sending');

  // Notify receiver
  conn.send({
    type: 'file-start',
    transferId,
    name: file.name,
    size: file.size
  });

  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
    conn.send({
      type: 'file-chunk',
      transferId,
      chunk,
      index: i,
      totalSize: file.size
    });
    offset += chunkSize;
    
    const progress = (offset / file.size) * 100;
    updateTransferProgress(transferId, Math.min(progress, 100));
    
    // Small delay to prevent flooding the channel
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 10));
  }

  conn.send({
    type: 'file-end',
    transferId
  });
}

// --- UI Helpers ---

function updateStatus(text, className) {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge ${className}`;
}

function showSection(section) {
  [setupSection, hostingSection, shareSection].forEach(s => s.classList.add('hidden'));
  section.classList.remove('hidden');
  section.classList.add('active');
}

function resetToSetup() {
  if (conn) conn.close();
  conn = null;
  showSection(setupSection);
  updateStatus('Disconnected', 'disconnected');
}

function createTransferUI(id, name, size, type) {
  const div = document.createElement('div');
  div.id = `transfer-${id}`;
  div.className = 'transfer-item';
  div.dataset.filename = name;
  
  const sizeStr = (size / (1024 * 1024)).toFixed(2) + ' MB';
  
  div.innerHTML = `
    <div class="transfer-info">
      <span>${type === 'sending' ? '⬆️' : '⬇️'} ${name}</span>
      <span>${sizeStr}</span>
    </div>
    <div class="progress-container">
      <div class="progress-bar"></div>
    </div>
  `;
  
  transferList.prepend(div);
}

function updateTransferProgress(id, progress) {
  const item = document.getElementById(`transfer-${id}`);
  if (item) {
    const bar = item.querySelector('.progress-bar');
    bar.style.width = `${progress}%`;
  }
}

// --- Event Listeners ---

document.getElementById('btn-host').addEventListener('click', () => {
  const randomId = Math.floor(100000 + Math.random() * 900000).toString();
  initPeer(randomId);
  showSection(hostingSection);
});

document.getElementById('btn-join').addEventListener('click', () => {
  const id = joinIdInput.value.trim();
  if (!id) return;
  
  initPeer();
  peer.on('open', () => {
    const connection = peer.connect(id);
    setupConnection(connection);
  });
});

document.getElementById('btn-copy-id').addEventListener('click', () => {
  navigator.clipboard.writeText(myId);
  alert('Code copied to clipboard!');
});

document.getElementById('btn-cancel-host').addEventListener('click', () => {
  if (peer) peer.destroy();
  resetToSetup();
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
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
  const files = e.dataTransfer.files;
  handleFiles(files);
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
});

function handleFiles(files) {
  if (!conn || !conn.open) {
    alert('Connect to a peer first!');
    return;
  }
  Array.from(files).forEach(sendFile);
}
