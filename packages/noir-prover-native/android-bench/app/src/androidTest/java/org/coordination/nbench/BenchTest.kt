package org.coordination.nbench

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import uniffi.mopro.benchDeviceLine
import uniffi.mopro.benchDoneLine
import uniffi.mopro.benchErrorLine
import uniffi.mopro.benchIteration
import uniffi.mopro.benchStageFile

private const val TAG = "NOIR"

// The runner pushes the config and inputs here and pulls out/ afterwards; the app needs all-files
// access to use it (see README.md). The inputs are staged into filesDir before the cold iteration.
private const val DIR = "/sdcard/zkbench/org.coordination.nbench"
private const val CONFIG = "$DIR/bench_config.json"
private const val OUT = "$DIR/out"
private const val CIRCUIT = "circuit.json"
private const val SRS = "g1-131073.dat"

@RunWith(AndroidJUnit4::class)
class BenchTest {
    @Test
    fun bench() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) {
            "no all-files access: adb shell appops set ${context.packageName} MANAGE_EXTERNAL_STORAGE allow"
        }
        // The host pulls out/ after the run and verifies the proof on a desktop.
        val out = java.io.File(OUT).also { it.mkdirs() }
        val config = JSONObject(java.io.File(CONFIG).readText())
        val steps = config.getJSONArray("steps")
        val warmIters = config.getInt("warm_iters")
        val cooldownMs = config.getLong("cooldown_ms")
        val lowMemory = config.optBoolean("low_memory_mode", false)

        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noir-bench:run")
        wakeLock.acquire()

        var ok = 0
        var errors = 0
        // The activity keeps the screen on and makes this the foreground process.
        ActivityScenario.launch(MainActivity::class.java).use {
            Log.i(TAG, benchDeviceLine())
            // Untimed: the cold iteration then reads app-private storage, as a production app does.
            val staged = listOf(CIRCUIT, SRS).map { name ->
                val dest = java.io.File(context.filesDir, name).path
                benchStageFile(java.io.File(DIR, name).path, dest)
                dest
            }
            for (s in 0 until steps.length()) {
                val step = steps.getString(s)
                if (step != "prove") {
                    Log.e(TAG, benchErrorLine(step, 0u, "unknown step"))
                    errors++
                    continue
                }
                for (iter in 0..warmIters) {
                    if (iter > 0) Thread.sleep(cooldownMs)
                    try {
                        val done = benchIteration(
                            iter.toUInt(),
                            staged[0],
                            staged[1],
                            lowMemory,
                            java.io.File(out, "prove.proof").path,
                        )
                        Log.i(TAG, done.iterLine)
                        done.sizesLine?.let { Log.i(TAG, it) }
                        ok++
                    } catch (e: Exception) {
                        Log.e(TAG, benchErrorLine(step, iter.toUInt(), e.toString()))
                        errors++
                        // A failed cold iteration leaves nothing for the warm ones to reuse.
                        if (iter == 0) break
                    }
                }
            }
            Log.i(TAG, benchDoneLine(ok.toUInt(), errors.toUInt()))
        }
        wakeLock.release()
        assertEquals(0, errors)
    }
}
