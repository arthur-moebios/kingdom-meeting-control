package com.salaodoreino.tribuna.net

import com.salaodoreino.tribuna.model.AppJson
import com.salaodoreino.tribuna.model.RaisedHands
import com.salaodoreino.tribuna.model.ZoomStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Read-only client for the backend's viewer API. Uses the viewer bearer token;
 * it never calls control endpoints (those require admin and return 403).
 */
class KmcApi(private val baseUrl: String, private val token: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    private fun getBody(path: String): String? {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            return resp.body?.string()
        }
    }

    suspend fun status(): ZoomStatus? = withContext(Dispatchers.IO) {
        runCatching { getBody("/zoom/status")?.let { AppJson.decodeFromString<ZoomStatus>(it) } }
            .getOrNull()
    }

    suspend fun raisedHands(): RaisedHands? = withContext(Dispatchers.IO) {
        runCatching { getBody("/zoom/raised-hands")?.let { AppJson.decodeFromString<RaisedHands>(it) } }
            .getOrNull()
    }
}
