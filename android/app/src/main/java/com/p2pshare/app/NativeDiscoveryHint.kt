package com.ShareVia.app

data class NativeDiscoveryHint(
    val code: String,
    val source: String,
    val deviceName: String? = null,
    val deviceId: String? = null,
    val signal: Int? = null,
)


