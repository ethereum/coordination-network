import assert from "node:assert/strict"
import { test } from "node:test"
import { ensureIssuerKeyPublished } from "../src/admission"

test("publishes a missing candidate issuer key", async () => {
    let published = false
    let attempts = 0

    await ensureIssuerKeyPublished({
        isPublished: async () => published,
        publish: async () => {
            attempts += 1
            published = true
        }
    })

    assert.equal(attempts, 1)
    assert.equal(published, true)
})

test("does not publish a candidate issuer key twice", async () => {
    let attempts = 0

    await ensureIssuerKeyPublished({
        isPublished: async () => true,
        publish: async () => {
            attempts += 1
        }
    })

    assert.equal(attempts, 0)
})

test("recovers when publication succeeded before the publisher reported failure", async () => {
    let published = false
    let attempts = 0
    const options = {
        isPublished: async () => published,
        publish: async () => {
            attempts += 1
            published = true
            throw new Error("receipt unavailable")
        }
    }

    await assert.rejects(() => ensureIssuerKeyPublished(options), /receipt unavailable/)
    await ensureIssuerKeyPublished(options)

    assert.equal(attempts, 1)
})

test("refuses to complete admission when publication did not persist", async () => {
    await assert.rejects(
        () =>
            ensureIssuerKeyPublished({
                isPublished: async () => false,
                publish: async () => undefined
            }),
        /candidate issuer key was not published/
    )
})
