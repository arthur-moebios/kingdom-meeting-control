package com.salaodoreino.tribuna.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Lenient JSON — tolerate backend fields we don't model. */
val AppJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
}

@Serializable
data class ZoomStatus(
    val state: String = "STOPPED",
    val authenticated: Boolean = false,
    val browserRunning: Boolean = false,
    val meetingId: String? = null,
    val sharing: Boolean = false,
    val participantCount: Int = 0,
    val lastError: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class Participant(
    val id: String,
    val displayName: String = "",
    val handRaised: Boolean = false,
    val handRaisedAt: String? = null,
    val isHost: Boolean = false,
    val isCoHost: Boolean = false,
    val isMuted: Boolean? = null,
)

@Serializable
data class RaisedHands(
    val order: List<Participant> = emptyList(),
    val orderSource: String = "unknown",
    val partial: Boolean = false,
)
