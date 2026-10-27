package org.coordination.nbench

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.TextView

/** Foreground host for the bench: lmkd treats the process as the top app, as it would be in use. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(TextView(this).apply { text = "noir bench" })
    }
}
