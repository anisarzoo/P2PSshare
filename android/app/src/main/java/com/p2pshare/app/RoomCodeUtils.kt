package com.ShareVia.app

import kotlin.random.Random

private val ROOM_CODE_REGEX = Regex("""\b(\d{6})\b""")

fun normalizeRoomCode(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    return if (trimmed.matches(Regex("""\d{6}"""))) trimmed else null
}

fun extractRoomCode(raw: String?): String? {
    val input = raw?.trim().orEmpty()
    if (input.isEmpty()) {
        return null
    }

    val match = ROOM_CODE_REGEX.find(input) ?: return null
    return match.groupValues.getOrNull(1)
}

fun generateRoomCode(): String = Random.nextInt(100_000, 1_000_000).toString()

fun deriveRoomCode(seed: String): String {
    val hash = seed.hashCode().toLong() and 0x7fffffff
    val normalized = (hash % 900_000L) + 100_000L
    return normalized.toString()
}



