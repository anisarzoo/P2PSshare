package com.p2pshare.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class TransferForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        if (action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        val statusText = intent?.getStringExtra(EXTRA_STATUS_TEXT) ?: DEFAULT_STATUS
        startForegroundCompat(statusText)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = CHANNEL_DESCRIPTION
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(channel)
    }

    private fun buildNotification(statusText: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ConnectVia transfer running")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    private fun startForegroundCompat(statusText: String) {
        val notification = buildNotification(statusText)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val typeMask =
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            startForeground(NOTIFICATION_ID, notification, typeMask)
            return
        }

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            return
        }

        @Suppress("DEPRECATION")
        stopForeground(true)
    }

    companion object {
        private const val CHANNEL_ID = "connectvia_transfer"
        private const val CHANNEL_NAME = "ConnectVia Transfers"
        private const val CHANNEL_DESCRIPTION = "Keeps transfer sessions alive in background mode."
        private const val NOTIFICATION_ID = 3004
        private const val EXTRA_STATUS_TEXT = "extra_status_text"
        private const val DEFAULT_STATUS = "Connected and ready to transfer files."

        private const val ACTION_START = "com.p2pshare.app.action.START_TRANSFER_SERVICE"
        private const val ACTION_STOP = "com.p2pshare.app.action.STOP_TRANSFER_SERVICE"
        private const val ACTION_UPDATE = "com.p2pshare.app.action.UPDATE_TRANSFER_SERVICE"

        fun start(context: Context, statusText: String = DEFAULT_STATUS) {
            dispatch(context, ACTION_START, statusText)
        }

        fun update(context: Context, statusText: String) {
            dispatch(context, ACTION_UPDATE, statusText)
        }

        fun stop(context: Context) {
            val intent =
                Intent(context, TransferForegroundService::class.java).apply {
                    action = ACTION_STOP
                }
            runCatching {
                context.startService(intent)
            }
        }

        private fun dispatch(context: Context, action: String, statusText: String) {
            val intent =
                Intent(context, TransferForegroundService::class.java).apply {
                    this.action = action
                    putExtra(EXTRA_STATUS_TEXT, statusText)
                }

            runCatching {
                ContextCompat.startForegroundService(context, intent)
            }
        }
    }
}

