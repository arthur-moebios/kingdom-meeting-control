package com.salaodoreino.tribuna.vm

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.salaodoreino.tribuna.net.Endpoint
import com.salaodoreino.tribuna.net.KmcApi
import com.salaodoreino.tribuna.net.discoverKmc
import com.salaodoreino.tribuna.net.discoverKmcBeacon
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

enum class Conn { NO_TOKEN, SEARCHING, CONNECTED, OFFLINE }

data class HandUi(val id: String, val name: String, val minutesAgo: Int)

/** A meeting part with its timer, ready for live display. */
data class PartUi(
    val id: String,
    val section: String,
    val title: String,
    val allottedSec: Int,
    val baseElapsedSec: Double,
    val running: Boolean,
    val startedAtMs: Long?,
    val active: Boolean,
)

data class UiState(
    val conn: Conn = Conn.SEARCHING,
    val participantCount: Int = 0,
    val meetingLive: Boolean = false,
    val hands: List<HandUi> = emptyList(),
    val partial: Boolean = false,
    val host: String? = null,
    val weekLabel: String = "",
    val parts: List<PartUi> = emptyList(),
    val announcements: String = "",
    /** Manually-configured PC address (IP[:port]); empty = use NSD discovery. */
    val manualHost: String = "",
)

/** Token storage (viewer, read-only) in SharedPreferences. */
object Prefs {
    private const val FILE = "kmc"
    private const val KEY_TOKEN = "viewer_token"
    private const val KEY_HOST = "manual_host"
    fun token(c: Context): String =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_TOKEN, "") ?: ""
    fun setToken(c: Context, t: String) =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, t).apply()
    fun host(c: Context): String =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_HOST, "") ?: ""
    fun setHost(c: Context, h: String) =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_HOST, h).apply()
}

/**
 * Discovers the Salão PC (NSD), then polls the read-only viewer API every 2s for
 * status + raised hands. Hand dismissals are LOCAL to the tribune (we never
 * control Zoom from here).
 */
class TribunaViewModel(app: Application) : AndroidViewModel(app) {
    @Volatile private var token: String = Prefs.token(app)
    @Volatile private var manualHost: String = Prefs.host(app)
    @Volatile private var beaconEndpoint: Endpoint? = null
    @Volatile private var nsdEndpoint: Endpoint? = null
    private val dismissed = mutableSetOf<String>()

    private val _state = MutableStateFlow(UiState(manualHost = manualHost))
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        // Primary: DHCP-proof UDP beacon. Secondary: mDNS/NSD. Manual IP overrides.
        viewModelScope.launch {
            discoverKmcBeacon(getApplication()).collect { beaconEndpoint = it }
        }
        viewModelScope.launch {
            discoverKmc(getApplication()).collect { nsdEndpoint = it }
        }
        viewModelScope.launch {
            while (isActive) {
                tick()
                delay(2000)
            }
        }
    }

    fun setToken(t: String) {
        token = t.trim()
        Prefs.setToken(getApplication(), token)
    }

    fun setHost(h: String) {
        manualHost = h.trim()
        Prefs.setHost(getApplication(), manualHost)
        _state.update { it.copy(manualHost = manualHost) }
    }

    /** Manual endpoint from "ip" or "ip:port"; null when not configured. */
    private fun manualEndpoint(): Endpoint? {
        val h = manualHost.trim()
        if (h.isBlank()) return null
        val parts = h.split(":")
        val host = parts[0].trim()
        val port = parts.getOrNull(1)?.trim()?.toIntOrNull() ?: 4317
        return if (host.isNotBlank()) Endpoint(host, port) else null
    }

    fun dismiss(id: String) {
        dismissed.add(id)
        _state.update { s -> s.copy(hands = s.hands.filter { it.id != id }) }
    }

    private suspend fun tick() {
        val ep = manualEndpoint() ?: beaconEndpoint ?: nsdEndpoint
        if (ep == null) {
            _state.update { it.copy(conn = Conn.SEARCHING) }
            return
        }
        // Local mode: no token required. A token is only sent when one is set
        // (for the rare case the operator enabled auth on the PC).
        val api = KmcApi("http://${ep.host}:${ep.port}/api/v1", token)
        val status = api.status()
        if (status == null) {
            _state.update { it.copy(conn = Conn.OFFLINE, host = ep.host) }
            return
        }
        val hands = api.raisedHands()
        val meeting = api.meeting()
        val settings = api.settings()
        val live = status.state == "IN_MEETING" || status.state == "SHARING"
        val handUi = (hands?.order ?: emptyList())
            .filter { it.id !in dismissed }
            .map { HandUi(it.id, it.displayName, minutesAgo(it.handRaisedAt)) }
        val activeId = meeting?.activePartId
        val parts = (meeting?.parts ?: emptyList()).map { mp ->
            PartUi(
                id = mp.id,
                section = mp.section,
                title = mp.title,
                allottedSec = mp.allottedSec,
                baseElapsedSec = mp.baseElapsedSec,
                running = mp.running,
                startedAtMs = mp.startedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
                active = mp.id == activeId,
            )
        }
        _state.value = UiState(
            conn = Conn.CONNECTED,
            participantCount = status.participantCount,
            meetingLive = live,
            hands = handUi,
            partial = hands?.partial ?: false,
            host = ep.host,
            weekLabel = meeting?.weekLabel ?: "",
            parts = parts,
            announcements = settings?.tablet?.announcements ?: "",
            manualHost = manualHost,
        )
    }

    private fun minutesAgo(iso: String?): Int {
        if (iso.isNullOrBlank()) return 0
        return runCatching {
            Duration.between(Instant.parse(iso), Instant.now()).toMinutes().toInt().coerceAtLeast(0)
        }.getOrDefault(0)
    }
}
