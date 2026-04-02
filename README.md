# ShareVia

Cross-platform P2P file sharing baseline:
- Offline on local Wi-Fi (via local signaling server)
- Online P2P sharing (QR + room code)
- Native bridge hooks for Bluetooth/NFC/location pairing
- Native discovery stack: BLE + Nearby (Bluetooth/Wi-Fi) + location hints
- TURN configuration support for strict NAT/mobile networks
- Production-edition UI: Send/Receive dashboard, Offline Radar list, and persistent transfer history tabs

## Folders
- `web/` - responsive PWA transfer client.
- `android/` - Android wrapper + JS bridge + foreground transfer service skeleton.
- `ios/` - iOS wrapper + JS bridge.
- `windows/` - Windows wrapper + JS bridge.
- `signal-server/` - always-on signaling service.
- `scripts/` - helper scripts (asset sync).
- `docs/` - production checklist.

## Quick start (web)
1. Serve `web/` from any static host (HTTPS recommended).
2. Open app on two devices.
3. Create room on one side.
4. Join by QR or 6-digit code on the other side.
5. Drop files and transfer.

## Netlify deployment model
- Host `web/` on Netlify.
- Host `signal-server/` on a persistent Node service.
- Configure `Signaling Host/Port/Path` in app settings.
- Configure STUN/TURN in app settings for distant NAT traversal.

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
- Browser mode: use WebRTC + signaling only.
- Native app mode: enables bridge actions, BLE/Nearby pairing, runtime permissions, and foreground transfer service flow.
- Folder sends can be bundled to ZIP (JSZip-based), and received files can be archived with one click.
