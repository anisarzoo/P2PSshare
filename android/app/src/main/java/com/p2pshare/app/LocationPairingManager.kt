package com.p2pshare.app

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.WifiManager
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.util.Locale

class LocationPairingManager(
    context: Context,
    private val onRoomCode: (String, String) -> Unit,
    private val onInfo: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val fusedLocationClient = LocationServices.getFusedLocationProviderClient(appContext)
    private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    @SuppressLint("MissingPermission")
    fun start(currentRoomCode: String?) {
        val currentRoom = normalizeRoomCode(currentRoomCode)
        if (currentRoom != null) {
            onRoomCode(currentRoom, "location-room")
        }

        emitWifiFingerprintHint()
        emitLocationHint()
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
        onRoomCode(code, "wifi-fingerprint")
        onInfo("Wi-Fi pairing hint generated.")
    }

    @SuppressLint("MissingPermission")
    private fun emitLocationHint() {
        val tokenSource = CancellationTokenSource()

        fusedLocationClient
            .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, tokenSource.token)
            .addOnSuccessListener { location ->
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
                onRoomCode(code, "location")
                onInfo("Location-assisted pairing hint generated.")
            }
            .addOnFailureListener {
                onInfo("Location hint failed: ${it.message ?: "unknown error"}")
            }
    }

    companion object {
        private const val DAY_MS = 24 * 60 * 60 * 1000L
    }
}

