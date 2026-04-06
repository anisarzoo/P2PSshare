package com.ShareVia.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var nativeBridge: NativeBridge
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null

    private val filePicker =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            filePathCallback?.onReceiveValue(if (uris.isNullOrEmpty()) null else uris.toTypedArray())
            filePathCallback = null
        }

    private val runtimePermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grantMap ->
            val allGranted = grantMap.values.all { it }

            pendingPermissionRequest?.let { request ->
                if (allGranted) {
                    runOnUiThread { request.grant(request.resources) }
                } else {
                    runOnUiThread { request.deny() }
                }
                pendingPermissionRequest = null
            }

            if (this::nativeBridge.isInitialized) {
                nativeBridge.onRuntimePermissionsResult(grantMap)
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.webChromeClient =
            object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = filePathCallback
                    filePicker.launch(arrayOf("*/*"))
                    return true
                }

                override fun onPermissionRequest(request: PermissionRequest) {
                    val resources = request.resources
                    val permissionsNeeded = mutableListOf<String>()
                    
                    for (resource in resources) {
                        when (resource) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> permissionsNeeded.add(Manifest.permission.CAMERA)
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> permissionsNeeded.add(Manifest.permission.RECORD_AUDIO)
                        }
                    }

                    if (permissionsNeeded.isEmpty()) {
                        runOnUiThread { request.grant(resources) }
                    } else {
                        val missing = permissionsNeeded.filter {
                            ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED
                        }
                        
                        if (missing.isEmpty()) {
                            runOnUiThread { request.grant(resources) }
                        } else {
                            pendingPermissionRequest = request
                            runtimePermissionLauncher.launch(missing.toTypedArray())
                        }
                    }
                }
            }

        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    return false
                }
            }

        nativeBridge = NativeBridge(this, webView)
        webView.addJavascriptInterface(nativeBridge, "NativeP2PBridge")

        // Copy the latest web files into app/src/main/assets for local/offline startup.
        webView.loadUrl("file:///android_asset/index.html")
    }

    fun ensureRuntimePermissionsForNative(reason: String): Boolean {
        val required = requiredRuntimePermissions(reason)
        val missing =
            required.filter { permission ->
                ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED
            }

        if (missing.isEmpty()) {
            return true
        }

        if (this::nativeBridge.isInitialized) {
            nativeBridge.onRuntimePermissionsRequested(reason, missing)
        }

        runtimePermissionLauncher.launch(missing.toTypedArray())
        return false
    }

    private fun requiredRuntimePermissions(reason: String): List<String> {
        val reasonText = reason.lowercase()
        val permissions = linkedSetOf<String>()

        val needsWirelessPermissions =
            reasonText.contains("bluetooth") ||
                reasonText.contains("wifi") ||
                reasonText.contains("location")

        if (needsWirelessPermissions) {
            permissions += Manifest.permission.ACCESS_COARSE_LOCATION
            permissions += Manifest.permission.ACCESS_FINE_LOCATION
        }

        if (reasonText.contains("camera")) {
            permissions += Manifest.permission.CAMERA
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (needsWirelessPermissions) {
                permissions += Manifest.permission.BLUETOOTH_SCAN
                permissions += Manifest.permission.BLUETOOTH_CONNECT
                permissions += Manifest.permission.BLUETOOTH_ADVERTISE
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (reasonText.contains("wifi")) {
                permissions += Manifest.permission.NEARBY_WIFI_DEVICES
            }
            if (reasonText.contains("background") || reasonText.contains("transfer")) {
                permissions += Manifest.permission.POST_NOTIFICATIONS
            }
        }

        return permissions.toList()
    }

    override fun onDestroy() {
        if (this::nativeBridge.isInitialized) {
            nativeBridge.onDestroy()
        }
        webView.removeJavascriptInterface("NativeP2PBridge")
        webView.destroy()
        super.onDestroy()
    }
}
