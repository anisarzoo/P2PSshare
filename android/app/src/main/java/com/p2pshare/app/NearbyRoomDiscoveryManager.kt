package com.ShareVia.app

import android.annotation.SuppressLint
import android.content.Context
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

class NearbyRoomDiscoveryManager(
    context: Context,
    private val onDiscoveryHint: (NativeDiscoveryHint) -> Unit,
    private val onInfo: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val connectionsClient: ConnectionsClient = Nearby.getConnectionsClient(appContext)
    private var localRoomCode: String? = null

    @SuppressLint("MissingPermission")
    fun start(roomCode: String) {
        val normalizedRoom = normalizeRoomCode(roomCode)
        if (normalizedRoom == null) {
            onInfo("Nearby pairing skipped: invalid room code.")
            return
        }

        stop()
        localRoomCode = normalizedRoom

        val endpointName = "$ENDPOINT_PREFIX$normalizedRoom"
        val strategy = Strategy.P2P_CLUSTER

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

    @SuppressLint("MissingPermission")
    private fun connectToEndpoint(endpointId: String, endpointName: String?) {
        val advertisedCode = extractRoomCode(endpointName)
        if (advertisedCode != null) {
            onDiscoveryHint(
                NativeDiscoveryHint(
                    code = advertisedCode,
                    source = "nearby",
                    deviceName = endpointName,
                    deviceId = endpointId,
                ),
            )
        }

        val requesterName = "$ENDPOINT_PREFIX${localRoomCode ?: generateRoomCode()}"

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
                if (endpointCode != null) {
                    onDiscoveryHint(
                        NativeDiscoveryHint(
                            code = endpointCode,
                            source = "nearby",
                            deviceName = endpointName,
                            deviceId = endpointId,
                        ),
                    )
                }

                connectionsClient.acceptConnection(endpointId, payloadCallback)
            }

            override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
                val status = result.status.statusCode
                if (status == ConnectionsStatusCodes.STATUS_OK) {
                    localRoomCode?.let { room ->
                        val payload = Payload.fromBytes(room.toByteArray())
                        runCatching {
                            connectionsClient.sendPayload(endpointId, payload)
                        }
                    }
                    return
                }

                onInfo("Nearby connection failed: ${statusLabel(status)}")
            }

            override fun onDisconnected(endpointId: String) {
                onInfo("Nearby disconnected: $endpointId")
            }
        }

    private val payloadCallback =
        object : PayloadCallback() {
            override fun onPayloadReceived(endpointId: String, payload: Payload) {
                val bytes = payload.asBytes() ?: return
                val decoded = String(bytes, Charsets.UTF_8)
                val code = extractRoomCode(decoded) ?: return
                onDiscoveryHint(
                    NativeDiscoveryHint(
                        code = code,
                        source = "nearby",
                        deviceName = endpointId,
                        deviceId = endpointId,
                    ),
                )
            }

            override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
                // No-op: room hints use tiny byte payloads.
            }
        }

    companion object {
        private const val SERVICE_ID = "com.ShareVia.app.nearby.room"
        private const val ENDPOINT_PREFIX = "CV-"
    }
}


