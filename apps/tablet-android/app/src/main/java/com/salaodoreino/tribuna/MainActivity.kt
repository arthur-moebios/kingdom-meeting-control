package com.salaodoreino.tribuna

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import com.salaodoreino.tribuna.ui.PainelScreen

/**
 * Tribune tablet — Speaker Panel. Phase 1: responsive Compose UI (landscape +
 * portrait) with sample data. Next: LAN discovery (NsdManager) + live backend
 * data, then kiosk (Lock Task) and LAN auto-update.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the tribune screen awake.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                PainelScreen()
            }
        }
    }
}
