# How ConnectVia Works 🚀

ConnectVia is a high-performance, cross-platform P2P file sharing system. It allows two devices to transfer files and folders directly without ever going through a server's hard drive.

---

## 🏗️ 1. Architecture

ConnectVia uses a "Source of Truth" model where the **Web Client** is the core logic engine.

- **Web Client (`web/`)**: Built with Vanilla JS and WebRTC. Standardized for all platforms.
- **Browser Extension (`extension/`)**: A dedicated wrapper for Chrome/Edge with a matching design system.
- **Native Wrappers**: (iOS, Android, Windows) utilize `WebView` components to load the shared web assets while providing hooks for native features (like Bluetooth/NFC pairing).
- **Signaling Server (`signal-server/`)**: A lightweight PeerJS server that acts as the "switchboard" to help peers find each other.

---

## 📡 2. The Connection Flow

### A. Signaling (The Handshake)
When you click **"Create Room"**:
1. The app connects to the **PeerJS Signaling Server**.
2. It generates a unique **6-digit code** (mapped to a PeerID).
3. The server holds a temporary record of "Who is where."

### B. Connecting
When the receiver enters the code or scans the **QR code**:
1. The receiver asks the Signaling Server: *"Where is peer 123456?"*
2. The server provides the IP and connection data for the host.
3. Both devices negotiate a **WebRTC Data Channel**.

### C. Direct P2P (The Transfer)
Once the "Connected" badge appears, the Signaling Server is no longer involved. Data flows directly between your devices over the local network or the internet using encrypted UDP/TCP tunnels.

---

## 📁 3. The Transfer Protocol

ConnectVia uses a custom, reliable chunking protocol built on top of WebRTC:

1. **`file-start`**: Metadata is sent (name, size, total chunks).
2. **Chunking**: Files are split into **64KB batches**. This ensures memory stability even for 10GB+ files.
3. **ACK Flow Control**: The receiver sends an **Acknowledgment (ACK)** every 32 chunks. This prevents the sender from "flooding" the receiver's memory buffer.
4. **Recursive Folders**: When a folder is dropped, the app traverses it recursively and queues every file.
5. **Backpressure**: The sender monitors `bufferedAmount` to pause sending if the network is saturated.
6. **`file-cancel`**: If either side clicks **✕**, a cancel signal stops the loop immediately.

---

## 🔒 4. Security & Privacy

- **Zero-Storage**: Files are never uploaded to a cloud. They stay on your devices.
- **Direct Encryption**: WebRTC uses DTLS (Datagram Transport Layer Security) by default.
- **Ephemeral Rooms**: Signaling records are destroyed as soon as you disconnect.

---

## 🌐 5. Cross-Platform Support

- **Desktop (Web/Win)**: Drag-and-drop support and native speeds.
- **Mobile (iOS/Android)**: Optimized touch interface and camera-based QR scanning.
- **Offline / LAN**: In places with no internet, you can run the `signal-server` locally on your Wi-Fi, and ConnectVia will work perfectly over your router (AirDrop style).
