package org.coordination.nbench

import android.content.Context
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

private const val TAG = "NOIR"

// Pushed by the host runner; see bench_workload.json. World-readable files under /data/local/tmp
// are readable by the app uid, and unlike the app's external files dir the shell can create this
// directory before the app has ever run.
private const val DIR = "/data/local/tmp/noir-bench"
private const val CONFIG = "$DIR/bench_config.json"
private const val CIRCUIT = "$DIR/circuit.json"
private const val SRS = "$DIR/g1-131073.dat"

@RunWith(AndroidJUnit4::class)
class BenchTest {
    @Test
    fun bench() {
        val config = JSONObject(java.io.File(CONFIG).readText())
        val steps = config.getJSONArray("steps")
        val warmIters = config.getInt("warm_iters")
        val cooldownMs = config.getLong("cooldown_ms")
        val lowMemory = config.optBoolean("low_memory_mode", false)

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noir-bench:run")
        wakeLock.acquire()

        var ok = 0
        var errors = 0
        // The activity keeps the screen on and makes this the foreground process.
        ActivityScenario.launch(MainActivity::class.java).use {
            Log.i(TAG, benchDeviceLine())
            for (s in 0 until steps.length()) {
                val step = steps.getString(s)
                if (step != "credential") {
                    Log.e(TAG, benchErrorLine(step, 0u, "unknown step"))
                    errors++
                    continue
                }
                for (iter in 0..warmIters) {
                    if (iter > 0) Thread.sleep(cooldownMs)
                    try {
                        val done = benchIteration(iter.toUInt(), CIRCUIT, SRS, lowMemory)
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
