package com.salaodoreino.tribuna.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun PainelScreen() {
    var selectedTab by remember { mutableIntStateOf(0) }

    // Local part timer (counts up toward a target; operator-controlled).
    var running by remember { mutableStateOf(true) }
    var elapsed by remember { mutableIntStateOf(332) }
    val target = 900
    LaunchedEffect(running) {
        while (running) {
            delay(1000)
            elapsed += 1
        }
    }

    val hands = remember { Sample.hands.toMutableStateList() }
    var fontScale by remember { mutableFloatStateOf(1f) }

    Scaffold(
        containerColor = C.bg,
        bottomBar = { BottomNav(selectedTab) { selectedTab = it } },
    ) { pad ->
        Column(
            modifier = Modifier
                .padding(pad)
                .fillMaxSize()
                .background(C.bg)
                .padding(14.dp),
        ) {
            Header()
            Spacer(Modifier.height(12.dp))

            androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                val landscape = maxWidth > maxHeight
                if (landscape) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            TimerCard(elapsed, target, running, { running = !running }) { elapsed = 0 }
                            HandsCard(hands, innerScroll = true, modifier = Modifier.weight(1f)) {
                                hands.remove(it)
                            }
                        }
                        AnnouncementsCard(
                            fontScale,
                            onSmaller = { fontScale = (fontScale - 0.1f).coerceAtLeast(0.8f) },
                            onBigger = { fontScale = (fontScale + 0.1f).coerceAtMost(1.6f) },
                            innerScroll = true,
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                        )
                    }
                } else {
                    Column(
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        TimerCard(elapsed, target, running, { running = !running }) { elapsed = 0 }
                        HandsCard(hands, innerScroll = false) { hands.remove(it) }
                        AnnouncementsCard(
                            fontScale,
                            onSmaller = { fontScale = (fontScale - 0.1f).coerceAtLeast(0.8f) },
                            onBigger = { fontScale = (fontScale + 0.1f).coerceAtMost(1.6f) },
                            innerScroll = false,
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
@Composable
private fun Header() {
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = LocalDateTime.now()
            delay(10_000)
        }
    }
    val ptBR = Locale("pt", "BR")
    val time = now.format(DateTimeFormatter.ofPattern("HH:mm"))
    val date = now.format(DateTimeFormatter.ofPattern("EEEE, d 'de' MMMM", ptBR))
        .replaceFirstChar { it.uppercase(ptBR) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(C.blue),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.MenuBook, null, tint = Color.White) }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Salão do Reino", color = C.fg, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("Painel do Orador", color = C.muted, fontSize = 13.sp)
        }
        StatusChip()
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(date, color = C.muted, fontSize = 11.sp)
            Text(time, color = C.fg, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(8.dp))
        IconChip(Icons.Filled.Wifi)
        Spacer(Modifier.width(6.dp))
        IconChip(Icons.Filled.Settings)
    }
}

@Composable
private fun StatusChip() {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFF0E2A1A))
            .border(1.dp, Color(0xFF1E5C3A), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(C.green))
        Spacer(Modifier.width(8.dp))
        Column {
            Text("Reunião conectada", color = C.lime, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text("Zoom • ${Sample.participants} participantes", color = C.muted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun IconChip(icon: ImageVector) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp))
            .background(C.card).border(1.dp, C.border, RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = C.fg, modifier = Modifier.size(20.dp)) }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
@Composable
private fun SectionCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(C.card)
            .border(1.dp, C.border, RoundedCornerShape(16.dp))
            .padding(16.dp),
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

@Composable
private fun TimerCard(
    elapsed: Int,
    target: Int,
    running: Boolean,
    onToggle: () -> Unit,
    onReset: () -> Unit,
) {
    SectionCard(Modifier.fillMaxWidth()) {
        CardTitle(Icons.Filled.Timer, "Tempo da parte")
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(mmss(elapsed), color = C.fg, fontSize = 64.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                PillButton(
                    if (running) "Pausar" else "Retomar",
                    if (running) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    C.green, Color(0xFF042016), onToggle,
                )
                Spacer(Modifier.height(8.dp))
                PillButton("Zerar", Icons.Filled.Refresh, C.card, C.fg, onReset, border = true)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            LinearProgressIndicator(
                progress = { (elapsed.toFloat() / target).coerceIn(0f, 1f) },
                modifier = Modifier.weight(1f).height(8.dp).clip(CircleShape),
                color = C.lime,
                trackColor = C.cardAlt,
            )
            Spacer(Modifier.width(10.dp))
            Text(mmss(target), color = C.muted, fontSize = 14.sp)
        }
    }
}

@Composable
private fun PillButton(
    label: String,
    icon: ImageVector,
    bg: Color,
    fg: Color,
    onClick: () -> Unit,
    border: Boolean = false,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .then(if (border) Modifier.border(1.dp, C.border, RoundedCornerShape(12.dp)) else Modifier)
            .clickable { onClick() }
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, color = fg, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun HandsCard(
    hands: List<Hand>,
    innerScroll: Boolean,
    modifier: Modifier = Modifier,
    onDismiss: (Hand) -> Unit,
) {
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
            if (hands.isEmpty()) {
                Text("Ninguém com a mão levantada.", color = C.muted, fontSize = 15.sp)
            }
            hands.forEach { h -> HandRow(h, onDismiss) }
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Groups, null, tint = C.muted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                "Participantes remotos que levantaram a mão para comentar ou fazer perguntas.",
                color = C.muted, fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun HandRow(h: Hand, onDismiss: (Hand) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(C.cardAlt)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(avatarColor(h.name)),
            contentAlignment = Alignment.Center,
        ) { Text(initials(h.name), color = Color.White, fontWeight = FontWeight.Bold) }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(h.name, color = C.fg, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text("Há ${h.minutesAgo} minutos", color = C.muted, fontSize = 13.sp)
        }
        Box(
            Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(C.red)
                .clickable { onDismiss(h) },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Remove, "Dispensar", tint = Color.White) }
    }
}

@Composable
private fun AnnouncementsCard(
    fontScale: Float,
    onSmaller: () -> Unit,
    onBigger: () -> Unit,
    innerScroll: Boolean,
    modifier: Modifier = Modifier,
) {
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
            Text(
                Sample.announcements,
                color = C.fg,
                fontSize = (16 * fontScale).sp,
                lineHeight = (24 * fontScale).sp,
            )
        }
    }
}

@Composable
private fun FontButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(C.cardAlt)
            .border(1.dp, C.border, RoundedCornerShape(10.dp)).clickable { onClick() },
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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(C.bg)
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items.forEachIndexed { i, item ->
            val active = i == selected
            Column(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (active) C.blue else C.card)
                    .border(1.dp, if (active) C.blue else C.border, RoundedCornerShape(14.dp))
                    .clickable { onSelect(i) }
                    .padding(vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(item.icon, null, tint = if (active) Color.White else C.muted, modifier = Modifier.size(22.dp))
                Spacer(Modifier.height(4.dp))
                Text(
                    item.label,
                    color = if (active) Color.White else C.muted,
                    fontSize = 12.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
