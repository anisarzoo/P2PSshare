package com.p2pshare.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.nio.charset.StandardCharsets
import java.util.UUID

class BleRoomDiscoveryManager(
    context: Context,
    private val onRoomCode: (String, String) -> Unit,
    private val onInfo: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val bluetoothManager = appContext.getSystemService(BluetoothManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanCallback: ScanCallback? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var running = false

    @SuppressLint("MissingPermission")
    fun start(roomCode: String) {
        val normalizedRoom = normalizeRoomCode(roomCode)
        if (normalizedRoom == null) {
            onInfo("BLE pairing skipped: invalid room code.")
            return
        }

        val adapter = bluetoothManager?.adapter
        if (adapter == null) {
            onInfo("BLE not available on this device.")
            return
        }

        if (!adapter.isEnabled) {
            onInfo("Bluetooth is off. Enable Bluetooth to pair.")
            return
        }

        stop()
        running = true

        scanner = adapter.bluetoothLeScanner
        advertiser = adapter.bluetoothLeAdvertiser

        startScan()
        startAdvertising(normalizedRoom)
        scheduleAutoStop()
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        mainHandler.removeCallbacksAndMessages(null)

        scanCallback?.let { callback ->
            runCatching { scanner?.stopScan(callback) }
        }
        advertiseCallback?.let { callback ->
            runCatching { advertiser?.stopAdvertising(callback) }
        }

        scanCallback = null
        advertiseCallback = null
        running = false
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        val activeScanner = scanner
        if (activeScanner == null) {
            onInfo("BLE scanner unavailable.")
            return
        }

        val filter =
            ScanFilter.Builder()
                .setServiceUuid(PARCEL_SERVICE_UUID)
                .build()

        val settings =
            ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()

        scanCallback =
            object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult?) {
                    parseScanResult(result)
                }

                override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                    results?.forEach { parseScanResult(it) }
                }

                override fun onScanFailed(errorCode: Int) {
                    onInfo("BLE scan failed (code=$errorCode).")
                }
            }

        runCatching {
            activeScanner.startScan(listOf(filter), settings, scanCallback)
            onInfo("BLE scanning started.")
        }.onFailure { error ->
            onInfo("BLE scanning unavailable: ${error.message ?: "unknown error"}")
        }
    }

    @SuppressLint("MissingPermission")
    private fun startAdvertising(roomCode: String) {
        val activeAdvertiser = advertiser
        if (activeAdvertiser == null) {
            onInfo("BLE advertising unavailable on this device.")
            return
        }

        val advertiseData =
            AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(PARCEL_SERVICE_UUID)
                .addServiceData(PARCEL_SERVICE_UUID, roomCode.toByteArray(StandardCharsets.UTF_8))
                .build()

        val settings =
            AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setConnectable(false)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build()

        advertiseCallback =
            object : AdvertiseCallback() {
                override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                    onInfo("BLE advertising room $roomCode.")
                }

                override fun onStartFailure(errorCode: Int) {
                    onInfo("BLE advertise failed (code=$errorCode).")
                }
            }

        runCatching {
            activeAdvertiser.startAdvertising(settings, advertiseData, advertiseCallback)
        }.onFailure { error ->
            onInfo("BLE advertise unavailable: ${error.message ?: "unknown error"}")
        }
    }

    private fun parseScanResult(result: ScanResult?) {
        if (!running || result == null) {
            return
        }

        val fromServiceData =
            runCatching {
                result.scanRecord
                    ?.getServiceData(PARCEL_SERVICE_UUID)
                    ?.let { bytes -> String(bytes, StandardCharsets.UTF_8) }
            }.getOrNull()

        val fromName = extractRoomCode(result.device?.name)
        val fromData = extractRoomCode(fromServiceData)
        val roomCode = fromData ?: fromName ?: return
        onRoomCode(roomCode, "ble")
    }

    private fun scheduleAutoStop() {
        mainHandler.postDelayed(
            {
                if (!running) return@postDelayed
                stop()
                onInfo("BLE pairing window ended.")
            },
            AUTO_STOP_MS,
        )
    }

    companion object {
        private const val AUTO_STOP_MS = 2 * 60 * 1000L
        private val SERVICE_UUID: UUID = UUID.fromString("0000c0de-0000-1000-8000-00805f9b34fb")
        private val PARCEL_SERVICE_UUID = ParcelUuid(SERVICE_UUID)
    }
}
