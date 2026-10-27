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
private const val STEP = "prove"

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
        var ok = 0
        var errors = 0
        fun fail(iter: Int, e: Throwable) {
            Log.e(TAG, benchErrorLine(STEP, iter.toUInt(), e.toString()))
            errors++
        }

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noir-bench:run")
        wakeLock.acquire()
        // Whatever fails below, the run ends with DONE so the runner can tell it from a dead process.
        try {
            Log.i(TAG, benchDeviceLine())
            // The activity keeps the screen on and makes this the foreground process.
            ActivityScenario.launch(MainActivity::class.java).use {
                try {
                    check(Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) {
                        "no all-files access: adb shell appops set ${context.packageName} MANAGE_EXTERNAL_STORAGE allow"
                    }
                    val config = JSONObject(java.io.File(CONFIG).readText())
                    val steps = config.getJSONArray("steps")
                    val warmIters = config.getInt("warm_iters")
                    val cooldownMs = config.getLong("cooldown_ms")
                    val lowMemory = config.optBoolean("low_memory_mode", false)

                    // The host pulls out/ after the run, and a proof left by an earlier run must not
                    // be mistaken for this one's.
                    val out = java.io.File(OUT)
                    check(out.isDirectory || out.mkdirs()) { "cannot create $OUT" }
                    val proofFile = java.io.File(out, "prove.proof")
                    check(!proofFile.exists() || proofFile.delete()) { "cannot delete $proofFile" }

                    // Untimed: the cold iteration then reads app-private storage, as a production app does.
                    val staged = listOf(CIRCUIT, SRS).map { name ->
                        val dest = java.io.File(context.filesDir, name).path
                        benchStageFile(java.io.File(DIR, name).path, dest)
                        dest
                    }
                    for (s in 0 until steps.length()) {
                        val step = steps.getString(s)
                        if (step != STEP) {
                            Log.e(TAG, benchErrorLine(step, 0u, "unknown step"))
                            errors++
                            continue
                        }
                        for (iter in 0..warmIters) {
                            if (iter > 0) Thread.sleep(cooldownMs)
                            try {
                                val done = benchIteration(iter.toUInt(), staged[0], staged[1], lowMemory, proofFile.path)
                                Log.i(TAG, done.iterLine)
                                done.sizesLine?.let { Log.i(TAG, it) }
                                ok++
                                // The proof was timed and stands; only its copy for the host failed.
                                done.writeErrorLine?.let {
                                    Log.e(TAG, it)
                                    errors++
                                }
                            } catch (e: Exception) {
                                fail(iter, e)
                                // A failed cold iteration leaves nothing for the warm ones to reuse.
                                if (iter == 0) break
                            }
                        }
                    }
                } catch (e: Exception) {
                    fail(0, e)
                }
            }
        } catch (e: Exception) {
            fail(0, e)
        } finally {
            Log.i(TAG, benchDoneLine(ok.toUInt(), errors.toUInt()))
            wakeLock.release()
        }
        assertEquals(0, errors)
    }
}
