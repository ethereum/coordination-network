import assert from "node:assert/strict"
import { test } from "node:test"
import { issuanceValidityWindow } from "../src/validity-window"

const DAY = 86_400

test("credentials issued in one UTC day have identical signed validity windows", () => {
    const first = issuanceValidityWindow(100 * DAY + 1, 30 * DAY)
    const last = issuanceValidityWindow(101 * DAY - 1, 30 * DAY)

    assert.deepEqual(first, last)
    assert.deepEqual(first, { validFrom: 100 * DAY, validUntil: 130 * DAY - 1 })
    assert.notDeepEqual(issuanceValidityWindow(101 * DAY, 30 * DAY), first)
})

test("rejects a shorter policy rather than silently extending it to a full day", () => {
    assert.throws(() => issuanceValidityWindow(100 * DAY + 123, 60), /at least one day/)
})
