package com.salaodoreino.tribuna.net

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress

private const val BEACON_PORT = 41317

/**
 * DHCP-proof discovery: listen for the PC's UDP broadcast beacon and read its
 * CURRENT address from the packet source, so a changed IP reconnects on its own.
 * Works on Wi-Fi routers where mDNS multicast is filtered. A MulticastLock is
 * held so the device delivers broadcast datagrams to us.
 */
fun discoverKmcBeacon(context: Context): Flow<Endpoint> = callbackFlow {
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    val lock = wifi.createMulticastLock("kmc-beacon").apply {
        setReferenceCounted(false)
        runCatching { acquire() }
    }
    val sock = runCatching {
        DatagramSocket(null).apply {
            reuseAddress = true
            broadcast = true
            bind(InetSocketAddress(BEACON_PORT))
            soTimeout = 3000
        }
    }.getOrNull()
    if (sock == null) {
        runCatching { lock.release() }
        close()
        return@callbackFlow
    }

    val job = launch(Dispatchers.IO) {
        // Active query so we don't wait for the next 2s beacon tick on launch.
        runCatching {
            val q = "KMC?".toByteArray()
            sock.send(DatagramPacket(q, q.size, InetAddress.getByName("255.255.255.255"), BEACON_PORT))
        }
        val buf = ByteArray(2048)
        while (isActive) {
            val pkt = DatagramPacket(buf, buf.size)
            val ok = runCatching { sock.receive(pkt); true }.getOrDefault(false)
            if (!ok) continue // timeout → loop (lets cancellation run)
            val txt = String(pkt.data, 0, pkt.length)
            if (txt.contains("\"kmc\"")) {
                val api = Regex("\"api\"\\s*:\\s*(\\d+)").find(txt)?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 4317
                val host = pkt.address?.hostAddress
                if (host != null) trySend(Endpoint(host, api))
            }
        }
    }

    awaitClose {
        job.cancel()
        runCatching { sock.close() }
        runCatching { lock.release() }
    }
}
