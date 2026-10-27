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

/** One timed meeting part (from wol.jw.org, timer controlled on the PC). */
@Serializable
data class MeetingPart(
    val id: String,
    val section: String = "",
    val order: Int = 0,
    val title: String = "",
    val allottedSec: Int = 0,
    val running: Boolean = false,
    val startedAt: String? = null,
    val baseElapsedSec: Double = 0.0,
    val source: String = "wol",
)

@Serializable
data class TabletCfg(val announcements: String = "")

/** Only the fields the tablet needs from the backend's settings. */
@Serializable
data class AppSettings(val tablet: TabletCfg = TabletCfg())

@Serializable
data class MeetingSchedule(
    val source: String = "none",
    val kind: String? = null,
    val weekLabel: String = "",
    val title: String = "",
    val activePartId: String? = null,
    val parts: List<MeetingPart> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)
