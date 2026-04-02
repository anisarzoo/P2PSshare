# Android App (Production Starter)

This folder contains a native Android WebView wrapper for the upgraded ShareVia web client.

## Why this structure
- Native permissions for Bluetooth, NFC, camera, and location.
- JavaScript bridge (`NativeP2PBridge`) so web UI can trigger native pairing helpers.
- Local asset mode (`file:///android_asset/index.html`) for offline startup.

## Build
1. Copy `../web/*` assets into `app/src/main/assets/`.
2. Open this folder in Android Studio (`android/`).
3. Sync Gradle and run on Android 7.0+ (API 24+).

## Native bridge actions
- `setRoomContext`
- `startWifiPairing`
- `startBluetoothPairing`
- `startNfcPairing`
- `startLocationPairing`
- `startTransferService`
- `stopTransferService`
- `stopPairing`

The current `NativeBridge.kt` now includes:
- runtime permission request plumbing (`BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, location, notifications),
- foreground transfer service triggers (`TransferForegroundService`),
- BLE scanner/advertiser discovery,
- Nearby Connections discovery/advertising (Bluetooth/Wi-Fi transport),
- location + Wi-Fi fingerprint pairing hints for older-device fallback,
- callback messages back to the web UI for permission and status events.

Discovery flows are now wired end-to-end, but you should still harden device-compatibility behavior on your target hardware matrix.

## Security checklist
- Keep release build minification enabled.
- Pin your signaling endpoint and TLS cert for online mode.
- Restrict JS bridge methods to required actions only.
- Add runtime permission UX for Android 12+ Bluetooth permissions.
