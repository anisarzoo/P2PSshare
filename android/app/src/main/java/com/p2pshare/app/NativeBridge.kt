package com.p2pshare.app

import android.app.Activity
import android.nfc.NfcAdapter
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

class NativeBridge(
    private val activity: Activity,
    private val webView: WebView,
) {
    private val bleRoomDiscoveryManager =
        BleRoomDiscoveryManager(
            activity.applicationContext,
            ::handleRoomCodeDiscovery,
            ::sendInfo,
        )

    private val nearbyRoomDiscoveryManager =
        NearbyRoomDiscoveryManager(
            activity.applicationContext,
            ::handleRoomCodeDiscovery,
            ::sendInfo,
        )

    private val locationPairingManager =
        LocationPairingManager(
            activity.applicationContext,
            ::handleRoomCodeDiscovery,
            ::sendInfo,
        )

    private var roomCode: String = generateRoomCode()
    private var role: String = "idle"
    private var targetRoomCode: String? = null
    private var pendingAction: String? = null
    private var pendingPayload: JSONObject? = null

    @JavascriptInterface
    fun startBluetoothPairing() {
        if (!ensureRuntimePermissions("bluetooth pairing", "startBluetoothPairing", null)) {
            return
        }

        val activeRoom = activePairingRoomCode()
        bleRoomDiscoveryManager.start(activeRoom)
        nearbyRoomDiscoveryManager.start(activeRoom)
        sendPairingCode(activeRoom, source = "bluetooth")
        sendInfo("Bluetooth + Nearby pairing started for room $activeRoom.")
    }

    @JavascriptInterface
    fun startWifiPairing() {
        if (!ensureRuntimePermissions("wifi pairing", "startWifiPairing", null)) {
            return
        }

        val activeRoom = activePairingRoomCode()
        nearbyRoomDiscoveryManager.start(activeRoom)
        locationPairingManager.start(activeRoom)
        sendPairingCode(activeRoom, source = "wifi")
        sendInfo("Wi-Fi/Nearby pairing started for room $activeRoom.")
    }

    @JavascriptInterface
    fun startNfcPairing() {
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        if (adapter == null) {
            sendInfo("NFC not supported on this device.")
            return
        }

        if (!adapter.isEnabled) {
            sendInfo("NFC is off. Enable NFC in system settings.")
            return
        }

        if (!ensureRuntimePermissions("nfc pairing", "startNfcPairing", null)) {
            return
        }

        val activeRoom = activePairingRoomCode()
        sendPairingCode(activeRoom, source = "nfc")
        sendInfo("NFC pairing ready. Bring devices close and share room code if needed.")
    }

    @JavascriptInterface
    fun startLocationPairing() {
        if (!ensureRuntimePermissions("location pairing", "startLocationPairing", null)) {
            return
        }

        val activeRoom = activePairingRoomCode()
        locationPairingManager.start(activeRoom)
        sendInfo("Location-assisted pairing started.")
    }

    @JavascriptInterface
    fun startTransferService() {
        if (!ensureRuntimePermissions("background transfer", "startTransferService", null)) {
            return
        }

        TransferForegroundService.start(activity, "Connected and keeping transfer alive in background.")
        sendInfo("Transfer foreground service started.")
    }

    @JavascriptInterface
    fun stopTransferService() {
        TransferForegroundService.stop(activity)
        sendInfo("Transfer foreground service stopped.")
    }

    @JavascriptInterface
    fun stopPairing() {
        bleRoomDiscoveryManager.stop()
        nearbyRoomDiscoveryManager.stop()
        sendInfo("Native pairing discovery stopped.")
    }

    @JavascriptInterface
    fun setRoomContext(roomCode: String?, role: String?, targetRoom: String?) {
        normalizeRoomCode(roomCode)?.let {
            this.roomCode = it
        }

        this.role = role?.ifBlank { "idle" } ?: "idle"
        this.targetRoomCode = normalizeRoomCode(targetRoom)
    }

    @JavascriptInterface
    fun postMessage(rawPayload: String) {
        val payload = runCatching { JSONObject(rawPayload) }.getOrNull()
        val action = payload?.optString("action")?.trim().orEmpty()
        if (action.isBlank()) {
            sendInfo("Unknown native action: none")
            return
        }

        when (action) {
            "startBluetoothPairing" -> startBluetoothPairing()
            "startWifiPairing" -> startWifiPairing()
            "startNfcPairing" -> startNfcPairing()
            "startLocationPairing" -> startLocationPairing()
            "startTransferService" -> startTransferService()
            "stopTransferService" -> stopTransferService()
            "stopPairing" -> stopPairing()
            "setRoomContext" -> {
                setRoomContext(
                    roomCode = payload?.optString("roomCode"),
                    role = payload?.optString("role"),
                    targetRoom = payload?.optString("targetRoom"),
                )
            }

            else -> sendInfo("Unknown native action: $action")
        }
    }

    fun onRuntimePermissionsRequested(reason: String, permissions: List<String>) {
        val payload =
            JSONObject()
                .put("type", "permissions-requested")
                .put("reason", reason)
                .put("permissions", permissions.joinToString(","))
        dispatch(payload)
    }

    fun onRuntimePermissionsResult(grantMap: Map<String, Boolean>) {
        val denied =
            grantMap.entries
                .filterNot { it.value }
                .map { it.key }

        if (denied.isEmpty()) {
            sendInfo("Runtime permissions granted.")
            resumePendingAction()
            return
        }

        pendingAction = null
        pendingPayload = null

        val payload =
            JSONObject()
                .put("type", "permissions-denied")
                .put("permissions", denied.joinToString(","))
                .put("message", "Some permissions are denied. Hardware features may be limited.")
        dispatch(payload)
    }

    fun onDestroy() {
        stopPairing()
        stopTransferService()
    }

    private fun resumePendingAction() {
        val action = pendingAction ?: return
        val payload = pendingPayload
        pendingAction = null
        pendingPayload = null

        when (action) {
            "startBluetoothPairing" -> startBluetoothPairing()
            "startWifiPairing" -> startWifiPairing()
            "startNfcPairing" -> startNfcPairing()
            "startLocationPairing" -> startLocationPairing()
            "startTransferService" -> startTransferService()
            "setRoomContext" -> {
                setRoomContext(
                    roomCode = payload?.optString("roomCode"),
                    role = payload?.optString("role"),
                    targetRoom = payload?.optString("targetRoom"),
                )
            }
        }
    }

    private fun ensureRuntimePermissions(
        reason: String,
        actionToResume: String,
        payload: JSONObject?,
    ): Boolean {
        val owner = activity as? MainActivity ?: return true
        val granted = owner.ensureRuntimePermissionsForNative(reason)
        if (!granted) {
            pendingAction = actionToResume
            pendingPayload = payload
            sendInfo("Permission prompt shown for $reason.")
        }
        return granted
    }

    private fun activePairingRoomCode(): String {
        val contextRoom = normalizeRoomCode(roomCode)
        val targetRoom = normalizeRoomCode(targetRoomCode)
        return when {
            role.equals("host", ignoreCase = true) && contextRoom != null -> contextRoom
            role.equals("joiner", ignoreCase = true) && targetRoom != null -> targetRoom
            contextRoom != null -> contextRoom
            else -> generateRoomCode().also { roomCode = it }
        }
    }

    private fun handleRoomCodeDiscovery(code: String, source: String) {
        val normalized = normalizeRoomCode(code) ?: return

        val type =
            when (source) {
                "location", "location-room", "wifi-fingerprint" -> "location-room-hint"
                else -> "pairing-code"
            }

        val payload =
            JSONObject()
                .put("type", type)
                .put("code", normalized)
                .put("source", source)

        dispatch(payload)
    }

    private fun sendPairingCode(code: String, source: String) {
        val normalized = normalizeRoomCode(code) ?: return
        val payload =
            JSONObject()
                .put("type", "pairing-code")
                .put("code", normalized)
                .put("source", source)
        dispatch(payload)
    }

    private fun sendInfo(message: String) {
        val payload =
            JSONObject()
                .put("type", "info")
                .put("message", message)

        dispatch(payload)
    }

    private fun dispatch(payload: JSONObject) {
        activity.runOnUiThread {
            val script = "window.handleNativeBridgeMessage(${payload.toString()});"
            webView.evaluateJavascript(script, null)
        }
    }
}
