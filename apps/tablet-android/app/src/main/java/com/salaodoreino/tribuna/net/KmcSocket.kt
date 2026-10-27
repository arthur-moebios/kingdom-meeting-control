package com.salaodoreino.tribuna.net

import com.salaodoreino.tribuna.model.AppJson
import com.salaodoreino.tribuna.model.ServerFrame
import com.salaodoreino.tribuna.model.Snapshot
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Real-time connection to the backend's /ws, same source the PC panel uses. The
 * server pushes a full snapshot on every event, so raised/lowered hands and
 * timers update instantly (no 2s polling lag).
 */
class KmcSocket(
    private val wsUrl: String,
    private val token: String,
    private val onSnapshot: (Snapshot) -> Unit,
    private val onOpenState: (Boolean) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null

    fun connect() {
        val url = if (token.isBlank()) wsUrl else "$wsUrl?token=$token"
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onOpenState(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { AppJson.decodeFromString<ServerFrame>(text) }.getOrNull()
                if (frame?.kind == "snapshot" && frame.snapshot != null) onSnapshot(frame.snapshot)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onOpenState(false)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                onOpenState(false)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onOpenState(false)
            }
        })
    }

    fun close() {
        runCatching { ws?.cancel() }
        ws = null
    }
}
