package com.ShareVia.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import org.json.JSONObject

class NearbyRoomDiscoveryManager(
    context: Context,
    private val onDiscoveryHint: (NativeDiscoveryHint) -> Unit,
    private val onInfo: (String) -> Unit,
    private val onData: (endpointId: String, payload: String) -> Unit,
    private val onConnected: (endpointId: String, endpointName: String) -> Unit,
    private val onDisconnected: (endpointId: String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val connectionsClient: ConnectionsClient = Nearby.getConnectionsClient(appContext)
    private var localRoomCode: String? = null
    private val endpointNames: MutableMap<String, String> = mutableMapOf()

    @SuppressLint("MissingPermission")
    fun start(roomCode: String?, advertise: Boolean = true) {
        val normalizedRoom = normalizeRoomCode(roomCode)
        if (advertise && normalizedRoom == null) {
            onInfo("Nearby pairing skipped: invalid room code.")
            return
        }

        stop()
        localRoomCode = normalizedRoom
        val strategy = Strategy.P2P_CLUSTER

        if (advertise && normalizedRoom != null) {
            val endpointName = buildEndpointName(normalizedRoom)
            runCatching {
                val advertisingOptions = AdvertisingOptions.Builder().setStrategy(strategy).build()
                connectionsClient.startAdvertising(
                    endpointName,
                    SERVICE_ID,
                    connectionLifecycleCallback,
                    advertisingOptions,
                ).addOnFailureListener {
                    onInfo("Nearby advertise failed: ${it.message ?: "unknown error"}")
                }
            }.onFailure {
                onInfo("Nearby advertise failed to start: ${it.message ?: "unknown error"}")
            }
        } else {
            onInfo("Nearby scan-only mode started.")
        }

        runCatching {
            val discoveryOptions = DiscoveryOptions.Builder().setStrategy(strategy).build()
            connectionsClient.startDiscovery(
                SERVICE_ID,
                endpointDiscoveryCallback,
                discoveryOptions,
            ).addOnFailureListener {
                onInfo("Nearby discovery failed: ${it.message ?: "unknown error"}")
            }
        }.onFailure {
            onInfo("Nearby discovery failed to start: ${it.message ?: "unknown error"}")
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        runCatching { connectionsClient.stopAdvertising() }
        runCatching { connectionsClient.stopDiscovery() }
        runCatching { connectionsClient.stopAllEndpoints() }
    }

    fun sendData(endpointId: String, data: String) {
        val payload = Payload.fromBytes(data.toByteArray(Charsets.UTF_8))
        runCatching {
            connectionsClient.sendPayload(endpointId, payload)
        }.onFailure {
            onInfo("Nearby sendData failed: ${it.message}")
        }
    }

    @SuppressLint("MissingPermission")
    private fun connectToEndpoint(endpointId: String, endpointName: String?) {
        val advertisedCode = extractRoomCode(endpointName)
        val displayName = extractDisplayName(endpointName)
        if (!displayName.isNullOrBlank()) {
            endpointNames[endpointId] = displayName
        }
        if (advertisedCode != null) {
            onDiscoveryHint(
                NativeDiscoveryHint(
                    code = advertisedCode,
                    source = "nearby",
                    deviceName = displayName ?: endpointName,
                    deviceId = endpointId,
                ),
            )
        }

        val requesterName = buildEndpointName(localRoomCode ?: generateRoomCode())

        runCatching {
            connectionsClient.requestConnection(
                requesterName,
                endpointId,
                connectionLifecycleCallback,
            ).addOnFailureListener {
                onInfo("Nearby requestConnection failed: ${it.message ?: "unknown error"}")
            }
        }.onFailure {
            onInfo("Nearby requestConnection failed: ${it.message ?: "unknown error"}")
        }
    }

    private fun statusLabel(statusCode: Int): String =
        when (statusCode) {
            ConnectionsStatusCodes.STATUS_OK -> "ok"
            ConnectionsStatusCodes.STATUS_CONNECTION_REJECTED -> "rejected"
            ConnectionsStatusCodes.STATUS_ERROR -> "error"
            else -> "code=$statusCode"
        }

    private val endpointDiscoveryCallback =
        object : EndpointDiscoveryCallback() {
            override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
                connectToEndpoint(endpointId, info.endpointName)
            }

            override fun onEndpointLost(endpointId: String) {
                onInfo("Nearby endpoint lost: $endpointId")
            }
        }

    private val connectionLifecycleCallback =
        object : ConnectionLifecycleCallback() {
            @SuppressLint("MissingPermission")
            override fun onConnectionInitiated(endpointId: String, connectionInfo: ConnectionInfo) {
                val endpointName = connectionInfo.endpointName
                val endpointCode = extractRoomCode(endpointName)
                val displayName = extractDisplayName(endpointName)
                if (!displayName.isNullOrBlank()) {
                    endpointNames[endpointId] = displayName
                }
                if (endpointCode != null) {
                    onDiscoveryHint(
                        NativeDiscoveryHint(
                            code = endpointCode,
                            source = "nearby",
                            deviceName = displayName ?: endpointName,
                            deviceId = endpointId,
                        ),
                    )
                }

                connectionsClient.acceptConnection(endpointId, payloadCallback)
            }

            override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
                val status = result.status.statusCode
                if (status == ConnectionsStatusCodes.STATUS_OK) {
                    val name = endpointNames[endpointId] ?: endpointId
                    onConnected(endpointId, name)
                    
                    localRoomCode?.let { room ->
                        val payload = Payload.fromBytes("ROOM:$room".toByteArray())
                        runCatching {
                            connectionsClient.sendPayload(endpointId, payload)
                        }
                    }
                    return
                }

                onInfo("Nearby connection failed: ${statusLabel(status)}")
            }

            override fun onDisconnected(endpointId: String) {
                endpointNames.remove(endpointId)
                onDisconnected(endpointId)
                onInfo("Nearby disconnected: $endpointId")
            }
        }

    private val payloadCallback =
        object : PayloadCallback() {
            override fun onPayloadReceived(endpointId: String, payload: Payload) {
                val bytes = payload.asBytes() ?: return
                val decoded = String(bytes, Charsets.UTF_8)
                
                if (decoded.startsWith("ROOM:")) {
                    val code = extractRoomCode(decoded.substring(5)) ?: return
                    onDiscoveryHint(
                        NativeDiscoveryHint(
                            code = code,
                            source = "nearby",
                            deviceName = endpointNames[endpointId] ?: endpointId,
                            deviceId = endpointId,
                        ),
                    )
                } else {
                    onData(endpointId, decoded)
                }
            }

            override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            }
        }

    private fun buildEndpointName(roomCode: String): String {
        val alias = localDeviceAlias()
        return "$ENDPOINT_PREFIX$roomCode|$alias"
    }

    private fun localDeviceAlias(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty().trim()
        val model = Build.MODEL.orEmpty().trim()
        val combined =
            when {
                manufacturer.isBlank() -> model
                model.startsWith(manufacturer, ignoreCase = true) -> model
                else -> "$manufacturer $model"
            }

        return combined
            .replace(Regex("[^A-Za-z0-9 _-]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(24)
            .ifBlank { "Android Device" }
    }

    private fun extractDisplayName(endpointName: String?): String? {
        val raw = endpointName?.trim().orEmpty()
        if (raw.isBlank()) {
            return null
        }

        val pipeIndex = raw.indexOf('|')
        if (pipeIndex >= 0 && pipeIndex < raw.lastIndex) {
            return raw.substring(pipeIndex + 1).trim().ifBlank { null }
        }

        return if (raw.startsWith(ENDPOINT_PREFIX)) null else raw
    }

    companion object {
        private const val SERVICE_ID = "com.ShareVia.app.nearby.room"
        private const val ENDPOINT_PREFIX = "SV-"
    }
}
