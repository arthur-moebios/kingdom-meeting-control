package com.salaodoreino.tribuna.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.salaodoreino.tribuna.vm.Conn
import com.salaodoreino.tribuna.vm.HandUi
import com.salaodoreino.tribuna.vm.PartUi
import com.salaodoreino.tribuna.vm.UiState
import kotlinx.coroutines.delay
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun PainelScreen(state: UiState, onDismiss: (String) -> Unit, onSetToken: (String) -> Unit) {
    var selectedTab by remember { mutableIntStateOf(0) }
    // Single live clock drives every countdown (the server owns the real timers).
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(500)
        }
    }
    var fontScale by remember { mutableFloatStateOf(1f) }
    var showSettings by remember { mutableStateOf(false) }

    val smaller = { fontScale = (fontScale - 0.1f).coerceAtLeast(0.8f) }
    val bigger = { fontScale = (fontScale + 0.1f).coerceAtMost(1.6f) }

    if (showSettings) TokenDialog(onSetToken) { showSettings = false }

    Scaffold(
        containerColor = C.bg,
        bottomBar = { BottomNav(selectedTab) { selectedTab = it } },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().background(C.bg).padding(14.dp)) {
            Header(state) { showSettings = true }
            Spacer(Modifier.height(12.dp))
            Box(Modifier.fillMaxWidth().weight(1f)) {
                when (selectedTab) {
                    0 -> Dashboard(state, nowMs, fontScale, smaller, bigger, onDismiss)
                    1 -> AnnouncementsCard(fontScale, smaller, bigger, innerScroll = true, modifier = Modifier.fillMaxSize())
                    2 -> CronometroTab(state, nowMs)
                    3 -> ParticipantsTab(state, onDismiss)
                    else -> MaisTab(state) { showSettings = true }
                }
            }
        }
    }
}

@Composable
private fun Dashboard(
    state: UiState,
    nowMs: Long,
    fontScale: Float, smaller: () -> Unit, bigger: () -> Unit,
    onDismiss: (String) -> Unit,
) {
    val active = state.parts.firstOrNull { it.active }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth > maxHeight
        if (landscape) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ActiveTimerCard(active, state.weekLabel, nowMs)
                    PartsCard(state.parts, nowMs, innerScroll = true, modifier = Modifier.weight(1f))
                }
                Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    HandsCard(state.hands, state.partial, innerScroll = true, modifier = Modifier.weight(1f), onDismiss = onDismiss)
                    AnnouncementsCard(fontScale, smaller, bigger, innerScroll = true, modifier = Modifier.weight(1f))
                }
            }
        } else {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ActiveTimerCard(active, state.weekLabel, nowMs)
                PartsCard(state.parts, nowMs, innerScroll = false)
                HandsCard(state.hands, state.partial, innerScroll = false, onDismiss = onDismiss)
                AnnouncementsCard(fontScale, smaller, bigger, innerScroll = false)
            }
        }
    }
}

@Composable
private fun CronometroTab(state: UiState, nowMs: Long) {
    val active = state.parts.firstOrNull { it.active }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        ActiveTimerCard(active, state.weekLabel, nowMs)
        PartsCard(state.parts, nowMs, innerScroll = true, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun ParticipantsTab(state: UiState, onDismiss: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard(Modifier.fillMaxWidth()) {
            CardTitle(Icons.Filled.People, "Participantes")
            Spacer(Modifier.height(8.dp))
            Text("${state.participantCount} conectados na reunião", color = C.fg, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Lista completa de participantes em breve.", color = C.muted, fontSize = 13.sp)
        }
        HandsCard(state.hands, state.partial, innerScroll = true, modifier = Modifier.weight(1f), onDismiss = onDismiss)
    }
}

@Composable
private fun MaisTab(state: UiState, onOpenSettings: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard(Modifier.fillMaxWidth()) {
            CardTitle(Icons.Filled.Settings, "Configuração")
            Spacer(Modifier.height(10.dp))
            InfoRow("Conexão", connLabel(state))
            InfoRow("Salão (host)", state.host ?: "—")
            InfoRow("Versão", "0.1.0")
            Spacer(Modifier.height(12.dp))
            PillButton("Configurar token", Icons.Filled.Settings, C.blue, Color.White, onOpenSettings)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, color = C.muted, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(value, color = C.fg, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    }
}

private fun connLabel(state: UiState): String = when (state.conn) {
    Conn.NO_TOKEN -> "Token não configurado"
    Conn.SEARCHING -> "Procurando o Salão…"
    Conn.OFFLINE -> "Sem conexão"
    Conn.CONNECTED -> if (state.meetingLive) "Reunião ao vivo" else "Conectado (aguardando reunião)"
}

@Composable
private fun TokenDialog(onSetToken: (String) -> Unit, onClose: () -> Unit) {
    var t by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Configuração") },
        text = {
            Column {
                Text("Token de visualização (viewer) do Salão:", color = C.muted)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = t, onValueChange = { t = it }, singleLine = true)
            }
        },
        confirmButton = { TextButton(onClick = { onSetToken(t); onClose() }) { Text("Salvar") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancelar") } },
    )
}

// ---------------------------------------------------------------------------
// Header + status
// ---------------------------------------------------------------------------
@Composable
private fun Header(state: UiState, onSettings: () -> Unit) {
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = LocalDateTime.now()
            delay(10_000)
        }
    }
    val ptBR = Locale("pt", "BR")
    val time = now.format(DateTimeFormatter.ofPattern("HH:mm"))
    val date = now.format(DateTimeFormatter.ofPattern("EEEE, d 'de' MMMM", ptBR)).replaceFirstChar { it.uppercase(ptBR) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(C.blue), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.MenuBook, null, tint = Color.White)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Salão do Reino", color = C.fg, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("Painel do Orador", color = C.muted, fontSize = 13.sp)
        }
        StatusChip(state)
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(date, color = C.muted, fontSize = 11.sp)
            Text(time, color = C.fg, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(8.dp))
        IconChip(Icons.Filled.Wifi) {}
        Spacer(Modifier.width(6.dp))
        IconChip(Icons.Filled.Settings, onSettings)
    }
}

@Composable
private fun StatusChip(state: UiState) {
    val v = statusVisuals(state)
    Row(
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(v.bg).border(1.dp, v.bd, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(v.dot))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(v.title, color = v.tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(v.sub, color = C.muted, fontSize = 11.sp)
        }
    }
}

private data class StatusViz(val dot: Color, val title: String, val sub: String, val tint: Color, val bg: Color, val bd: Color)

private fun statusVisuals(state: UiState): StatusViz = when (state.conn) {
    Conn.NO_TOKEN -> StatusViz(C.amber, "Configurar token", "Toque na engrenagem", C.amber, Color(0xFF2A1E05), Color(0xFF5C451E))
    Conn.SEARCHING -> StatusViz(C.muted, "Procurando o Salão…", "Rede local", C.fg, C.card, C.border)
    Conn.OFFLINE -> StatusViz(C.red, "Sem conexão", state.host ?: "—", C.red, Color(0xFF2A0E0E), Color(0xFF5C1E1E))
    Conn.CONNECTED ->
        if (state.meetingLive)
            StatusViz(C.green, "Reunião conectada", "Zoom • ${state.participantCount} participantes", C.lime, Color(0xFF0E2A1A), Color(0xFF1E5C3A))
        else
            StatusViz(C.blue, "Conectado ao Salão", "Aguardando reunião", C.fg, C.card, C.border)
}

@Composable
private fun IconChip(icon: ImageVector, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(C.card).border(1.dp, C.border, RoundedCornerShape(10.dp)).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = C.fg, modifier = Modifier.size(20.dp)) }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
@Composable
private fun SectionCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier.clip(RoundedCornerShape(16.dp)).background(C.card).border(1.dp, C.border, RoundedCornerShape(16.dp)).padding(16.dp),
        content = content,
    )
}

@Composable
private fun CardTitle(icon: ImageVector, title: String, trailing: (@Composable () -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = C.muted, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(title.uppercase(), color = C.muted, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        trailing?.invoke()
    }
}

private const val WARN_SECONDS = 60

private fun elapsedSecOf(p: PartUi, nowMs: Long): Int {
    val started = p.startedAtMs
    val run = if (p.running && started != null)
        ((nowMs - started) / 1000.0).coerceAtLeast(0.0) else 0.0
    return (p.baseElapsedSec + run).toInt()
}

/** Text color for a remaining value (amber near the end, red when over). */
private fun remColor(remaining: Int, allotted: Int): Color = when {
    allotted <= 0 -> C.fg
    remaining < 0 -> C.red
    remaining <= WARN_SECONDS -> C.amber
    else -> C.fg
}

@Composable
private fun ActiveTimerCard(part: PartUi?, weekLabel: String, nowMs: Long) {
    SectionCard(Modifier.fillMaxWidth()) {
        CardTitle(Icons.Filled.Timer, "Parte atual")
        Spacer(Modifier.height(10.dp))
        if (part == null) {
            Text("Reunião não iniciada", color = C.fg, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            if (weekLabel.isNotBlank()) Text(weekLabel, color = C.muted, fontSize = 13.sp)
            return@SectionCard
        }
        val el = elapsedSecOf(part, nowMs)
        val rem = part.allottedSec - el
        val col = remColor(rem, part.allottedSec)
        if (part.section.isNotBlank()) Text(part.section.uppercase(), color = C.blue, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Text(part.title, color = C.fg, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            if (part.allottedSec > 0) mmssSigned(rem) else mmss(el),
            color = col, fontSize = 72.sp, fontWeight = FontWeight.Bold,
        )
        if (part.allottedSec > 0) {
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(
                progress = { (el.toFloat() / part.allottedSec).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape),
                color = if (rem < 0) C.red else if (rem <= WARN_SECONDS) C.amber else C.lime,
                trackColor = C.cardAlt,
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            if (part.running) "Decorrido ${mmss(el)} / ${mmss(part.allottedSec)}" else "pausado",
            color = C.muted, fontSize = 13.sp,
        )
    }
}

@Composable
private fun PartsCard(parts: List<PartUi>, nowMs: Long, innerScroll: Boolean, modifier: Modifier = Modifier) {
    SectionCard(modifier.fillMaxWidth()) {
        CardTitle(Icons.Filled.Timer, "Partes da reunião (${parts.size})")
        Spacer(Modifier.height(12.dp))
        val listMod = if (innerScroll) Modifier.weight(1f).verticalScroll(rememberScrollState()) else Modifier
        Column(modifier = listMod, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (parts.isEmpty()) Text("Carregando reunião do WOL…", color = C.muted, fontSize = 15.sp)
            parts.forEach { p -> PartRow(p, nowMs) }
        }
    }
}

@Composable
private fun PartRow(p: PartUi, nowMs: Long) {
    val el = elapsedSecOf(p, nowMs)
    val rem = p.allottedSec - el
    val col = remColor(rem, p.allottedSec)
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.cardAlt)
            .then(if (p.active) Modifier.border(1.dp, C.blue, RoundedCornerShape(12.dp)) else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            if (p.section.isNotBlank()) Text(p.section.uppercase(), color = C.muted, fontSize = 10.sp)
            Text(p.title, color = C.fg, fontSize = 16.sp, fontWeight = if (p.active) FontWeight.Bold else FontWeight.Normal)
        }
        Text(
            if (p.allottedSec > 0) mmssSigned(rem) else mmss(el),
            color = if (p.active) col else C.muted, fontSize = 18.sp, fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun PillButton(label: String, icon: ImageVector, bg: Color, fg: Color, onClick: () -> Unit, border: Boolean = false) {
    Row(
        modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(bg)
            .then(if (border) Modifier.border(1.dp, C.border, RoundedCornerShape(12.dp)) else Modifier)
            .clickable { onClick() }.padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, color = fg, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun HandsCard(hands: List<HandUi>, partial: Boolean, innerScroll: Boolean, modifier: Modifier = Modifier, onDismiss: (String) -> Unit) {
    SectionCard(modifier.fillMaxWidth()) {
        CardTitle(Icons.Filled.PanTool, "Mãos levantadas (${hands.size})") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SwapVert, null, tint = C.muted, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Ordem de solicitação", color = C.muted, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(12.dp))
        val listMod = if (innerScroll) Modifier.weight(1f).verticalScroll(rememberScrollState()) else Modifier
        Column(modifier = listMod, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (hands.isEmpty()) Text("Ninguém com a mão levantada.", color = C.muted, fontSize = 15.sp)
            hands.forEach { h -> HandRow(h, onDismiss) }
        }
        if (partial) {
            Spacer(Modifier.height(6.dp))
            Text("Lista parcial (reunião grande).", color = C.amber, fontSize = 12.sp)
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Groups, null, tint = C.muted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Participantes remotos que levantaram a mão para comentar ou fazer perguntas.", color = C.muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun HandRow(h: HandUi, onDismiss: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.cardAlt).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(avatarColor(h.name)), contentAlignment = Alignment.Center) {
            Text(initials(h.name), color = Color.White, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(h.name, color = C.fg, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text(if (h.minutesAgo <= 0) "Agora" else "Há ${h.minutesAgo} min", color = C.muted, fontSize = 13.sp)
        }
        Box(
            Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(C.red).clickable { onDismiss(h.id) },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Remove, "Dispensar", tint = Color.White) }
    }
}

@Composable
private fun AnnouncementsCard(fontScale: Float, onSmaller: () -> Unit, onBigger: () -> Unit, innerScroll: Boolean, modifier: Modifier = Modifier) {
    SectionCard(modifier.fillMaxWidth()) {
        CardTitle(Icons.Filled.Campaign, "Anúncios da reunião") {
            Row {
                FontButton("A-", onSmaller)
                Spacer(Modifier.width(6.dp))
                FontButton("A+", onBigger)
            }
        }
        Spacer(Modifier.height(12.dp))
        val textMod = if (innerScroll) Modifier.weight(1f).verticalScroll(rememberScrollState()) else Modifier
        Box(modifier = textMod) {
            Text(Sample.announcements, color = C.fg, fontSize = (16 * fontScale).sp, lineHeight = (24 * fontScale).sp)
        }
    }
}

@Composable
private fun FontButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(C.cardAlt).border(1.dp, C.border, RoundedCornerShape(10.dp)).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) { Text(label, color = C.fg, fontWeight = FontWeight.Bold) }
}

// ---------------------------------------------------------------------------
// Bottom navigation
// ---------------------------------------------------------------------------
private data class NavItem(val label: String, val icon: ImageVector)

@Composable
private fun BottomNav(selected: Int, onSelect: (Int) -> Unit) {
    val items = listOf(
        NavItem("Painel", Icons.Filled.Dashboard),
        NavItem("Anúncios", Icons.Filled.Campaign),
        NavItem("Cronômetro", Icons.Filled.Timer),
        NavItem("Participantes", Icons.Filled.People),
        NavItem("Mais", Icons.Filled.MoreHoriz),
    )
    Row(Modifier.fillMaxWidth().background(C.bg).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items.forEachIndexed { i, item ->
            val active = i == selected
            Column(
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(14.dp))
                    .background(if (active) C.blue else C.card)
                    .border(1.dp, if (active) C.blue else C.border, RoundedCornerShape(14.dp))
                    .clickable { onSelect(i) }.padding(vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(item.icon, null, tint = if (active) Color.White else C.muted, modifier = Modifier.size(22.dp))
                Spacer(Modifier.height(4.dp))
                Text(item.label, color = if (active) Color.White else C.muted, fontSize = 12.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal, textAlign = TextAlign.Center)
            }
        }
    }
}
