package com.salaodoreino.tribuna.ui

import androidx.compose.ui.graphics.Color
import kotlin.math.abs

/**
 * Palette for the Speaker Panel. Values are mutable so the app can switch
 * between dark and light. MainActivity calls [C.applyTheme] on start (and on
 * each recreate when the system theme changes), before composition reads them.
 */
object C {
    var bg = Color(0xFF0A1120)
    var card = Color(0xFF111C2E)
    var cardAlt = Color(0xFF0D1626)
    var border = Color(0xFF203049)
    var fg = Color(0xFFF1F5F9)
    var muted = Color(0xFF93A3B8)
    var blue = Color(0xFF2F6FED)
    var green = Color(0xFF22C55E)
    var lime = Color(0xFFA3E635)
    var red = Color(0xFFD83A3A)
    var amber = Color(0xFFF59E0B)

    val avatar = listOf(
        Color(0xFF3B82F6), Color(0xFFEC4899), Color(0xFF22C55E),
        Color(0xFFF59E0B), Color(0xFF8B5CF6), Color(0xFF06B6D4),
    )

    fun applyTheme(dark: Boolean) {
        if (dark) {
            bg = Color(0xFF0A1120); card = Color(0xFF111C2E); cardAlt = Color(0xFF0D1626)
            border = Color(0xFF203049); fg = Color(0xFFF1F5F9); muted = Color(0xFF93A3B8)
            blue = Color(0xFF2F6FED); green = Color(0xFF22C55E); lime = Color(0xFFA3E635)
            red = Color(0xFFD83A3A); amber = Color(0xFFF59E0B)
        } else {
            bg = Color(0xFFF4F6FA); card = Color(0xFFFFFFFF); cardAlt = Color(0xFFEDF1F7)
            border = Color(0xFFD2DCE7); fg = Color(0xFF0F172A); muted = Color(0xFF5A6B7D)
            blue = Color(0xFF2563EB); green = Color(0xFF16A34A); lime = Color(0xFF4D7C0F)
            red = Color(0xFFDC2626); amber = Color(0xFFB45309)
        }
    }
}

fun avatarColor(name: String): Color = C.avatar[abs(name.hashCode()) % C.avatar.size]

fun initials(name: String): String =
    name.trim().split(" ").filter { it.isNotEmpty() }
        .take(2).joinToString("") { it.first().uppercaseChar().toString() }

fun mmss(totalSeconds: Int): String {
    val s = if (totalSeconds < 0) 0 else totalSeconds
    return "%02d:%02d".format(s / 60, s % 60)
}

/** m:ss, keeping a leading minus for overtime (e.g. "-1:05"). */
fun mmssSigned(totalSeconds: Int): String {
    val neg = totalSeconds < 0
    val s = abs(totalSeconds)
    return "${if (neg) "-" else ""}%d:%02d".format(s / 60, s % 60)
}
