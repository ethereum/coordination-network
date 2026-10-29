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
// The credential step, and the only one a config without an `artifacts` entry can name.
private const val STEP = "prove"

// The runner pushes the config and inputs here and pulls out/ afterwards; the app needs all-files
// access to use it (see README.md). The inputs are staged into filesDir before the cold iteration.
private const val DIR = "/sdcard/zkbench/org.coordination.nbench"
private const val CONFIG = "$DIR/bench_config.json"
private const val OUT = "$DIR/out"
private const val CIRCUIT = "circuit.json"
private const val SRS = "g1-131073.dat"

// File names under DIR for one step. `witness` is empty for the credential step, which proves the
// witness compiled into the library.
private data class Artifacts(val circuit: String, val srs: String, val witness: String)

// A step with an entry in the config's `artifacts` map uses it; `prove` without one keeps today's
// constants. Any other step without an entry is unknown.
private fun artifactsFor(config: JSONObject, step: String): Artifacts? {
    val entry = config.optJSONObject("artifacts")?.optJSONObject(step)
        ?: return if (step == STEP) Artifacts(CIRCUIT, SRS, "") else null
    return Artifacts(entry.getString("circuit"), entry.getString("srs"), entry.optString("witness", ""))
}

@RunWith(AndroidJUnit4::class)
class BenchTest {
    @Test
    fun bench() {
        var ok = 0
        var errors = 0
        // False once the first call into Rust throws, e.g. UnsatisfiedLinkError when the library
        // fails to load. From then on the marker lines are built here, so DONE still prints.
        var rustUsable = true
        // What the failure handlers below name: "setup" until a step starts.
        var current = "setup"
        fun fail(step: String, iter: Int, e: Throwable) {
            errors++
            if (rustUsable) {
                Log.e(TAG, benchErrorLine(step, iter.toUInt(), e.toString()))
            } else {
                val body = JSONObject().put("step", step).put("iter", iter).put("error", e.toString().take(120))
                Log.i(TAG, "NOIR_ERROR $body")
            }
        }

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noir-bench:run")
        wakeLock.acquire()
        // Whatever fails below, the run ends with DONE so the runner can tell it from a dead process.
        try {
            try {
                Log.i(TAG, benchDeviceLine())
            } catch (e: Throwable) {
                rustUsable = false
                throw e
            }
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
                    // The SRS is first-call-wins in a process, so a second step would report a cold
                    // iteration that never read it.
                    val artifactSteps = config.optJSONObject("artifacts")
                    check(
                        steps.length() <= 1 ||
                            (0 until steps.length()).none { artifactSteps?.has(steps.getString(it)) == true }
                    ) { "a config with an artifacts entry runs one step per process" }

                    // The host pulls out/ after the run, and a proof left by an earlier run must not
                    // be mistaken for this one's.
                    val out = java.io.File(OUT)
                    check(out.isDirectory || out.mkdirs()) { "cannot create $OUT" }
                    out.listFiles { f -> f.extension == "proof" }?.forEach {
                        check(it.delete()) { "cannot delete $it" }
                    }

                    // Untimed: the cold iteration then reads app-private storage, as a production app does.
                    fun stage(name: String): String {
                        val dest = java.io.File(context.filesDir, name).path
                        benchStageFile(java.io.File(DIR, name).path, dest)
                        return dest
                    }
                    for (s in 0 until steps.length()) {
                        val step = steps.getString(s)
                        current = step
                        val proofFile = java.io.File(out, "$step.proof")
                        val circuit: String
                        val srs: String
                        val witness: String
                        try {
                            val artifacts = artifactsFor(config, step)
                            if (artifacts == null) {
                                Log.e(TAG, benchErrorLine(step, 0u, "unknown step"))
                                errors++
                                continue
                            }
                            circuit = stage(artifacts.circuit)
                            srs = stage(artifacts.srs)
                            witness = if (artifacts.witness.isEmpty()) "" else stage(artifacts.witness)
                        } catch (e: Throwable) {
                            fail(step, 0, e)
                            continue
                        }
                        for (iter in 0..warmIters) {
                            if (iter > 0) Thread.sleep(cooldownMs)
                            try {
                                val done = benchIteration(
                                    iter.toUInt(), step, circuit, srs, witness, lowMemory, proofFile.path
                                )
                                Log.i(TAG, done.iterLine)
                                done.sizesLine?.let { Log.i(TAG, it) }
                                ok++
                                // The proof was timed and stands; only its copy for the host failed.
                                done.writeErrorLine?.let {
                                    Log.e(TAG, it)
                                    errors++
                                }
                            } catch (e: Throwable) {
                                fail(step, iter, e)
                                // A failed cold iteration leaves nothing for the warm ones to reuse.
                                if (iter == 0) break
                            }
                        }
                    }
                } catch (e: Throwable) {
                    fail(current, 0, e)
                }
            }
        } catch (e: Throwable) {
            fail(current, 0, e)
        } finally {
            Log.i(TAG, if (rustUsable) benchDoneLine(ok.toUInt(), errors.toUInt()) else "NOIR_DONE {\"ok\":$ok,\"errors\":$errors}")
            wakeLock.release()
        }
        assertEquals(0, errors)
    }
}
