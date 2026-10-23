import { deriveKeys, generateDeviceSecret, type Hex } from "@coordination-network/identity"
import { deriveDeviceKeyCommitment, parseZkCredential } from "@coordination-network/credential"
import { CREDENTIAL_PREFIX } from "@coordination-network/wallet"
import { LinkError, type DecodedLinkRequest, type LinkHandlers } from "@coordination-network/user-app-link"
import { buildConsentSummary } from "./consent"
import { readDeviceSecret, writeDeviceSecret } from "./device-secret"
import { credentialIssueHandler } from "./handlers/credential-issue"
import { presentationCreateHandler } from "./handlers/presentation-create"
import { registrationSignHandler } from "./handlers/registration-sign"
import { assembleIdentity } from "./identity"
import { deleteIssuerEntries, listIssuerEntries } from "./issuer-index"
import { nowFn } from "./now"
import { meetsSecurityLevel } from "./security-level"
import { buildWallet, createIdentitySeedCache, neverLoadChainState } from "./wallet-factory"
import type {
    HeldCredential,
    HeldCredentialStatus,
    RevocationAuthority,
    PublicIdentity,
    StealthScanKeys,
    UserAppPorts,
    UserAppService
} from "./types"

/**
 * Still not `Wallet`'s own status: that also carries `issuer-not-approved`, which `syncRevocations`
 * stamps against whichever single member last asked for a presentation, and reporting one member's
 * verdict on another member's credential would be worse than reporting nothing.
 *
 * Revocation is no longer in that category. It used to be - one registry per issuer left a
 * mixed-issuer listing with no single authority to sync against - but the whole network now revokes
 * into one registry, so there is exactly one thing to ask and asking it names no issuer.
 */
function windowStatus(notBefore: number, expiresAt: number, nowSeconds: number): HeldCredentialStatus {
    if (nowSeconds < notBefore) return "not-yet-valid"
    if (nowSeconds > expiresAt) return "expired"
    return "valid"
}

/**
 * The window first, since it is signed into the credential and needs no one to confirm: a
 * credential already outside its dates is reported as such without disclosing anything to a node.
 * Only an otherwise usable credential is worth asking the registry about.
 */
async function statusOf(
    notBefore: number,
    expiresAt: number,
    nowSeconds: number,
    revocationCommitment: bigint,
    authority: RevocationAuthority | undefined
): Promise<HeldCredentialStatus> {
    const window = windowStatus(notBefore, expiresAt, nowSeconds)
    if (window !== "valid") return window
    if (authority === undefined) return "unchecked"

    // A listing has to render whatever the network is doing, so an unreachable authority is an
    // answer here - "not checked" - rather than a failure that blanks the screen.
    let revoked: boolean | null
    try {
        revoked = await authority.isRevoked(revocationCommitment)
    } catch {
        revoked = null
    }
    if (revoked === null) return "unchecked"
    return revoked ? "revoked" : "valid"
}

/** Inverse of `packages/credential`'s `countryCode`: three ASCII bytes packed into one integer. */
function decodeCountryCode(code: number): string {
    return String.fromCharCode((code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff)
}

export function createUserAppService(ports: UserAppPorts): UserAppService {
    // `undefined` means "not yet read from the store"; `null` means "confirmed not onboarded".
    // Distinguishing the two means onboarding status is read from the store at most once.
    let deviceSecretCache: Hex | null | undefined

    async function resolveDeviceSecret(): Promise<Hex | null> {
        if (deviceSecretCache === undefined) {
            deviceSecretCache = await readDeviceSecret(ports.store)
        }
        return deviceSecretCache
    }

    /** The gate every handler shares: onboarding is an explicit app action, never implicit. */
    async function requireOnboarded(): Promise<Hex> {
        const secret = await resolveDeviceSecret()
        if (secret === null) throw new LinkError("NOT_ONBOARDED", "no identity has been created yet")
        return secret
    }

    const seeds = createIdentitySeedCache(ports.deviceKey)

    // One slot deep: a handler body reads and writes the same store a concurrent one might be
    // mid-sync against, so two deep links run their handler bodies one at a time, never interleaved.
    let queue: Promise<unknown> = Promise.resolve()
    function serialize<T>(run: () => Promise<T>): Promise<T> {
        const result = queue.then(run)
        queue = result.then(
            () => undefined,
            () => undefined
        )
        return result
    }

    const handlers: LinkHandlers = {
        "registration.sign": (params) =>
            serialize(async () => registrationSignHandler(ports, await requireOnboarded(), params)),

        "credential.issue": (params) =>
            serialize(async () => credentialIssueHandler(ports, seeds, await requireOnboarded(), params)),

        "presentation.create": (params) =>
            serialize(async () => {
                await requireOnboarded()
                return presentationCreateHandler(ports, seeds, params)
            })
    }

    return {
        handlers,

        async consent(request: DecodedLinkRequest): Promise<boolean> {
            return ports.consent(buildConsentSummary(request))
        },

        async isOnboarded(): Promise<boolean> {
            return (await resolveDeviceSecret()) !== null
        },

        createIdentity(): Promise<PublicIdentity> {
            return serialize(async () => {
                if ((await resolveDeviceSecret()) !== null) {
                    throw new Error("createIdentity: an identity already exists — erase() before creating another")
                }
                const minimum = ports.minimumDeviceSecurityLevel
                if (minimum !== undefined) {
                    const level = await ports.deviceKey.getSecurityLevel()
                    if (!meetsSecurityLevel(level, minimum)) {
                        throw new Error(
                            `This phone's key protection is ${level}; creating an identity needs a hardware-backed key (${minimum} or better).`
                        )
                    }
                }
                const secret = generateDeviceSecret()
                const identity = await assembleIdentity(secret, ports.deviceKey)
                await writeDeviceSecret(ports.store, secret)
                deviceSecretCache = secret
                return identity
            })
        },

        async readIdentity(): Promise<PublicIdentity> {
            const secret = await resolveDeviceSecret()
            if (secret === null) throw new Error("readIdentity: no identity has been created yet")
            return assembleIdentity(secret, ports.deviceKey)
        },

        async readStealthScanKeys(): Promise<StealthScanKeys> {
            const secret = await resolveDeviceSecret()
            if (secret === null) throw new Error("readStealthScanKeys: no identity has been created yet")
            const keys = deriveKeys(secret)
            return { spendingPublicKey: keys.spending.publicKey, viewingPrivateKey: keys.viewing.privateKey }
        },

        /**
         * Joined by credential id with the issuer index, which is the only place the issuer's
         * name and the plaintext programme survive — the credential body carries a hash.
         */
        async listCredentials(): Promise<HeldCredential[]> {
            const wallet = buildWallet(ports, seeds, neverLoadChainState, null)
            const held = await wallet.listCredentials()
            const entryByCredentialId = new Map(
                (await listIssuerEntries(ports.store)).map((entry) => [entry.credentialId, entry])
            )
            const nowSeconds = Math.floor(nowFn(ports) / 1000)
            const named = held.flatMap((info) => {
                const entry = entryByCredentialId.get(info.id)
                // A credential with no entry predates the index and cannot be named or proved;
                // the demo erases and reinstalls rather than migrating.
                if (entry === undefined) return []
                return [{ info, entry, body: parseZkCredential(info.credential).body }]
            })
            // One registry read per usable credential, all in flight together: a listing of two
            // credentials should not cost two round trips in sequence.
            return Promise.all(
                named.map(async ({ info, entry, body }) => ({
                    id: info.id,
                    status: await statusOf(
                        body.notBefore,
                        body.expiresAt,
                        nowSeconds,
                        body.revocationCommitment,
                        ports.revocations
                    ),
                    issuerNetworkId: entry.issuerNetworkId,
                    programme: entry.programme,
                    issuedAt: entry.issuedAt,
                    programmeHash: body.programmeHash.toString(),
                    country: decodeCountryCode(body.countryCode),
                    notBefore: body.notBefore,
                    expiresAt: body.expiresAt
                }))
            )
        },

        removeUnboundCredentials(): Promise<number> {
            return serialize(async () => {
                const commitment = deriveDeviceKeyCommitment(await ports.deviceKey.getPublicKeyJwk())
                const wallet = buildWallet(ports, seeds, neverLoadChainState, null)
                const unbound: string[] = []
                for (const key of await ports.store.list()) {
                    if (!key.startsWith(CREDENTIAL_PREFIX)) continue
                    const id = key.slice(CREDENTIAL_PREFIX.length)
                    try {
                        const info = await wallet.getCredential(id)
                        if (
                            info !== null &&
                            parseZkCredential(info.credential).body.deviceKeyCommitment !== commitment
                        ) {
                            unbound.push(id)
                        }
                    } catch {
                        // Unreadable, so not proven unbound: left in place.
                    }
                }
                if (unbound.length === 0) return 0
                // Index entries first: a run killed before the credentials go leaves them still
                // unbound, so the next run removes them.
                await deleteIssuerEntries(ports.store, new Set(unbound))
                for (const id of unbound) await wallet.deleteCredential(id)
                seeds.clear()
                return unbound.length
            })
        },

        /**
         * Clears the entire store, not only this package's own keys — a host app shares it, and an
         * "erase everything" that left its configuration behind would be a half-erase. A caller
         * must therefore drop whatever it keeps in there too.
         */
        erase(): Promise<void> {
            return serialize(async () => {
                for (const key of await ports.store.list()) await ports.store.delete(key)
                deviceSecretCache = null
                seeds.clear()
            })
        }
    }
}
