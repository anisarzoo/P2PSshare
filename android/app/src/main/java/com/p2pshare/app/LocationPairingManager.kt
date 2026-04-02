package com.ShareVia.app

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.WifiManager
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.util.Locale

class LocationPairingManager(
    context: Context,
    private val onDiscoveryHint: (NativeDiscoveryHint) -> Unit,
    private val onInfo: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val fusedLocationClient = LocationServices.getFusedLocationProviderClient(appContext)
    private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private var activeTokenSource: CancellationTokenSource? = null

    @SuppressLint("MissingPermission")
    fun start(currentRoomCode: String?) {
        stop()

        val currentRoom = normalizeRoomCode(currentRoomCode)
        if (currentRoom != null) {
            onDiscoveryHint(
                NativeDiscoveryHint(
                    code = currentRoom,
                    source = "location-room",
                    deviceName = "Current room",
                    deviceId = "local-room",
                ),
            )
        }

        emitWifiFingerprintHint()
        emitLocationHint()
    }

    fun stop() {
        activeTokenSource?.cancel()
        activeTokenSource = null
    }

    @SuppressLint("MissingPermission")
    private fun emitWifiFingerprintHint() {
        val manager = wifiManager
        if (manager == null) {
            onInfo("Wi-Fi manager not available for pairing hint.")
            return
        }

        runCatching { manager.startScan() }

        val wifiResults =
            runCatching { manager.scanResults }
                .getOrNull()
                .orEmpty()
                .sortedByDescending { it.level }

        val connectedInfo = runCatching { manager.connectionInfo }.getOrNull()
        val connectedSeed =
            listOfNotNull(
                connectedInfo?.ssid?.takeIf { it.isNotBlank() && it != "<unknown ssid>" },
                connectedInfo?.bssid?.takeIf { it.isNotBlank() },
            ).joinToString("|")

        val strongest = wifiResults.firstOrNull()
        val strongestSeed =
            listOfNotNull(
                strongest?.SSID?.takeIf { it.isNotBlank() },
                strongest?.BSSID?.takeIf { it.isNotBlank() },
            ).joinToString("|")

        val seed = listOf(connectedSeed, strongestSeed).filter { it.isNotBlank() }.joinToString("::")
        if (seed.isBlank()) {
            onInfo("Wi-Fi scan had no usable fingerprint yet.")
            return
        }

        val code = deriveRoomCode("wifi:$seed")
        onDiscoveryHint(
            NativeDiscoveryHint(
                code = code,
                source = "wifi-fingerprint",
                deviceName = "Wi-Fi vicinity",
                deviceId = "wifi-fingerprint",
            ),
        )
        onInfo("Wi-Fi pairing hint generated.")
    }

    @SuppressLint("MissingPermission")
    private fun emitLocationHint() {
        val tokenSource = CancellationTokenSource()
        activeTokenSource = tokenSource

        fusedLocationClient
            .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, tokenSource.token)
            .addOnSuccessListener { location ->
                if (activeTokenSource == tokenSource) {
                    activeTokenSource = null
                }
                if (location == null) {
                    onInfo("Location hint unavailable right now.")
                    return@addOnSuccessListener
                }

                val latBucket = (location.latitude * 500).toInt()
                val lonBucket = (location.longitude * 500).toInt()
                val dayBucket = System.currentTimeMillis() / DAY_MS
                val accuracyBucket = location.accuracy.toInt()

                val seed =
                    String.format(
                        Locale.US,
                        "loc:%d:%d:%d:%d",
                        latBucket,
                        lonBucket,
                        dayBucket,
                        accuracyBucket,
                    )

                val code = deriveRoomCode(seed)
                onDiscoveryHint(
                    NativeDiscoveryHint(
                        code = code,
                        source = "location",
                        deviceName = "Location vicinity",
                        deviceId = "location-hint",
                    ),
                )
                onInfo("Location-assisted pairing hint generated.")
            }
            .addOnFailureListener {
                if (activeTokenSource == tokenSource) {
                    activeTokenSource = null
                }
                onInfo("Location hint failed: ${it.message ?: "unknown error"}")
            }
    }

    companion object {
        private const val DAY_MS = 24 * 60 * 60 * 1000L
    }
}



