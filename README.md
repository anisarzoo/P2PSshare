# ConnectVia

Cross-platform P2P file sharing — production-ready baseline:
- Offline on local Wi-Fi (via local signaling server)
- Online P2P sharing (QR + room code)
- Native bridge hooks for Bluetooth, NFC, and location-assisted pairing

## Folders
- `web/` - upgraded responsive PWA transfer client.
- `android/` - Android native wrapper + JS bridge.
- `ios/` - iOS SwiftUI + WKWebView wrapper + JS bridge.
- `windows/` - Windows WPF + WebView2 wrapper + JS bridge.
- `signal-server/` - local/offline signaling service for LAN transfers.
- `scripts/` - helper scripts (asset sync).
- `docs/` - production checklist.

## Quick start (web)
1. Serve `web/` from any static host (HTTPS recommended).
2. Open app on two devices.
3. Create room on one side.
4. Join by QR or 6-digit code on the other side.
5. Drop files and transfer.

## Offline Wi-Fi mode
1. Run signaling server:
   - `cd signal-server`
   - `npm install`
   - `npm run start`
2. In web app advanced settings set:
   - Host = LAN IP of signaling host
   - Port = 9000
   - Path = /peerjs
   - Secure = off (unless reverse proxy TLS is configured)

## Sync web assets into native wrappers
- `powershell -ExecutionPolicy Bypass -File scripts/sync-web-assets.ps1`

## Notes on compatibility
- Web mode: best for fast cross-platform sharing with QR/code.
- Android/iOS/Windows wrappers: expose native bridge for Bluetooth/NFC/location flows.
- Native pairing internals are scaffolded and should be wired to full production device APIs for your final release policy.
