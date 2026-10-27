package com.salaodoreino.tribuna.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/** A discovered backend endpoint on the LAN. */
data class Endpoint(val host: String, val port: Int)

private const val SERVICE_TYPE = "_kmc._tcp."

/**
 * Discovers the Salão PC on the LAN via NSD (mDNS) — no hardcoded IP. Emits an
 * [Endpoint] whenever the `_kmc._tcp` service is found and resolved.
 */
fun discoverKmc(context: Context): Flow<Endpoint> = callbackFlow {
    val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager

    fun resolve(info: NsdServiceInfo) {
        @Suppress("DEPRECATION")
        nsd.resolveService(
            info,
            object : NsdManager.ResolveListener {
                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    @Suppress("DEPRECATION")
                    val host = resolved.host?.hostAddress
                    if (host != null) trySend(Endpoint(host, resolved.port))
                }

                override fun onResolveFailed(serviceInfo: NsdServiceInfo?, errorCode: Int) {}
            },
        )
    }

    val listener = object : NsdManager.DiscoveryListener {
        override fun onServiceFound(service: NsdServiceInfo) {
            if (service.serviceType.contains("kmc", ignoreCase = true)) resolve(service)
        }

        override fun onServiceLost(service: NsdServiceInfo) {}
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            close()
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
    }

    nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    awaitClose {
        try {
            nsd.stopServiceDiscovery(listener)
        } catch (_: Exception) {
        }
    }
}
