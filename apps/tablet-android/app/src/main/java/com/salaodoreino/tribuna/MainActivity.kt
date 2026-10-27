package com.salaodoreino.tribuna

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.salaodoreino.tribuna.ui.PainelScreen
import com.salaodoreino.tribuna.vm.TribunaViewModel

/**
 * Tribune tablet — Speaker Panel. v2: responsive Compose UI driven by live
 * backend data (LAN discovery via NSD + viewer API). Kiosk (Lock Task) and LAN
 * auto-update come next.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                val vm: TribunaViewModel = viewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                PainelScreen(
                    state = state,
                    onDismiss = vm::dismiss,
                    onSetToken = vm::setToken,
                )
            }
        }
    }
}
