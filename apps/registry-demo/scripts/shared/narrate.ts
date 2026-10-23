import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { toFunctionSelector, type Address, type Hex } from "viem"
import type { SafeState } from "./safe.ts"

// Styling only when a terminal will interpret it; piped output would carry the escape codes as noise.
const styled = stdout.isTTY === true

const BOLD = styled ? "\x1b[1m" : ""
const DIM = styled ? "\x1b[2m" : ""
const GREEN = styled ? "\x1b[32m" : ""
const RED = styled ? "\x1b[31m" : ""
const RESET = styled ? "\x1b[0m" : ""

/**
 * Whether the run pauses between steps, from `--step`. Only ever true on a terminal: with stdin
 * redirected the prompt hits end of input and closes, and every later pause would throw.
 */
const stepping = process.argv.includes("--step") && stdin.isTTY === true

function write(text: string) {
    stdout.write(`${text}\n`)
}

/** A numbered step, with the sentence explaining what is about to happen. */
export function step(number: string, title: string, explanation: string) {
    write("")
    write(`${BOLD}${number}. ${title}${RESET}`)
    write(`${DIM}${explanation}${RESET}`)
    write("")
}

/** A section that is not one of the numbered steps, such as the deployment. */
export function section(title: string, explanation: string) {
    write("")
    write(`${BOLD}${title}${RESET}`)
    write(`${DIM}${explanation}${RESET}`)
    write("")
}

/** One observation, indented under the step that produced it. */
export function fact(label: string, value: string) {
    write(`   ${label.padEnd(26)} ${value}`)
}

/** An observation that reads as a check the demo just made. */
export function check(passed: boolean, description: string) {
    write(`   ${passed ? `${GREEN}ok${RESET}` : `${RED}FAILED${RESET}`}  ${description}`)

    if (!passed) throw new Error(`the demo observed something it did not expect: ${description}`)
}

/**
 * Asserts that something the demo expects to fail does fail, with the error it names.
 *
 * The revert carries a custom error selector and no ABI to decode it, so the selector is computed from
 * the signature and matched against the message. Naming the error is what makes the check worth having:
 * a transaction that failed for another reason would otherwise pass it.
 */
export async function checkRejected(action: Promise<unknown>, errorSignature: string, description: string) {
    const selector = toFunctionSelector(errorSignature)

    try {
        await action
    } catch (error) {
        check((error as Error).message.includes(selector), description)
        return
    }

    check(false, description)
}

/** Shortens a long hex value to something a reader can compare at a glance. */
export function short(value: Hex | Address | bigint): string {
    const text = typeof value === "bigint" ? `0x${value.toString(16)}` : value

    return text.length <= 20 ? text : `${text.slice(0, 10)}…${text.slice(-6)}`
}

/** Prints the governance state every operation moves. */
export function printSafeState(state: SafeState) {
    fact("members", String(state.owners.length))
    fact("signatures required", `${state.threshold} of ${state.owners.length}`)
}

/** One reader for every pause: closing it closes stdin, so a fresh one per pause would hang. */
let reader: ReturnType<typeof createInterface> | undefined

/** Waits for the reader before moving on, when the run was started with `--step`. */
export async function pause() {
    if (!stepping) return

    reader ??= createInterface({ input: stdin, output: stdout })
    await reader.question(`${DIM}   press enter to continue${RESET}`)
}

/** Says so once when `--step` was asked for but cannot be honoured, rather than quietly ignoring it. */
export function warnIfSteppingIgnored() {
    if (process.argv.includes("--step") && !stepping) {
        write(`${DIM}--step needs a terminal to read from, so this run will not pause.${RESET}`)
    }
}

/** Releases stdin, so a stepped run exits instead of hanging on an open prompt. */
export function endNarration() {
    reader?.close()
    reader = undefined
}
