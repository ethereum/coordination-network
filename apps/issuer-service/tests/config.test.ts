import assert from "node:assert/strict"
import { test } from "node:test"
import { deriveKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import { privateKeyToAccount } from "viem/accounts"
import { loadConfig } from "../src/config"

const IDENTITY_REGISTRY_ADDRESS = `0x${"11".repeat(20)}`
const CHAIN_ID = "31337"
const MEMBER_IDENTITY_SECRET = "22".repeat(32)
const SUBMITTER_PRIVATE_KEY = "33".repeat(32)
const ANNOUNCER_ADDRESS = `0x${"44".repeat(20)}`
const MEMBER_PRIVATE_KEY = "55".repeat(32)
const REVOCATION_ADDRESS = `0x${"66".repeat(20)}`
const RPC_URL = "http://127.0.0.1:9999"
const GOVERNANCE_AUTH_PRIVATE_KEY = "77".repeat(32)
const GOVERNANCE_SIGNER_PRIVATE_KEY = "88".repeat(32)
const GOVERNANCE_ISSUER_NETWORK_ID = memberAccountKey(
    privateKeyToAccount(`0x${GOVERNANCE_AUTH_PRIVATE_KEY}`).publicKey
).memberNetworkId
const GOVERNANCE_SEMAPHORE_COMMITMENT = "9"
const NETWORK_MEMBER_REGISTRY_ADDRESS = `0x${"aa".repeat(20)}`
const NETWORK_MEMBER_GROUP_ADDRESS = `0x${"bb".repeat(20)}`
const NETWORK_MEMBER_GOVERNANCE_ADDRESS = `0x${"cc".repeat(20)}`
const GOVERNANCE_SAFE_ADDRESS = `0x${"dd".repeat(20)}`
const APPROVED_ISSUER_SET_ADDRESS = `0x${"ee".repeat(20)}`
const ENTRY_POINT_ADDRESS = `0x${"12".repeat(20)}`
const PAYMASTER_ADDRESS = `0x${"34".repeat(20)}`
const ACCOUNT_IMPLEMENTATION_ADDRESS = `0x${"56".repeat(20)}`
const BUNDLER_URL = "http://127.0.0.1:4337/key-abc123"
const MEMBER_SERVER_TOKEN = "a-member-server-token-long-enough"
const ISSUER_PRIVATE_KEY = "99".repeat(32)
const GOVERNANCE_META_STEALTH_ADDRESS = `0x${"ff".repeat(66)}`
const IN_MEMORY_REVOCATION = { ALLOW_IN_MEMORY_REVOCATION: "true", MEMBER_SERVER_TOKEN }
const DIRECT_DELIVERY = { ALLOW_DIRECT_DELIVERY: "true" }
const DIRECT_REVOCATION = { ALLOW_DIRECT_REVOCATION: "true" }
const SPONSORED_ENV = { ENTRY_POINT_ADDRESS, PAYMASTER_ADDRESS, ACCOUNT_IMPLEMENTATION_ADDRESS, BUNDLER_URL }
const ISSUANCE_ENV = {
    ISSUER_PRIVATE_KEY,
    RPC_URL,
    IDENTITY_REGISTRY_ADDRESS,
    CHAIN_ID,
    ISSUANCE_PROGRAMME: "standard-access",
    ISSUANCE_COUNTRY: "ZZZ",
    ...IN_MEMORY_REVOCATION
}
const DIRECT_REGISTRATION = { ALLOW_DIRECT_REGISTRATION: "true" }
const DELIVERY_ENV = {
    RPC_URL,
    ANNOUNCER_ADDRESS,
    MEMBER_PRIVATE_KEY,
    IDENTITY_REGISTRY_ADDRESS,
    CHAIN_ID,
    ...DIRECT_DELIVERY,
    ...IN_MEMORY_REVOCATION
}

function thrownMessage(fn: () => unknown): string {
    try {
        fn()
    } catch (error) {
        return String((error as Error).message ?? error)
    }
    throw new Error("expected loadConfig to throw")
}

test("registration group: a partial set is rejected naming every key in the group", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, IDENTITY_REGISTRY_ADDRESS, CHAIN_ID }))

    assert.match(message, /must all be set together/)
    for (const key of ["IDENTITY_REGISTRY_ADDRESS", "CHAIN_ID", "MEMBER_IDENTITY_SECRET", "SUBMITTER_PRIVATE_KEY"]) {
        assert.match(message, new RegExp(key))
    }
})

test("issuance gate parses independently of the registration writer", () => {
    const config = loadConfig(ISSUANCE_ENV)

    assert.deepEqual(config.issuance, {
        identityRegistryAddress: IDENTITY_REGISTRY_ADDRESS,
        chainId: 31337,
        approvalScope: { programme: "standard-access", country: "ZZZ" }
    })
    assert.equal(config.registration, undefined)
    assert.deepEqual(
        config.issuerPrivateKey,
        Uint8Array.from({ length: 32 }, () => 0x99)
    )
})

test("complete revocation group beside the issuance gate parses with no registration", () => {
    const env = {
        ...ISSUANCE_ENV,
        REVOCATION_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        MEMBER_PRIVATE_KEY,
        ...DIRECT_REVOCATION
    }

    const config = loadConfig(env)

    assert.equal(config.registration, undefined)
    assert.ok(config.revocation)
})

test("issuance gate plus MEMBER_IDENTITY_SECRET and no sender is rejected naming both senders", () => {
    const message = thrownMessage(() => loadConfig({ ...ISSUANCE_ENV, MEMBER_IDENTITY_SECRET }))

    assert.match(message, /need a sender/)
    assert.match(message, /ENTRY_POINT_ADDRESS/)
    assert.match(message, /SUBMITTER_PRIVATE_KEY/)
})

test("issuance refuses to start without a persistent issuer signing key", () => {
    const withoutKey = { ...ISSUANCE_ENV, ISSUER_PRIVATE_KEY: undefined }
    assert.match(
        thrownMessage(() => loadConfig(withoutKey)),
        /ISSUER_PRIVATE_KEY is required for credential issuance/
    )
    assert.match(
        thrownMessage(() => loadConfig({ ...ISSUANCE_ENV, ISSUER_PRIVATE_KEY: "short" })),
        /ISSUER_PRIVATE_KEY/
    )
})

test("issuance policy is all-or-none and requires RPC_URL", () => {
    assert.match(
        thrownMessage(() =>
            loadConfig({
                IDENTITY_REGISTRY_ADDRESS,
                CHAIN_ID,
                ISSUANCE_PROGRAMME: "standard-access",
                ...IN_MEMORY_REVOCATION
            })
        ),
        /ISSUANCE_COUNTRY.*must all be set together/
    )
    assert.match(
        thrownMessage(() =>
            loadConfig({
                IDENTITY_REGISTRY_ADDRESS,
                CHAIN_ID,
                ISSUANCE_PROGRAMME: "standard-access",
                ISSUANCE_COUNTRY: "ZZZ",
                ...IN_MEMORY_REVOCATION
            })
        ),
        /require RPC_URL/
    )
})

test("registration group: the core keys with no sender are rejected naming both senders", () => {
    const message = thrownMessage(() =>
        loadConfig({
            RPC_URL,
            IDENTITY_REGISTRY_ADDRESS,
            CHAIN_ID,
            MEMBER_IDENTITY_SECRET,
            ...IN_MEMORY_REVOCATION
        })
    )

    assert.match(message, /need a sender/)
    assert.doesNotMatch(message, /must all be set together/)
    assert.match(message, /ENTRY_POINT_ADDRESS/)
    assert.match(message, /SUBMITTER_PRIVATE_KEY/)
})

test("registration group: a partial direct group keeps the all-set-together message", () => {
    const message = thrownMessage(() =>
        loadConfig({ RPC_URL, IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, SUBMITTER_PRIVATE_KEY, ...DIRECT_REGISTRATION })
    )

    assert.match(message, /must all be set together/)
    assert.doesNotMatch(message, /need a sender/)
})

test("delivery group: setting only its own trigger key is rejected naming every key in the group", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, ANNOUNCER_ADDRESS }))

    assert.match(message, /must all be set together/)
    for (const key of ["ANNOUNCER_ADDRESS", "IDENTITY_REGISTRY_ADDRESS", "CHAIN_ID"]) {
        assert.match(message, new RegExp(key))
    }
})

test("revocation group: setting only its trigger key is rejected naming every key in the group", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, REVOCATION_ADDRESS }))

    assert.match(message, /must all be set together/)
    for (const key of ["REVOCATION_ADDRESS", "MEMBER_IDENTITY_SECRET"]) {
        assert.match(message, new RegExp(key))
    }
})

test("a complete group without RPC_URL is rejected as requiring it", () => {
    const message = thrownMessage(() =>
        loadConfig({ REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET, MEMBER_PRIVATE_KEY, ...DIRECT_REVOCATION })
    )

    assert.match(message, /require RPC_URL/)
})

test("revocation group: no group and no flag is rejected, naming both", () => {
    const message = thrownMessage(() => loadConfig({}))

    assert.match(message, /required unless ALLOW_IN_MEMORY_REVOCATION=true/)
    assert.match(message, /REVOCATION_ADDRESS/)
    assert.match(message, /ALLOW_IN_MEMORY_REVOCATION/)
})

test("revocation group: ALLOW_IN_MEMORY_REVOCATION=false still requires the group", () => {
    assert.throws(
        () => loadConfig({ ALLOW_IN_MEMORY_REVOCATION: "false" }),
        /required unless ALLOW_IN_MEMORY_REVOCATION=true/
    )
})

test("revocation group: in-memory opt-in with the required member token leaves revocation unset", () => {
    const config = loadConfig(IN_MEMORY_REVOCATION)

    assert.equal(config.revocation, undefined)
})

test("registration group: fully set with RPC_URL parses, leaving delivery and revocation unset", () => {
    const config = loadConfig({
        RPC_URL,
        IDENTITY_REGISTRY_ADDRESS,
        CHAIN_ID,
        MEMBER_IDENTITY_SECRET,
        SUBMITTER_PRIVATE_KEY,
        ...DIRECT_REGISTRATION,
        ...IN_MEMORY_REVOCATION
    })

    assert.ok(config.registration)
    assert.equal(config.registration.identityRegistryAddress, IDENTITY_REGISTRY_ADDRESS)
    assert.equal(config.registration.chainId, 31337)
    assert.equal(config.delivery, undefined)
    assert.equal(config.revocation, undefined)
})

test("revocation group: fully set with RPC_URL parses without requiring the keys it shares with delivery and registration", () => {
    const config = loadConfig({
        MEMBER_SERVER_TOKEN,
        RPC_URL,
        REVOCATION_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        MEMBER_PRIVATE_KEY,
        ...DIRECT_REVOCATION
    })

    assert.ok(config.revocation)
    assert.equal(config.revocation.address, REVOCATION_ADDRESS)
    assert.equal(config.revocation.memberPrivateKey, `0x${MEMBER_PRIVATE_KEY}`)
    assert.equal(config.delivery, undefined)
    assert.equal(config.registration, undefined)
})

test("revocation and registration both parse when they share MEMBER_IDENTITY_SECRET", () => {
    const config = loadConfig({
        MEMBER_SERVER_TOKEN,
        RPC_URL,
        REVOCATION_ADDRESS,
        MEMBER_PRIVATE_KEY,
        IDENTITY_REGISTRY_ADDRESS,
        CHAIN_ID,
        MEMBER_IDENTITY_SECRET,
        SUBMITTER_PRIVATE_KEY,
        ...DIRECT_REVOCATION,
        ...DIRECT_REGISTRATION
    })

    assert.ok(config.revocation)
    assert.ok(config.registration)
    // One seed, one Semaphore identity: both groups' proofs come from the same admitted member.
    assert.deepEqual(config.revocation.memberIdentitySecret, config.registration.memberIdentitySecret)
})

// Bug: DELIVERY_ENV_KEYS shares IDENTITY_REGISTRY_ADDRESS/CHAIN_ID with REGISTRATION_ENV_KEYS.
// REGISTRATION_ENV_KEYS's own "any key set requires the whole group" check has no trigger-key
// exemption (unlike delivery/revocation's), so a complete, valid delivery-only config is rejected
// as a partial registration group. This contradicts config.ts's own comment above
// DELIVERY_TRIGGER_KEYS/REVOCATION_TRIGGER_KEYS, which says the unconditional check is "fine for
// REGISTRATION_ENV_KEYS, which owns its keys outright" - it does not: delivery shares two of them.
test("delivery group: fully set with RPC_URL parses without registration also being set", () => {
    const config = loadConfig({ ...DELIVERY_ENV, MEMBER_SERVER_TOKEN })

    assert.ok(config.delivery)
    assert.equal(config.delivery.announcerAddress, ANNOUNCER_ADDRESS)
    assert.equal(config.registration, undefined)
})

test("delivery and revocation groups that share every registration key between them load with no registration", () => {
    const config = loadConfig({
        ...DELIVERY_ENV,
        MEMBER_SERVER_TOKEN,
        REVOCATION_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        ...DIRECT_REVOCATION
    })

    assert.ok(config.delivery)
    assert.ok(config.revocation)
    assert.equal(config.registration, undefined)
})

const SPONSORED_DELIVERY_ENV = {
    RPC_URL,
    ANNOUNCER_ADDRESS,
    IDENTITY_REGISTRY_ADDRESS,
    CHAIN_ID,
    MEMBER_IDENTITY_SECRET,
    ...SPONSORED_ENV,
    ...IN_MEMORY_REVOCATION
}
const SPONSORED_REVOCATION_ENV = {
    RPC_URL,
    MEMBER_SERVER_TOKEN,
    MEMBER_IDENTITY_SECRET,
    REVOCATION_ADDRESS,
    ...SPONSORED_ENV
}

function thrownText(fn: () => unknown): string {
    try {
        fn()
    } catch (error) {
        const { message, issues } = error as { message: string; issues?: unknown }
        return `${message}\n${JSON.stringify(issues)}\n${String(error)}`
    }
    throw new Error("expected loadConfig to throw")
}

test("sponsored group: a lone ENTRY_POINT_ADDRESS is rejected naming all four keys", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, ENTRY_POINT_ADDRESS }))

    assert.match(message, /must all be set together/)
    for (const key of Object.keys(SPONSORED_ENV)) {
        assert.match(message, new RegExp(key))
    }
})

test("sponsored group: complete without RPC_URL is rejected as requiring it, and never echoes BUNDLER_URL", () => {
    const message = thrownMessage(() => loadConfig(SPONSORED_ENV))

    assert.match(message, /require RPC_URL/)
    assert.doesNotMatch(message, /key-abc123/)
})

test("sponsored group: a malformed BUNDLER_URL is rejected without echoing it", () => {
    for (const bundlerUrl of ["bundler.example/rpc?apikey=SECRET123", "not a url SECRET123"]) {
        const text = thrownText(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, BUNDLER_URL: bundlerUrl }))

        assert.match(text, /BUNDLER_URL/)
        assert.doesNotMatch(text, /SECRET123/)
    }
})

test("sponsored group: an incomplete group around a valid BUNDLER_URL never echoes it", () => {
    const text = thrownText(() =>
        loadConfig({
            ...SPONSORED_DELIVERY_ENV,
            PAYMASTER_ADDRESS: undefined,
            BUNDLER_URL: "https://bundler.example/rpc?apikey=SECRET123"
        })
    )

    assert.match(text, /PAYMASTER_ADDRESS/)
    assert.doesNotMatch(text, /SECRET123/)
})

test("sponsored group: a malformed address is rejected", () => {
    for (const key of ["ENTRY_POINT_ADDRESS", "PAYMASTER_ADDRESS", "ACCOUNT_IMPLEMENTATION_ADDRESS"]) {
        assert.throws(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, [key]: "0x1234" }), new RegExp(key))
    }
})

test("sponsored group: PAYMASTER_GROUP_FROM_BLOCK is taken from the environment", () => {
    const config = loadConfig({ ...SPONSORED_DELIVERY_ENV, PAYMASTER_GROUP_FROM_BLOCK: "42" })

    assert.equal(config.delivery?.sponsored?.paymasterGroupFromBlock, 42)
    assert.throws(
        () => loadConfig({ ...SPONSORED_DELIVERY_ENV, PAYMASTER_GROUP_FROM_BLOCK: "-1" }),
        /PAYMASTER_GROUP_FROM_BLOCK/
    )
})

test("sponsored group: with no complete route is rejected, naming what each route needs", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, ...SPONSORED_ENV, ...IN_MEMORY_REVOCATION }))

    assert.match(
        message,
        /ENTRY_POINT_ADDRESS, PAYMASTER_ADDRESS, ACCOUNT_IMPLEMENTATION_ADDRESS, BUNDLER_URL relay registrations, deliveries and revocations and need MEMBER_IDENTITY_SECRET and one route's keys: registration IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, MEMBER_IDENTITY_SECRET; delivery ANNOUNCER_ADDRESS, IDENTITY_REGISTRY_ADDRESS, CHAIN_ID; revocation REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET/
    )
    assert.doesNotMatch(message, /key-abc123/)
})

const SPONSORED_SECRET_ONLY_ENV = { RPC_URL, ...SPONSORED_ENV, MEMBER_IDENTITY_SECRET, ...IN_MEMORY_REVOCATION }
const NO_ROUTE_MESSAGE = /need MEMBER_IDENTITY_SECRET and one route's keys/

test("sponsored group: the member secret alone, with no route, is rejected", () => {
    const message = thrownMessage(() => loadConfig(SPONSORED_SECRET_ONLY_ENV))

    assert.match(message, NO_ROUTE_MESSAGE)
    assert.doesNotMatch(message, /key-abc123/)
})

test("sponsored group: the member secret and issuance keys form a complete registration route", () => {
    const config = loadConfig({ ...ISSUANCE_ENV, ...SPONSORED_SECRET_ONLY_ENV })

    assert.ok(config.registration?.sponsored)
    assert.equal(config.delivery, undefined)
    assert.equal(config.revocation, undefined)
})

test("sponsored group: a complete delivery route without MEMBER_IDENTITY_SECRET is rejected", () => {
    const message = thrownMessage(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, MEMBER_IDENTITY_SECRET: undefined }))

    assert.match(message, /MEMBER_IDENTITY_SECRET/)
    assert.doesNotMatch(message, /key-abc123/)
})

test("sponsored delivery with the registry keys also builds sponsored registration, and no member key", () => {
    const config = loadConfig(SPONSORED_DELIVERY_ENV)

    assert.ok(config.registration?.sponsored)
    assert.equal(config.registration.submitterPrivateKey, undefined)
    assert.deepEqual(config.registration.sponsored, config.delivery?.sponsored)
    assert.equal(config.revocation, undefined)
    assert.ok(config.delivery?.sponsored)
    assert.equal(config.delivery.memberPrivateKey, undefined)
    assert.equal(config.delivery.announcerAddress, ANNOUNCER_ADDRESS)
    assert.deepEqual(config.delivery.sponsored, {
        memberSecret: `0x${MEMBER_IDENTITY_SECRET}`,
        entryPoint: ENTRY_POINT_ADDRESS,
        paymaster: PAYMASTER_ADDRESS,
        accountImplementation: ACCOUNT_IMPLEMENTATION_ADDRESS,
        bundlerUrl: BUNDLER_URL,
        paymasterGroupFromBlock: 0,
        logWindowBlocks: undefined
    })
    assert.deepEqual(config.delivery.memberIdentitySecret, Uint8Array.from(Buffer.from(MEMBER_IDENTITY_SECRET, "hex")))
})

test("sponsored revocation alone parses with no registration and no delivery", () => {
    const config = loadConfig(SPONSORED_REVOCATION_ENV)

    assert.equal(config.registration, undefined)
    assert.equal(config.delivery, undefined)
    assert.ok(config.revocation?.sponsored)
    assert.equal(config.revocation.memberPrivateKey, undefined)
})

test("sponsored delivery and revocation share one sponsored config", () => {
    const config = loadConfig({ ...SPONSORED_DELIVERY_ENV, REVOCATION_ADDRESS })

    assert.ok(config.delivery?.sponsored)
    assert.deepEqual(config.revocation?.sponsored, config.delivery.sponsored)
    assert.equal(config.revocation.memberPrivateKey, undefined)
})

test("sponsored group: SUBMITTER_PRIVATE_KEY beside it is rejected as two senders for registration, flag or not", () => {
    for (const flag of [{}, DIRECT_REGISTRATION]) {
        assert.match(
            thrownMessage(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, SUBMITTER_PRIVATE_KEY, ...flag })),
            /SUBMITTER_PRIVATE_KEY and the sponsored group are two senders for one route; unset one/
        )
    }
})

test("sponsored group: a missing key is rejected whichever one it is, next to a complete registration group", () => {
    assert.ok(loadConfig(SPONSORED_DELIVERY_ENV).registration)

    for (const key of Object.keys(SPONSORED_ENV)) {
        const message = thrownMessage(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, [key]: undefined }))

        assert.match(
            message,
            /ENTRY_POINT_ADDRESS, PAYMASTER_ADDRESS, ACCOUNT_IMPLEMENTATION_ADDRESS, BUNDLER_URL must all be set together/
        )
        assert.doesNotMatch(message, /key-abc123/)
    }
})

test("sponsored group: SUBMITTER_PRIVATE_KEY without IDENTITY_REGISTRY_ADDRESS is still refused, naming the registration group", () => {
    const message = thrownMessage(() => loadConfig({ ...SPONSORED_REVOCATION_ENV, CHAIN_ID, SUBMITTER_PRIVATE_KEY }))

    assert.match(message, /IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, MEMBER_IDENTITY_SECRET must all be set together/)
    assert.doesNotMatch(message.split("must all be set together")[0], /SUBMITTER_PRIVATE_KEY/)
})

test("sponsored group: registration keys without RPC_URL are refused, naming the core keys only", () => {
    const message = thrownMessage(() => loadConfig({ ...SPONSORED_REVOCATION_ENV, RPC_URL: undefined, CHAIN_ID }))

    assert.match(message, /IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, MEMBER_IDENTITY_SECRET require RPC_URL/)
    assert.doesNotMatch(message, /SUBMITTER_PRIVATE_KEY/)
})

test("sponsored group: SUBMITTER_PRIVATE_KEY beside a sponsored revocation alone is refused, the secret being explained but the registry not", () => {
    const message = thrownMessage(() => loadConfig({ ...SPONSORED_REVOCATION_ENV, SUBMITTER_PRIVATE_KEY }))

    assert.match(message, /IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, MEMBER_IDENTITY_SECRET must all be set together/)
    assert.doesNotMatch(message.split("must all be set together")[0], /SUBMITTER_PRIVATE_KEY/)
})

test("sponsored delivery beside the issuance keys loads both, and registration is sponsored too", () => {
    const config = loadConfig({
        ...ISSUANCE_ENV,
        ANNOUNCER_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        ...SPONSORED_ENV
    })

    assert.deepEqual(config.issuance?.approvalScope, { programme: "standard-access", country: "ZZZ" })
    assert.ok(config.delivery?.sponsored)
    assert.ok(config.registration?.sponsored)
    assert.equal(config.revocation, undefined)
})

test("sponsored delivery beside the issuance keys still requires ISSUER_PRIVATE_KEY and a complete scope", () => {
    const sponsoredIssuance = { ...ISSUANCE_ENV, ANNOUNCER_ADDRESS, MEMBER_IDENTITY_SECRET, ...SPONSORED_ENV }

    assert.throws(
        () => loadConfig({ ...sponsoredIssuance, ISSUER_PRIVATE_KEY: undefined }),
        /ISSUER_PRIVATE_KEY is required for credential issuance/
    )
    assert.throws(
        () => loadConfig({ ...sponsoredIssuance, ISSUANCE_COUNTRY: undefined }),
        /ISSUANCE_PROGRAMME, ISSUANCE_COUNTRY must all be set together/
    )
})

test("sponsored delivery and sponsored revocation still require MEMBER_SERVER_TOKEN", () => {
    for (const env of [SPONSORED_DELIVERY_ENV, { ...SPONSORED_REVOCATION_ENV, ...SPONSORED_DELIVERY_ENV }]) {
        assert.match(
            thrownMessage(() => loadConfig({ ...env, MEMBER_SERVER_TOKEN: undefined })),
            /MEMBER_SERVER_TOKEN is required/
        )
    }
})

test("sponsored delivery with no revocation group and no in-memory flag is refused", () => {
    assert.throws(
        () => loadConfig({ ...SPONSORED_DELIVERY_ENV, ALLOW_IN_MEMORY_REVOCATION: undefined }),
        /are required unless ALLOW_IN_MEMORY_REVOCATION=true/
    )
})

test("delivery core with a registration group and no sender is refused, starting neither delivery nor registration", () => {
    const message = thrownMessage(() =>
        loadConfig({
            RPC_URL,
            ANNOUNCER_ADDRESS,
            IDENTITY_REGISTRY_ADDRESS,
            CHAIN_ID,
            MEMBER_IDENTITY_SECRET,
            SUBMITTER_PRIVATE_KEY,
            ...IN_MEMORY_REVOCATION
        })
    )

    assert.match(message, /ANNOUNCER_ADDRESS, IDENTITY_REGISTRY_ADDRESS, CHAIN_ID need a sender/)
    assert.doesNotMatch(message, /must all be set together/)
})

test("delivery core and the member secret with no sender and no submitter is refused", () => {
    assert.throws(
        () =>
            loadConfig({
                RPC_URL,
                ANNOUNCER_ADDRESS,
                IDENTITY_REGISTRY_ADDRESS,
                CHAIN_ID,
                MEMBER_IDENTITY_SECRET,
                ...IN_MEMORY_REVOCATION
            }),
        /need a sender/
    )
})

test("sponsored group: an upper- and lower-case MEMBER_IDENTITY_SECRET derive the same member keys", () => {
    const lower = "ab".repeat(16) + "cd".repeat(16)
    const derive = (secret: string) => {
        const config = loadConfig({ ...SPONSORED_DELIVERY_ENV, MEMBER_IDENTITY_SECRET: secret })
        const memberSecret = config.delivery?.sponsored?.memberSecret
        assert.ok(memberSecret)
        const keys = deriveKeys(memberSecret)

        return {
            keys,
            meta: encodeMetaStealthAddress({
                spendingPublicKey: keys.spending.publicKey,
                viewingPublicKey: keys.viewing.publicKey
            })
        }
    }

    const fromLower = derive(lower)
    const fromUpper = derive(lower.toUpperCase())

    assert.deepEqual(fromUpper.keys, fromLower.keys)
    assert.equal(fromUpper.meta, fromLower.meta)
})

test("delivery group: MEMBER_PRIVATE_KEY and the sponsored group are rejected as two senders, flag or not", () => {
    for (const flag of [{}, DIRECT_DELIVERY]) {
        assert.match(
            thrownMessage(() => loadConfig({ ...SPONSORED_DELIVERY_ENV, MEMBER_PRIVATE_KEY, ...flag })),
            /MEMBER_PRIVATE_KEY and the sponsored group are two senders for delivery and revocation; unset one/
        )
    }
})

test("revocation group: MEMBER_PRIVATE_KEY and the sponsored group are rejected as two senders, flag or not", () => {
    for (const flag of [{}, DIRECT_REVOCATION]) {
        assert.match(
            thrownMessage(() => loadConfig({ ...SPONSORED_REVOCATION_ENV, MEMBER_PRIVATE_KEY, ...flag })),
            /two senders for delivery and revocation; unset one/
        )
    }
})

test("sponsored group: MEMBER_PRIVATE_KEY beside it with no route is rejected", () => {
    assert.throws(
        () => loadConfig({ RPC_URL, ...SPONSORED_ENV, MEMBER_PRIVATE_KEY, ...IN_MEMORY_REVOCATION }),
        /relay registrations, deliveries and revocations and need MEMBER_IDENTITY_SECRET/
    )
})

test("delivery group: MEMBER_PRIVATE_KEY without ALLOW_DIRECT_DELIVERY is rejected, naming the sponsored alternative", () => {
    const env = { ...DELIVERY_ENV, ALLOW_DIRECT_DELIVERY: undefined }

    for (const flag of [{}, { ALLOW_DIRECT_DELIVERY: "false" }]) {
        const message = thrownMessage(() => loadConfig({ ...env, ...flag }))

        assert.match(message, /ALLOW_DIRECT_DELIVERY=true/)
        assert.match(message, /ENTRY_POINT_ADDRESS/)
    }
})

test("delivery group: the flag with MEMBER_PRIVATE_KEY starts and is direct", () => {
    const config = loadConfig(DELIVERY_ENV)

    assert.equal(config.delivery?.memberPrivateKey, `0x${MEMBER_PRIVATE_KEY}`)
    assert.equal(config.delivery.sponsored, undefined)
    assert.equal(config.delivery.memberIdentitySecret, undefined)
})

test("revocation group: MEMBER_PRIVATE_KEY without ALLOW_DIRECT_REVOCATION is rejected, naming the sponsored alternative", () => {
    const env = { RPC_URL, MEMBER_SERVER_TOKEN, REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET, MEMBER_PRIVATE_KEY }

    for (const flag of [{}, { ALLOW_DIRECT_REVOCATION: "false" }]) {
        const message = thrownMessage(() => loadConfig({ ...env, ...flag }))

        assert.match(message, /ALLOW_DIRECT_REVOCATION=true/)
        assert.match(message, /ENTRY_POINT_ADDRESS/)
    }
    assert.equal(loadConfig({ ...env, ...DIRECT_REVOCATION }).revocation?.memberPrivateKey, `0x${MEMBER_PRIVATE_KEY}`)
})

test("delivery and revocation flags are independent", () => {
    const env = { ...DELIVERY_ENV, REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET }

    assert.match(
        thrownMessage(() => loadConfig(env)),
        /ALLOW_DIRECT_REVOCATION=true/
    )
    const withoutDeliveryFlag = thrownMessage(() =>
        loadConfig({ ...env, ALLOW_DIRECT_DELIVERY: undefined, ...DIRECT_REVOCATION })
    )
    assert.match(withoutDeliveryFlag, /ALLOW_DIRECT_DELIVERY=true/)
    assert.doesNotMatch(withoutDeliveryFlag, /ALLOW_DIRECT_REVOCATION/)
    assert.ok(loadConfig({ ...env, ...DIRECT_REVOCATION }).revocation)
})

test("delivery and revocation groups: the core keys with no sender are rejected naming both senders", () => {
    const delivery = thrownMessage(() =>
        loadConfig({
            RPC_URL,
            ANNOUNCER_ADDRESS,
            IDENTITY_REGISTRY_ADDRESS,
            CHAIN_ID,
            ...IN_MEMORY_REVOCATION
        })
    )
    const revocation = thrownMessage(() =>
        loadConfig({ RPC_URL, MEMBER_SERVER_TOKEN, REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET })
    )

    for (const message of [delivery, revocation]) {
        assert.match(message, /need a sender/)
        assert.doesNotMatch(message, /must all be set together/)
        assert.match(message, /ENTRY_POINT_ADDRESS/)
        assert.match(message, /MEMBER_PRIVATE_KEY/)
    }
})

test("revocation group: the in-memory flag does not stand in for a sender", () => {
    assert.throws(
        () => loadConfig({ RPC_URL, REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET, ...IN_MEMORY_REVOCATION }),
        /need a sender/
    )
})

test("revocation group: the in-memory message names the core keys and a sender", () => {
    const message = thrownMessage(() => loadConfig({ MEMBER_SERVER_TOKEN }))

    assert.match(message, /REVOCATION_ADDRESS, MEMBER_IDENTITY_SECRET/)
    assert.match(message, /ENTRY_POINT_ADDRESS/)
    assert.match(message, /MEMBER_PRIVATE_KEY/)
})

test("delivery and revocation flags: a value that is not a boolean is rejected", () => {
    for (const flag of ["ALLOW_DIRECT_DELIVERY", "ALLOW_DIRECT_REVOCATION"]) {
        assert.throws(() => loadConfig({ ...DELIVERY_ENV, [flag]: "maybe" }), new RegExp(flag))
    }
})

test("delivery and revocation flags without their keys are inert", () => {
    const config = loadConfig({ RPC_URL, ...DIRECT_DELIVERY, ...DIRECT_REVOCATION, ...IN_MEMORY_REVOCATION })

    assert.equal(config.delivery, undefined)
    assert.equal(config.revocation, undefined)
})

test("both flags with the sponsored group stay sponsored", () => {
    const config = loadConfig({
        ...SPONSORED_DELIVERY_ENV,
        REVOCATION_ADDRESS,
        ...DIRECT_DELIVERY,
        ...DIRECT_REVOCATION
    })

    assert.ok(config.delivery?.sponsored)
    assert.equal(config.delivery.memberPrivateKey, undefined)
    assert.ok(config.revocation?.sponsored)
    assert.equal(config.revocation.memberPrivateKey, undefined)
})

test("CORS origins default to empty and parse a comma-separated allowlist", () => {
    assert.deepEqual(loadConfig({ ...IN_MEMORY_REVOCATION }).allowedOrigins, [])
    assert.deepEqual(
        loadConfig({
            CORS_ALLOWED_ORIGINS: "http://localhost:4173, http://localhost:4174",
            ...IN_MEMORY_REVOCATION
        }).allowedOrigins,
        ["http://localhost:4173", "http://localhost:4174"]
    )
})

test("verification record retention defaults to one day and accepts a positive override", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).verificationRecordTtlSeconds, 86400)
    assert.equal(
        loadConfig({ ...IN_MEMORY_REVOCATION, VERIFICATION_RECORD_TTL_SECONDS: "3600" }).verificationRecordTtlSeconds,
        3600
    )
    assert.throws(
        () => loadConfig({ ...IN_MEMORY_REVOCATION, VERIFICATION_RECORD_TTL_SECONDS: "0" }),
        /VERIFICATION_RECORD_TTL_SECONDS/
    )
})

test("CORS origins must be exact http or https origins", () => {
    for (const origin of ["http://localhost:4173/", "https://example.com/path", "not-a-url", "ftp://example.com"]) {
        assert.throws(
            () => loadConfig({ CORS_ALLOWED_ORIGINS: origin }),
            /CORS_ALLOWED_ORIGINS entry must be an exact http\(s\) origin/
        )
    }
})

test("governance group: setting only its own trigger key is rejected naming every key in the group, CHAIN_ID included", () => {
    const message = thrownMessage(() => loadConfig({ RPC_URL, GOVERNANCE_AUTH_PRIVATE_KEY }))

    assert.match(message, /must all be set together/)
    for (const key of [
        "GOVERNANCE_AUTH_PRIVATE_KEY",
        "GOVERNANCE_SIGNER_PRIVATE_KEY",
        "GOVERNANCE_SEMAPHORE_COMMITMENT",
        "GOVERNANCE_META_STEALTH_ADDRESS",
        "NETWORK_MEMBER_REGISTRY_ADDRESS",
        "NETWORK_MEMBER_GROUP_ADDRESS",
        "NETWORK_MEMBER_GOVERNANCE_ADDRESS",
        "GOVERNANCE_SAFE_ADDRESS",
        "APPROVED_ISSUER_SET_ADDRESS",
        "CHAIN_ID"
    ]) {
        assert.match(message, new RegExp(key))
    }
})

test("governance group: fully set with RPC_URL parses, networkId following ISSUER_NETWORK_ID", () => {
    const config = loadConfig({
        RPC_URL,
        CHAIN_ID,
        GOVERNANCE_AUTH_PRIVATE_KEY,
        ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID,
        GOVERNANCE_SIGNER_PRIVATE_KEY,
        GOVERNANCE_SEMAPHORE_COMMITMENT,
        GOVERNANCE_META_STEALTH_ADDRESS,
        NETWORK_MEMBER_REGISTRY_ADDRESS,
        NETWORK_MEMBER_GROUP_ADDRESS,
        NETWORK_MEMBER_GOVERNANCE_ADDRESS,
        GOVERNANCE_SAFE_ADDRESS,
        APPROVED_ISSUER_SET_ADDRESS,
        ...IN_MEMORY_REVOCATION
    })

    assert.ok(config.governance)
    assert.equal(config.memberServerToken, MEMBER_SERVER_TOKEN)
    assert.equal(config.governance.metaStealthAddress, GOVERNANCE_META_STEALTH_ADDRESS)
    assert.equal(config.governance.authPrivateKey, `0x${GOVERNANCE_AUTH_PRIVATE_KEY}`)
    assert.equal(config.governance.governanceSignerPrivateKey, `0x${GOVERNANCE_SIGNER_PRIVATE_KEY}`)
    assert.equal(config.governance.networkId, config.issuerNetworkId)
    assert.equal(config.governance.semaphoreCommitment, 9n)
    assert.equal(config.governance.registry, NETWORK_MEMBER_REGISTRY_ADDRESS)
    assert.equal(config.governance.deployBlock, 0)
    assert.equal(config.governance.metadataURI, "")
    assert.equal(config.governance.chainId, 31337)
    assert.equal(config.registration, undefined)
})

test("governance group: refuses an ISSUER_NETWORK_ID that is not the id of the auth key", () => {
    const governanceEnv = {
        RPC_URL,
        CHAIN_ID,
        GOVERNANCE_AUTH_PRIVATE_KEY,
        GOVERNANCE_SIGNER_PRIVATE_KEY,
        GOVERNANCE_SEMAPHORE_COMMITMENT,
        GOVERNANCE_META_STEALTH_ADDRESS,
        NETWORK_MEMBER_REGISTRY_ADDRESS,
        NETWORK_MEMBER_GROUP_ADDRESS,
        NETWORK_MEMBER_GOVERNANCE_ADDRESS,
        GOVERNANCE_SAFE_ADDRESS,
        APPROVED_ISSUER_SET_ADDRESS,
        ...IN_MEMORY_REVOCATION
    }

    for (const wrongId of [`0x${"aa".repeat(32)}`, `0x${"00".repeat(12)}${GOVERNANCE_ISSUER_NETWORK_ID.slice(-40)}`]) {
        const message = thrownMessage(() => loadConfig({ ...governanceEnv, ISSUER_NETWORK_ID: wrongId }))

        assert.ok(message.includes(`ISSUER_NETWORK_ID must be ${GOVERNANCE_ISSUER_NETWORK_ID}`), message)
    }
    assert.ok(loadConfig({ ...governanceEnv, ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID }).governance)
})

test("governance group: accepts the auth key's id in any hex case, normalising it", () => {
    const env = {
        RPC_URL,
        CHAIN_ID,
        GOVERNANCE_AUTH_PRIVATE_KEY,
        GOVERNANCE_SIGNER_PRIVATE_KEY,
        GOVERNANCE_SEMAPHORE_COMMITMENT,
        GOVERNANCE_META_STEALTH_ADDRESS,
        NETWORK_MEMBER_REGISTRY_ADDRESS,
        NETWORK_MEMBER_GROUP_ADDRESS,
        NETWORK_MEMBER_GOVERNANCE_ADDRESS,
        GOVERNANCE_SAFE_ADDRESS,
        APPROVED_ISSUER_SET_ADDRESS,
        ...IN_MEMORY_REVOCATION
    }
    const upper = `0x${GOVERNANCE_ISSUER_NETWORK_ID.slice(2).toUpperCase()}`

    const config = loadConfig({ ...env, ISSUER_NETWORK_ID: upper })

    assert.equal(config.issuerNetworkId, GOVERNANCE_ISSUER_NETWORK_ID)
    assert.equal(config.governance?.networkId, GOVERNANCE_ISSUER_NETWORK_ID)
})

test("without the governance group, ISSUER_NETWORK_ID is not tied to any key", () => {
    const networkId = `0x${"ab".repeat(32)}`

    assert.equal(loadConfig({ ...ISSUANCE_ENV, ISSUER_NETWORK_ID: networkId }).issuerNetworkId, networkId)
    assert.equal(loadConfig(ISSUANCE_ENV).governance, undefined)
})

// Bug: GOVERNANCE_TRIGGER_KEYS, unlike DELIVERY_ENV_KEYS, requires neither IDENTITY_REGISTRY_ADDRESS
// nor CHAIN_ID, so narrowing registration's check to its two exclusive keys whenever governance is
// complete let a registration group set MEMBER_IDENTITY_SECRET and SUBMITTER_PRIVATE_KEY without an
// identity registry address at all.
test("governance group: fully set plus the two registration secrets but no IDENTITY_REGISTRY_ADDRESS is rejected", () => {
    const message = thrownMessage(() =>
        loadConfig({
            RPC_URL,
            CHAIN_ID,
            GOVERNANCE_AUTH_PRIVATE_KEY,
            ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID,
            GOVERNANCE_SIGNER_PRIVATE_KEY,
            GOVERNANCE_SEMAPHORE_COMMITMENT,
            GOVERNANCE_META_STEALTH_ADDRESS,
            NETWORK_MEMBER_REGISTRY_ADDRESS,
            NETWORK_MEMBER_GROUP_ADDRESS,
            NETWORK_MEMBER_GOVERNANCE_ADDRESS,
            GOVERNANCE_SAFE_ADDRESS,
            APPROVED_ISSUER_SET_ADDRESS,
            MEMBER_IDENTITY_SECRET,
            SUBMITTER_PRIVATE_KEY
        })
    )

    assert.match(message, /must all be set together/)
    assert.match(message, /IDENTITY_REGISTRY_ADDRESS/)
})

test("governance group: fully set plus all four registration keys parses with both groups set", () => {
    const config = loadConfig({
        RPC_URL,
        CHAIN_ID,
        GOVERNANCE_AUTH_PRIVATE_KEY,
        ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID,
        GOVERNANCE_SIGNER_PRIVATE_KEY,
        GOVERNANCE_SEMAPHORE_COMMITMENT,
        GOVERNANCE_META_STEALTH_ADDRESS,
        NETWORK_MEMBER_REGISTRY_ADDRESS,
        NETWORK_MEMBER_GROUP_ADDRESS,
        NETWORK_MEMBER_GOVERNANCE_ADDRESS,
        GOVERNANCE_SAFE_ADDRESS,
        APPROVED_ISSUER_SET_ADDRESS,
        IDENTITY_REGISTRY_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        SUBMITTER_PRIVATE_KEY,
        ...DIRECT_REGISTRATION,
        ...IN_MEMORY_REVOCATION
    })

    assert.ok(config.governance)
    assert.ok(config.registration)
    assert.equal(config.registration.identityRegistryAddress, IDENTITY_REGISTRY_ADDRESS)
    assert.equal(config.registration.chainId, 31337)
})

// A server reachable over a network must be asked for its member-side API deliberately, so the
// governance group alone is not enough. buildServer still takes no token: its callers are the
// Node scenarios and the route tests, which mount one route at a time in-process.
test("governance group: rejected without MEMBER_SERVER_TOKEN, which the governance and revoke routes need", () => {
    const withoutToken = {
        RPC_URL,
        CHAIN_ID,
        GOVERNANCE_AUTH_PRIVATE_KEY,
        ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID,
        GOVERNANCE_SIGNER_PRIVATE_KEY,
        GOVERNANCE_SEMAPHORE_COMMITMENT,
        GOVERNANCE_META_STEALTH_ADDRESS,
        NETWORK_MEMBER_REGISTRY_ADDRESS,
        NETWORK_MEMBER_GROUP_ADDRESS,
        NETWORK_MEMBER_GOVERNANCE_ADDRESS,
        GOVERNANCE_SAFE_ADDRESS,
        APPROVED_ISSUER_SET_ADDRESS
    }

    assert.match(
        thrownMessage(() => loadConfig(withoutToken)),
        /MEMBER_SERVER_TOKEN is required/
    )
    assert.ok(loadConfig({ ...withoutToken, ...IN_MEMORY_REVOCATION }).governance)
})

test("MEMBER_SERVER_TOKEN is required, and too short a one is rejected", () => {
    assert.throws(() => loadConfig({ ALLOW_IN_MEMORY_REVOCATION: "true" }), /MEMBER_SERVER_TOKEN is required/)
    assert.equal(loadConfig(IN_MEMORY_REVOCATION).memberServerToken, MEMBER_SERVER_TOKEN)
    assert.throws(() => loadConfig({ ...IN_MEMORY_REVOCATION, MEMBER_SERVER_TOKEN: "short" }), /MEMBER_SERVER_TOKEN/)
})

test("registration group: rejected without MEMBER_SERVER_TOKEN, which SUBMITTER_PRIVATE_KEY's gas needs", () => {
    const withoutToken = {
        RPC_URL,
        IDENTITY_REGISTRY_ADDRESS,
        CHAIN_ID,
        MEMBER_IDENTITY_SECRET,
        SUBMITTER_PRIVATE_KEY,
        ...DIRECT_REGISTRATION
    }

    // Full message, not just a prefix, so a widened trigger with the old governance-only wording still fails.
    assert.match(
        thrownMessage(() => loadConfig(withoutToken)),
        /MEMBER_SERVER_TOKEN is required/
    )
    assert.ok(loadConfig({ ...withoutToken, ...IN_MEMORY_REVOCATION }).registration)
})

test("delivery group: rejected without MEMBER_SERVER_TOKEN, which MEMBER_PRIVATE_KEY's gas needs", () => {
    const withoutToken = { ...DELIVERY_ENV, MEMBER_SERVER_TOKEN: undefined }

    assert.match(
        thrownMessage(() => loadConfig(withoutToken)),
        /MEMBER_SERVER_TOKEN is required/
    )
    assert.ok(loadConfig({ ...withoutToken, MEMBER_SERVER_TOKEN }).delivery)
})

test("revocation group: rejected without MEMBER_SERVER_TOKEN, which MEMBER_PRIVATE_KEY's gas needs", () => {
    const withoutToken = {
        RPC_URL,
        REVOCATION_ADDRESS,
        MEMBER_IDENTITY_SECRET,
        MEMBER_PRIVATE_KEY,
        ...DIRECT_REVOCATION
    }

    assert.match(
        thrownMessage(() => loadConfig(withoutToken)),
        /MEMBER_SERVER_TOKEN is required/
    )
    assert.ok(loadConfig({ ...withoutToken, MEMBER_SERVER_TOKEN }).revocation)
})

test("REGISTRATIONS_PER_MINUTE defaults to 30 and rejects 0 or a non-number", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).registrationsPerMinute, 30)
    assert.throws(
        () => loadConfig({ REGISTRATIONS_PER_MINUTE: "0", ...IN_MEMORY_REVOCATION }),
        /REGISTRATIONS_PER_MINUTE/
    )
    assert.throws(
        () => loadConfig({ REGISTRATIONS_PER_MINUTE: "x", ...IN_MEMORY_REVOCATION }),
        /REGISTRATIONS_PER_MINUTE/
    )
})

test("CHALLENGES_PER_MINUTE defaults to 30 and rejects invalid values", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).challengesPerMinute, 30)
    assert.throws(() => loadConfig({ CHALLENGES_PER_MINUTE: "0", ...IN_MEMORY_REVOCATION }), /CHALLENGES_PER_MINUTE/)
    assert.throws(() => loadConfig({ CHALLENGES_PER_MINUTE: "x", ...IN_MEMORY_REVOCATION }), /CHALLENGES_PER_MINUTE/)
})

test("ISSUANCES_PER_MINUTE defaults to 30 and rejects invalid values", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).issuancesPerMinute, 30)
    assert.throws(() => loadConfig({ ISSUANCES_PER_MINUTE: "0", ...IN_MEMORY_REVOCATION }), /ISSUANCES_PER_MINUTE/)
    assert.throws(() => loadConfig({ ISSUANCES_PER_MINUTE: "x", ...IN_MEMORY_REVOCATION }), /ISSUANCES_PER_MINUTE/)
})

test("DELIVERIES_PER_MINUTE defaults to 30 and rejects 0 or a non-number", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).deliveriesPerMinute, 30)
    assert.throws(() => loadConfig({ DELIVERIES_PER_MINUTE: "0", ...IN_MEMORY_REVOCATION }), /DELIVERIES_PER_MINUTE/)
    assert.throws(() => loadConfig({ DELIVERIES_PER_MINUTE: "x", ...IN_MEMORY_REVOCATION }), /DELIVERIES_PER_MINUTE/)
})

test("REGISTRATIONS_PER_MINUTE and DELIVERIES_PER_MINUTE each reach their own field, not swapped", () => {
    const config = loadConfig({ REGISTRATIONS_PER_MINUTE: "5", DELIVERIES_PER_MINUTE: "7", ...IN_MEMORY_REVOCATION })

    assert.equal(config.registrationsPerMinute, 5)
    assert.equal(config.deliveriesPerMinute, 7)
})

test("REVOCATIONS_PER_MINUTE defaults to 30, rejects 0 or a non-number, and reaches its own field", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).revocationsPerMinute, 30)
    assert.throws(() => loadConfig({ REVOCATIONS_PER_MINUTE: "0", ...IN_MEMORY_REVOCATION }), /REVOCATIONS_PER_MINUTE/)
    assert.throws(() => loadConfig({ REVOCATIONS_PER_MINUTE: "x", ...IN_MEMORY_REVOCATION }), /REVOCATIONS_PER_MINUTE/)

    const config = loadConfig({ REVOCATIONS_PER_MINUTE: "9", DELIVERIES_PER_MINUTE: "7", ...IN_MEMORY_REVOCATION })
    assert.equal(config.revocationsPerMinute, 9)
    assert.equal(config.deliveriesPerMinute, 7)
})

test("OPERATOR_TOKEN refuses to start, naming its replacement", () => {
    // Also when the new one is already set, or the old one is empty: a leftover is a leftover.
    for (const env of [
        { OPERATOR_TOKEN: "leftover-token" },
        { OPERATOR_TOKEN: "leftover-token", MEMBER_SERVER_TOKEN },
        { OPERATOR_TOKEN: "" }
    ]) {
        assert.match(
            thrownMessage(() => loadConfig(env)),
            /OPERATOR_TOKEN was renamed to MEMBER_SERVER_TOKEN/
        )
    }
})

const SPONSORED_CORE_ENV = {
    RPC_URL,
    IDENTITY_REGISTRY_ADDRESS,
    CHAIN_ID,
    MEMBER_IDENTITY_SECRET,
    ...IN_MEMORY_REVOCATION
}

test("sponsored group: fully set with the core keys parses as sponsored, with no submitter key", () => {
    const config = loadConfig({ ...SPONSORED_CORE_ENV, ...SPONSORED_ENV })

    assert.ok(config.registration)
    assert.equal(config.registration.submitterPrivateKey, undefined)
    assert.deepEqual(config.registration.sponsored, {
        memberSecret: `0x${MEMBER_IDENTITY_SECRET}`,
        entryPoint: ENTRY_POINT_ADDRESS,
        paymaster: PAYMASTER_ADDRESS,
        accountImplementation: ACCOUNT_IMPLEMENTATION_ADDRESS,
        bundlerUrl: BUNDLER_URL,
        paymasterGroupFromBlock: 0,
        logWindowBlocks: undefined
    })
})

test("sponsored group: rejected without MEMBER_SERVER_TOKEN, which the relayed writes need", () => {
    const withoutToken = { ...SPONSORED_CORE_ENV, ...SPONSORED_ENV, MEMBER_SERVER_TOKEN: undefined }

    assert.match(
        thrownMessage(() => loadConfig(withoutToken)),
        /MEMBER_SERVER_TOKEN is required/
    )
})

test("direct registration: SUBMITTER_PRIVATE_KEY without ALLOW_DIRECT_REGISTRATION is rejected", () => {
    const env = { ...SPONSORED_CORE_ENV, SUBMITTER_PRIVATE_KEY }

    for (const flag of [{}, { ALLOW_DIRECT_REGISTRATION: "false" }]) {
        const message = thrownMessage(() => loadConfig({ ...env, ...flag }))

        assert.match(message, /ALLOW_DIRECT_REGISTRATION=true/)
        assert.match(message, /ENTRY_POINT_ADDRESS/)
    }
    assert.ok(loadConfig({ ...env, ...DIRECT_REGISTRATION }).registration?.submitterPrivateKey)
})

test("registration group: both senders are rejected", () => {
    assert.match(
        thrownMessage(() =>
            loadConfig({ ...SPONSORED_CORE_ENV, ...SPONSORED_ENV, SUBMITTER_PRIVATE_KEY, ...DIRECT_REGISTRATION })
        ),
        /two senders for one route; unset one/
    )
})

test("sponsored group: parses as sponsored alongside the delivery and revocation groups", () => {
    const config = loadConfig({ ...SPONSORED_CORE_ENV, ...SPONSORED_ENV, ANNOUNCER_ADDRESS, REVOCATION_ADDRESS })

    assert.ok(config.registration?.sponsored)
    assert.equal(config.registration.submitterPrivateKey, undefined)
    assert.deepEqual(config.delivery?.sponsored, config.registration.sponsored)
    assert.deepEqual(config.revocation?.sponsored, config.registration.sponsored)
})

test("sponsored group: ALLOW_DIRECT_REGISTRATION=true with the sponsored keys still parses as sponsored", () => {
    const config = loadConfig({ ...SPONSORED_CORE_ENV, ...SPONSORED_ENV, ...DIRECT_REGISTRATION })

    assert.ok(config.registration?.sponsored)
    assert.equal(config.registration.submitterPrivateKey, undefined)
})

test("direct registration: the flag with the direct group sets the submitter key and no sponsored config", () => {
    const config = loadConfig({ ...SPONSORED_CORE_ENV, SUBMITTER_PRIVATE_KEY, ...DIRECT_REGISTRATION })

    assert.equal(config.registration?.submitterPrivateKey, `0x${SUBMITTER_PRIVATE_KEY}`)
    assert.equal(config.registration.sponsored, undefined)
})

test("direct registration: the flag alone yields no registration", () => {
    assert.equal(loadConfig({ ...DIRECT_REGISTRATION, ...IN_MEMORY_REVOCATION }).registration, undefined)
    assert.equal(loadConfig({ RPC_URL, ...DIRECT_REGISTRATION, ...IN_MEMORY_REVOCATION }).registration, undefined)
})

test("direct registration: a value that is not a boolean is rejected", () => {
    assert.throws(
        () => loadConfig({ ...SPONSORED_CORE_ENV, SUBMITTER_PRIVATE_KEY, ALLOW_DIRECT_REGISTRATION: "maybe" }),
        /ALLOW_DIRECT_REGISTRATION/
    )
})

test("direct registration: the flag does not waive RPC_URL", () => {
    assert.match(
        thrownMessage(() =>
            loadConfig({
                IDENTITY_REGISTRY_ADDRESS,
                CHAIN_ID,
                MEMBER_IDENTITY_SECRET,
                SUBMITTER_PRIVATE_KEY,
                MEMBER_SERVER_TOKEN,
                ...DIRECT_REGISTRATION
            })
        ),
        /require RPC_URL/
    )
})

test("MIN_DEVICE_SECURITY_LEVEL defaults to TRUSTED_ENVIRONMENT, accepts SOFTWARE, rejects UNKNOWN", () => {
    assert.equal(loadConfig({ ...IN_MEMORY_REVOCATION }).minDeviceSecurityLevel, "TRUSTED_ENVIRONMENT")
    assert.equal(
        loadConfig({ MIN_DEVICE_SECURITY_LEVEL: "SOFTWARE", ...IN_MEMORY_REVOCATION }).minDeviceSecurityLevel,
        "SOFTWARE"
    )
    assert.throws(
        () => loadConfig({ MIN_DEVICE_SECURITY_LEVEL: "UNKNOWN", ...IN_MEMORY_REVOCATION }),
        /MIN_DEVICE_SECURITY_LEVEL/
    )
})

test("the attestation status list defaults to Google's, kept for at most 72 hours", () => {
    const config = loadConfig({ ...IN_MEMORY_REVOCATION })
    assert.equal(config.deviceAttestationStatusUrl, "https://android.googleapis.com/attestation/status")
    assert.equal(config.deviceAttestationMaxStalenessSeconds, 259200)
})

test("the attestation status list URL and staleness limit are configurable", () => {
    const config = loadConfig({
        DEVICE_ATTESTATION_STATUS_URL: "http://127.0.0.1:9/status",
        DEVICE_ATTESTATION_MAX_STALENESS_SECONDS: "3600",
        ...IN_MEMORY_REVOCATION
    })
    assert.equal(config.deviceAttestationStatusUrl, "http://127.0.0.1:9/status")
    assert.equal(config.deviceAttestationMaxStalenessSeconds, 3600)
    assert.throws(
        () => loadConfig({ DEVICE_ATTESTATION_STATUS_URL: "not a url", ...IN_MEMORY_REVOCATION }),
        /DEVICE_ATTESTATION_STATUS_URL/
    )
    for (const bad of ["0", "-1", "1.5", "soon"]) {
        assert.throws(
            () => loadConfig({ DEVICE_ATTESTATION_MAX_STALENESS_SECONDS: bad, ...IN_MEMORY_REVOCATION }),
            /DEVICE_ATTESTATION_MAX_STALENESS_SECONDS/,
            bad
        )
    }
})

test("the attestation staleness limit is at least 30 minutes", () => {
    for (const short of ["600", "1799"]) {
        assert.throws(
            () => loadConfig({ DEVICE_ATTESTATION_MAX_STALENESS_SECONDS: short, ...IN_MEMORY_REVOCATION }),
            /DEVICE_ATTESTATION_MAX_STALENESS_SECONDS must be at least 1800/,
            short
        )
    }
    const config = loadConfig({ DEVICE_ATTESTATION_MAX_STALENESS_SECONDS: "1800", ...IN_MEMORY_REVOCATION })
    assert.equal(config.deviceAttestationMaxStalenessSeconds, 1800)
})

const LOG_GROUPS_ENV = {
    RPC_URL,
    CHAIN_ID,
    IDENTITY_REGISTRY_ADDRESS,
    MEMBER_IDENTITY_SECRET,
    REVOCATION_ADDRESS,
    MEMBER_SERVER_TOKEN,
    ISSUER_NETWORK_ID: GOVERNANCE_ISSUER_NETWORK_ID,
    GOVERNANCE_AUTH_PRIVATE_KEY,
    GOVERNANCE_SIGNER_PRIVATE_KEY,
    GOVERNANCE_SEMAPHORE_COMMITMENT,
    GOVERNANCE_META_STEALTH_ADDRESS,
    NETWORK_MEMBER_REGISTRY_ADDRESS,
    NETWORK_MEMBER_GROUP_ADDRESS,
    NETWORK_MEMBER_GOVERNANCE_ADDRESS,
    GOVERNANCE_SAFE_ADDRESS,
    APPROVED_ISSUER_SET_ADDRESS
}
const DIRECT_LOG_GROUPS_ENV = {
    ...LOG_GROUPS_ENV,
    SUBMITTER_PRIVATE_KEY,
    MEMBER_PRIVATE_KEY,
    ...DIRECT_REGISTRATION,
    ...DIRECT_REVOCATION
}
const SPONSORED_LOG_GROUPS_ENV = { ...LOG_GROUPS_ENV, ...SPONSORED_ENV }

test("LOG_WINDOW_BLOCKS reaches registration, revocation and governance; LOG_CONFIRMATIONS reaches governance", () => {
    const config = loadConfig({ ...DIRECT_LOG_GROUPS_ENV, LOG_WINDOW_BLOCKS: "10", LOG_CONFIRMATIONS: "2" })

    assert.equal(config.registration?.logWindowBlocks, 10)
    assert.equal(config.revocation?.logWindowBlocks, 10)
    assert.equal(config.governance?.logWindowBlocks, 10)
    assert.equal(config.governance?.logConfirmations, 2)
})

test("LOG_WINDOW_BLOCKS reaches the sponsored stack beside the member groups", () => {
    const config = loadConfig({ ...SPONSORED_LOG_GROUPS_ENV, LOG_WINDOW_BLOCKS: "10" })

    assert.equal(config.registration?.sponsored?.logWindowBlocks, 10)
    assert.equal(config.revocation?.sponsored?.logWindowBlocks, 10)
    assert.equal(config.registration?.logWindowBlocks, 10)
})

test("LOG_WINDOW_BLOCKS and LOG_CONFIRMATIONS default to unset", () => {
    const config = loadConfig(DIRECT_LOG_GROUPS_ENV)

    assert.equal(config.registration?.logWindowBlocks, undefined)
    assert.equal(config.revocation?.logWindowBlocks, undefined)
    assert.equal(config.governance?.logWindowBlocks, undefined)
    assert.equal(config.governance?.logConfirmations, undefined)
    assert.equal(loadConfig(SPONSORED_LOG_GROUPS_ENV).registration?.sponsored?.logWindowBlocks, undefined)
})

test("LOG_WINDOW_BLOCKS must be positive and LOG_CONFIRMATIONS must not be negative", () => {
    assert.throws(() => loadConfig({ ...DIRECT_LOG_GROUPS_ENV, LOG_WINDOW_BLOCKS: "0" }), /LOG_WINDOW_BLOCKS/)
    assert.throws(() => loadConfig({ ...DIRECT_LOG_GROUPS_ENV, LOG_CONFIRMATIONS: "-1" }), /LOG_CONFIRMATIONS/)
    assert.equal(loadConfig({ ...DIRECT_LOG_GROUPS_ENV, LOG_CONFIRMATIONS: "0" }).governance?.logConfirmations, 0)
})
