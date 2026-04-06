package com.ShareVia.app

import android.app.Activity
import android.content.pm.PackageManager
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
            ::handleDiscoveryHint,
            ::sendInfo,
        )

    private val nearbyRoomDiscoveryManager =
        NearbyRoomDiscoveryManager(
            activity.applicationContext,
            ::handleDiscoveryHint,
            ::sendInfo,
            ::handleNearbyData,
            ::handleNearbyConnected,
            ::handleNearbyDisconnected,
        )

    private val locationPairingManager =
        LocationPairingManager(
            activity.applicationContext,
            ::handleDiscoveryHint,
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

        val announcedRoom = if (role.equals("idle", ignoreCase = true)) null else activePairingRoomCode()
        val canAdvertise = announcedRoom != null
        bleRoomDiscoveryManager.start(announcedRoom, advertise = canAdvertise)
        nearbyRoomDiscoveryManager.start(announcedRoom, advertise = canAdvertise)
        if (announcedRoom != null) {
            sendPairingCode(announcedRoom, source = "bluetooth")
        }
        sendInfo(
            if (canAdvertise) {
                "Bluetooth + Nearby pairing started."
            } else {
                "Bluetooth + Nearby scan started."
            },
        )
    }

    @JavascriptInterface
    fun startWifiPairing() {
        if (!ensureRuntimePermissions("wifi pairing", "startWifiPairing", null)) {
            return
        }

        val announcedRoom = if (role.equals("idle", ignoreCase = true)) null else activePairingRoomCode()
        val canAdvertise = announcedRoom != null
        nearbyRoomDiscoveryManager.start(announcedRoom, advertise = canAdvertise)
        if (canAdvertise) {
            locationPairingManager.start(announcedRoom)
        } else {
            locationPairingManager.stop()
        }
        if (announcedRoom != null) {
            sendPairingCode(announcedRoom, source = "wifi")
        }
        sendInfo(
            if (canAdvertise) {
                "Wi-Fi/Nearby pairing started."
            } else {
                "Wi-Fi/Nearby scan started."
            },
        )
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

        val announcedRoom = if (role.equals("idle", ignoreCase = true)) null else activePairingRoomCode()
        val nfcRoom = announcedRoom ?: generateRoomCode().also { roomCode = it }
        sendPairingCode(nfcRoom, source = "nfc")
        sendInfo("NFC pairing ready. Bring devices close and share room code if needed.")
    }

    @JavascriptInterface
    fun startLocationPairing() {
        if (!ensureRuntimePermissions("location pairing", "startLocationPairing", null)) {
            return
        }

        val announcedRoom = if (role.equals("idle", ignoreCase = true)) null else activePairingRoomCode()
        locationPairingManager.start(announcedRoom)
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
        locationPairingManager.stop()
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
    fun getNativeCapabilities() {
        val packageManager = activity.packageManager
        val nfcAdapter = NfcAdapter.getDefaultAdapter(activity)
        val bluetoothSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)
        val bluetoothLeSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val wifiSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)

        val payload =
            JSONObject()
                .put("type", "native-capabilities")
                .put("nfcSupported", nfcAdapter != null)
                .put("nfcEnabled", nfcAdapter?.isEnabled ?: false)
                .put("bluetoothSupported", bluetoothSupported)
                .put("bluetoothLeSupported", bluetoothLeSupported)
                .put("wifiSupported", wifiSupported)
                .put("locationSupported", true)

        dispatch(payload)
    }

    @JavascriptInterface
    fun sendNearbyData(endpointId: String, data: String) {
        nearbyRoomDiscoveryManager.sendData(endpointId, data)
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
            "getNativeCapabilities" -> getNativeCapabilities()
            "sendNearbyData" -> {
                val endpointId = payload?.optString("endpointId").orEmpty()
                val data = payload?.optString("data").orEmpty()
                sendNearbyData(endpointId, data)
            }
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

    private fun handleNearbyData(endpointId: String, data: String) {
        val payload = JSONObject()
            .put("type", "nearby-data")
            .put("endpointId", endpointId)
            .put("data", data)
        dispatch(payload)
    }

    private fun handleNearbyConnected(endpointId: String, endpointName: String) {
        val payload = JSONObject()
            .put("type", "nearby-connected")
            .put("endpointId", endpointId)
            .put("endpointName", endpointName)
        dispatch(payload)
    }

    private fun handleNearbyDisconnected(endpointId: String) {
        val payload = JSONObject()
            .put("type", "nearby-disconnected")
            .put("endpointId", endpointId)
        dispatch(payload)
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

    private fun handleDiscoveryHint(hint: NativeDiscoveryHint) {
        val normalized = normalizeRoomCode(hint.code) ?: return
        val source = hint.source
        val name = hint.deviceName?.trim().orEmpty()

        val nearPayload =
            JSONObject()
                .put("type", "nearby-device")
                .put("code", normalized)
                .put("source", source)
                .put("deviceName", name)
                .put("deviceId", hint.deviceId ?: "${source}_$normalized")

        if (hint.signal != null) {
            nearPayload.put("signal", hint.signal)
        }

        dispatch(nearPayload)

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
                .put("deviceName", name)
                .put("deviceId", hint.deviceId ?: "${source}_$normalized")

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
