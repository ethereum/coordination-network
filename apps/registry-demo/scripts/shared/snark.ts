/**
 * Releases the proving worker pool.
 *
 * snarkjs starts a bn128 worker pool the first time it proves and never shuts it down, so a process
 * that has generated a proof stays alive after its work is finished. Every entry point that proves has
 * to call this, or the demo hangs on a blank line after printing its last step.
 */
export async function releaseProver() {
    await (globalThis as unknown as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate()
}
