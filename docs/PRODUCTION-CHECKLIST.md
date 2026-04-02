# Production Checklist

## Security
- Use HTTPS for web and signaling in public networks.
- Restrict CORS in `signal-server` for known origins.
- Configure TURN credentials for mobile/cellular NAT fallback.
- Keep native bridge APIs minimal and action-scoped.
- Validate file metadata and enforce max queue limits in clients.

## Reliability
- Keep `chunkSize` at 64KB for mixed device compatibility.
- Run signaling on an always-on host (separate from static Netlify hosting).
- Use LAN signaling server for offline Wi-Fi mode.
- Validate Offline Radar discovery behavior on mixed Android versions and OEM skins.
- Monitor transfer logs and retry interrupted sends.
- Keep background execution permissions configured for mobile.

## Native Pairing
- Android: implement BLE/Nearby discovery in `NativeBridge.kt`.
- Android: keep foreground transfer service + notification channel healthy.
- Android: validate fallback behavior on Android 8-11 where legacy location permissions gate BLE/Wi-Fi scans.
- iOS: implement CoreBluetooth/CoreNFC handlers in `NativeBridgeCoordinator`.
- Windows: implement Bluetooth/NFC using WinRT APIs in `NativeBridgeService`.

## Release
- Android: build signed `release` APK/AAB.
- iOS: archive with correct entitlements and privacy strings.
- Windows: publish signed installer/MSIX.
- Run end-to-end testing on mixed OS/device matrix.
