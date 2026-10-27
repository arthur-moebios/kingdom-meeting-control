package com.salaodoreino.tribuna.ui

/** A raised hand shown on the tribune panel. */
data class Hand(val id: String, val name: String, val minutesAgo: Int)

/** Placeholder content for the UI preview — replaced by live backend data in v2. */
object Sample {
    val hands = listOf(
        Hand("1", "Carlos Almeida", 2),
        Hand("2", "Mariana Costa", 5),
        Hand("3", "Roberto Silva", 7),
    )

    const val participants = 28

    const val announcements = """Boa noite, irmãos!

Sejam todos bem-vindos à nossa reunião.

Avisos
• A próxima atividade será realizada no sábado, às 19h.
• Lembramos que as informações completas estão disponíveis no quadro de anúncios.
• Pedimos que todos mantenham seus dispositivos no modo silencioso.

Obrigado pela atenção de todos."""
}
