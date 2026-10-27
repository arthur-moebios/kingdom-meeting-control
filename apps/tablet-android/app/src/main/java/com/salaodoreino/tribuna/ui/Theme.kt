package com.salaodoreino.tribuna.ui

import androidx.compose.ui.graphics.Color
import kotlin.math.abs

/** Palette matching the Speaker Panel mockup (dark navy, blue accent). */
object C {
    val bg = Color(0xFF0A1120)
    val card = Color(0xFF111C2E)
    val cardAlt = Color(0xFF0D1626)
    val border = Color(0xFF203049)
    val fg = Color(0xFFF1F5F9)
    val muted = Color(0xFF93A3B8)
    val blue = Color(0xFF2F6FED)
    val green = Color(0xFF22C55E)
    val lime = Color(0xFFA3E635)
    val red = Color(0xFFD83A3A)
    val amber = Color(0xFFF59E0B)

    val avatar = listOf(
        Color(0xFF3B82F6), Color(0xFFEC4899), Color(0xFF22C55E),
        Color(0xFFF59E0B), Color(0xFF8B5CF6), Color(0xFF06B6D4),
    )
}

fun avatarColor(name: String): Color = C.avatar[abs(name.hashCode()) % C.avatar.size]

fun initials(name: String): String =
    name.trim().split(" ").filter { it.isNotEmpty() }
        .take(2).joinToString("") { it.first().uppercaseChar().toString() }

fun mmss(totalSeconds: Int): String {
    val s = if (totalSeconds < 0) 0 else totalSeconds
    return "%02d:%02d".format(s / 60, s % 60)
}
