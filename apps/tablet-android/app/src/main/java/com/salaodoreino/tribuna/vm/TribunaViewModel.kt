package com.salaodoreino.tribuna.vm

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.salaodoreino.tribuna.net.Endpoint
import com.salaodoreino.tribuna.net.KmcApi
import com.salaodoreino.tribuna.net.discoverKmc
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

data class UiState(
    val conn: Conn = Conn.SEARCHING,
    val participantCount: Int = 0,
    val meetingLive: Boolean = false,
    val hands: List<HandUi> = emptyList(),
    val partial: Boolean = false,
    val host: String? = null,
)

/** Token storage (viewer, read-only) in SharedPreferences. */
object Prefs {
    private const val FILE = "kmc"
    private const val KEY_TOKEN = "viewer_token"
    fun token(c: Context): String =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_TOKEN, "") ?: ""
    fun setToken(c: Context, t: String) =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, t).apply()
}

/**
 * Discovers the Salão PC (NSD), then polls the read-only viewer API every 2s for
 * status + raised hands. Hand dismissals are LOCAL to the tribune (we never
 * control Zoom from here).
 */
class TribunaViewModel(app: Application) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    @Volatile private var token: String = Prefs.token(app)
    @Volatile private var endpoint: Endpoint? = null
    private val dismissed = mutableSetOf<String>()

    init {
        viewModelScope.launch {
            discoverKmc(getApplication()).collect { endpoint = it }
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

    fun dismiss(id: String) {
        dismissed.add(id)
        _state.update { s -> s.copy(hands = s.hands.filter { it.id != id }) }
    }

    private suspend fun tick() {
        if (token.isBlank()) {
            _state.update { it.copy(conn = Conn.NO_TOKEN) }
            return
        }
        val ep = endpoint
        if (ep == null) {
            _state.update { it.copy(conn = Conn.SEARCHING) }
            return
        }
        val api = KmcApi("http://${ep.host}:${ep.port}/api/v1", token)
        val status = api.status()
        if (status == null) {
            _state.update { it.copy(conn = Conn.OFFLINE, host = ep.host) }
            return
        }
        val hands = api.raisedHands()
        val live = status.state == "IN_MEETING" || status.state == "SHARING"
        val handUi = (hands?.order ?: emptyList())
            .filter { it.id !in dismissed }
            .map { HandUi(it.id, it.displayName, minutesAgo(it.handRaisedAt)) }
        _state.value = UiState(
            conn = Conn.CONNECTED,
            participantCount = status.participantCount,
            meetingLive = live,
            hands = handUi,
            partial = hands?.partial ?: false,
            host = ep.host,
        )
    }

    private fun minutesAgo(iso: String?): Int {
        if (iso.isNullOrBlank()) return 0
        return runCatching {
            Duration.between(Instant.parse(iso), Instant.now()).toMinutes().toInt().coerceAtLeast(0)
        }.getOrDefault(0)
    }
}
