import { ApprovedIssuerSet, issuerKeyLeaf } from "@coordination-network/issuer-set"
import {
    InMemoryResolver,
    IssuanceError,
    LocalCredentialSigner,
    issueZkCredential,
    serializeZkCredential
} from "@coordination-network/credential"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import type { Hex32, Jwk } from "@coordination-network/user-app-link"
import type { ChainRoots } from "../../src/types"
import { bytesToHex, hexToBytes } from "../../src/hex"
import { FakeHttpClient } from "./fake-http"
import { randomUUID } from "node:crypto"

/** `apps/issuer-service`'s `credentialsBody`, as it arrives over the wire. */
interface CredentialsBody {
    challengeId: string
    subjectNetworkId: `0x${string}`
    approvalScope: { programme: string; country: string }
    confirmationKey: Jwk
    accountPublicKey: `0x${string}`
    devicePopSignature: `0x${string}`
    accountPopSignature: `0x${string}`
    identityPublicKey: [string, string]
    identityOwnershipSignature: { R8: [string, string]; S: string }
    revocation: {
        commitment: string
        publicKey: [string, string]
        ownershipSignature: { R8: [string, string]; S: string }
    }
    deviceAttestation?: string[]
}

/**
 * Stands in for one network member's server over a `FakeHttpClient`, mirroring the
 * `apps/issuer-service` routes the apps actually call: `POST /v1/challenge`,
 * `POST /v1/credentials`, `GET /v1/issuers`, `GET /v1/revocations/snapshot`, `POST /v1/verify`,
 * `GET /v1/verifications/:id` and `POST /v1/presentation-requests/:id/close`. Issuance is real —
 * the nonce it hands out is the one the holder bindings are then verified against — and the
 * mutable state below is there for a test to revoke or retire against directly.
 */
export interface MemberStack {
    issuerNetworkId: Hex32
    credentialSigner: LocalCredentialSigner
    revocations: RevocationRegistry
    challengeUrl: string
    credentialsUrl: string
    issuersUrl: string
    revocationsUrl: string
    verifyUrl: string
    http: FakeHttpClient
    /** Currently-approved issuer signing keys; splice one out to simulate a retired issuer. */
    approvedIssuerKeys: [bigint, bigint][]
    /** Every credential this member has issued, by id. */
    issued: Map<string, { revocationCommitment: bigint }>
    /** What `GET /v1/verifications/:id` serves, by verification id. */
    verifications: Map<string, unknown>
    /** Set this to make `POST /v1/credentials` answer the way the real route refuses one. */
    refusal: { status: number; body: unknown } | null
    revoke(credentialId: string): void
    /** The roots the chain would hold if it held what this member serves right now. */
    chainRoots(): ChainRoots
    /** The nonce this member last handed that subject, kept past consumption for assertions. */
    lastNonceFor(subjectNetworkId: string): Uint8Array
    verificationUrl(verificationId: string): string
    closeUrl(requestId: string): string
    /** Routes are matched by exact URL, so a request id has to be named before it can be closed. */
    serveClose(requestId: string): void
}

let memberCounter = 0

const stacks = new Map<string, MemberStack>()

/**
 * What `ApprovedIssuerSet.issuerKeysOf` answers for a stack built here: its signer's own key, kept
 * apart from `approvedIssuerKeys` so a test can alter the issuer's published list without moving
 * the chain's.
 */
export async function issuerKeyLeavesOf(networkId: string): Promise<bigint[]> {
    const stack = stacks.get(networkId)
    return stack ? [issuerKeyLeaf(await stack.credentialSigner.getPublicKey())] : []
}

export async function createMemberStack(
    http: FakeHttpClient = new FakeHttpClient(),
    options: { now?: () => number; revocations?: RevocationRegistry } = {}
): Promise<MemberStack> {
    memberCounter += 1
    // Captured: the module counter moves on as later stacks are created, and these ids must not.
    const index = memberCounter
    const now = options.now ?? Date.now
    const origin = `https://member-${index}.example`
    const issuerNetworkId = `0x${index.toString(16).padStart(64, "0")}` as Hex32
    const credentialSigner = new LocalCredentialSigner(`member-stack-${index}`)
    // Shared when the caller passes one, because the network has a single revocation registry and
    // every member serves the same tree.
    const revocations = options.revocations ?? new RevocationRegistry()
    const approvedIssuerKeys: [bigint, bigint][] = [await credentialSigner.getPublicKey()]
    const issued = new Map<string, { revocationCommitment: bigint }>()
    const verifications = new Map<string, unknown>()
    const nonces = new Map<string, Uint8Array>()
    const noncesHandedOut = new Map<string, Uint8Array>()
    let counter = 0

    const resolver = new InMemoryResolver()
    resolver.approveMember(issuerNetworkId)

    function recordVerification(verificationId: string, record: unknown): void {
        verifications.set(verificationId, record)
        http.onGet(stack.verificationUrl(verificationId), () => ({ status: 200, body: record }))
    }

    const stack: MemberStack = {
        issuerNetworkId,
        credentialSigner,
        revocations,
        challengeUrl: `${origin}/v1/challenge`,
        credentialsUrl: `${origin}/v1/credentials`,
        issuersUrl: `${origin}/v1/issuers`,
        revocationsUrl: `${origin}/v1/revocations/snapshot`,
        verifyUrl: `${origin}/v1/verify`,
        http,
        approvedIssuerKeys,
        issued,
        verifications,
        refusal: null,
        revoke(credentialId) {
            const record = issued.get(credentialId)
            if (!record) throw new Error(`this member stack never issued ${credentialId}`)
            revocations.revoke(record.revocationCommitment)
        },
        chainRoots: () => {
            const approvedIssuers = new ApprovedIssuerSet(approvedIssuerKeys)
            return {
                approvedIssuerRoot: approvedIssuers.root,
                approvedIssuerLeafCount: approvedIssuers.leafCount,
                revocationRoot: revocations.root
            }
        },
        lastNonceFor(subjectNetworkId) {
            const nonce = noncesHandedOut.get(subjectNetworkId)
            if (!nonce) throw new Error(`this member stack never challenged ${subjectNetworkId}`)
            return nonce
        },
        verificationUrl: (verificationId) => `${origin}/v1/verifications/${verificationId}`,
        closeUrl: (requestId) => `${origin}/v1/presentation-requests/${requestId}/close`,
        serveClose(requestId) {
            http.onPost(stack.closeUrl(requestId), (body) => {
                counter += 1
                const verificationId = `urn:uuid:member-${index}-verification-${counter}`
                recordVerification(verificationId, {
                    verificationId,
                    requestId,
                    ok: false,
                    code: (body as { code: string }).code
                })
                return { status: 200, body: { verificationId } }
            })
        }
    }

    // `read()`, so /v1/issuers serves the same leaves-plus-root pair a chain-backed set would: a
    // test that mutates `approvedIssuerKeys` between requests still gets a matching root.
    http.onGet(stack.issuersUrl, () => {
        const approvedIssuers = new ApprovedIssuerSet(approvedIssuerKeys)
        return {
            status: 200,
            body: {
                leaves: approvedIssuers.leafSlots.map((leaf) => leaf.toString()),
                root: approvedIssuers.root.toString(),
                blockNumber: "0",
                approvedIssuerSet: null
            }
        }
    })

    http.onGet(stack.revocationsUrl, () => ({
        status: 200,
        body: { root: revocations.root.toString(), snapshot: revocations.export() }
    }))

    // The real route writes its nonce with @noble/hashes' bytesToHex, which adds no 0x prefix.
    http.onPost(stack.challengeUrl, (body) => {
        counter += 1
        const nonce = Uint8Array.from({ length: 32 }, (_, position) => (counter * 31 + position) % 256)
        const { subjectNetworkId } = body as { subjectNetworkId: string }
        const challengeId = randomUUID()
        nonces.set(challengeId, nonce)
        noncesHandedOut.set(subjectNetworkId, nonce)
        return {
            status: 200,
            body: { challengeId, nonce: bytesToHex(nonce).slice(2), expiresAt: Math.floor(now() / 1000) + 300 }
        }
    })

    http.onPost(stack.credentialsUrl, async (body) => {
        if (stack.refusal) return stack.refusal

        const request = body as CredentialsBody
        const nonce = nonces.get(request.challengeId)
        if (!nonce) return { status: 400, body: { error: "issuance refused", code: "ISSUANCE_REFUSED" } }
        nonces.delete(request.challengeId)

        const nowSeconds = Math.floor(now() / 1000)
        try {
            const credential = await issueZkCredential(
                {
                    issuerNetworkId,
                    subjectNetworkId: request.subjectNetworkId,
                    approvalScope: request.approvalScope,
                    validFrom: nowSeconds - 3_600,
                    validUntil: nowSeconds + 3_600,
                    confirmationKey: request.confirmationKey,
                    accountPublicKey: hexToBytes(request.accountPublicKey),
                    nonce,
                    devicePopSignature: hexToBytes(request.devicePopSignature),
                    accountPopSignature: hexToBytes(request.accountPopSignature),
                    identityPublicKey: [BigInt(request.identityPublicKey[0]), BigInt(request.identityPublicKey[1])],
                    identityOwnershipSignature: {
                        R8: [
                            BigInt(request.identityOwnershipSignature.R8[0]),
                            BigInt(request.identityOwnershipSignature.R8[1])
                        ],
                        S: BigInt(request.identityOwnershipSignature.S)
                    },
                    revocation: {
                        commitment: BigInt(request.revocation.commitment),
                        publicKey: [BigInt(request.revocation.publicKey[0]), BigInt(request.revocation.publicKey[1])],
                        ownershipSignature: {
                            R8: [
                                BigInt(request.revocation.ownershipSignature.R8[0]),
                                BigInt(request.revocation.ownershipSignature.R8[1])
                            ],
                            S: BigInt(request.revocation.ownershipSignature.S)
                        }
                    }
                },
                credentialSigner,
                resolver
            )

            counter += 1
            const id = `urn:uuid:member-${index}-credential-${counter}`
            issued.set(id, { revocationCommitment: credential.body.revocationCommitment })
            return { status: 201, body: { id, credential: serializeZkCredential(credential) } }
        } catch (error) {
            if (error instanceof IssuanceError) return { status: 400, body: { error: error.message, code: error.code } }
            return { status: 500, body: { error: "issuance failed" } }
        }
    })

    http.onPost(stack.verifyUrl, (body) => {
        counter += 1
        const verificationId = `urn:uuid:member-${index}-verification-${counter}`
        recordVerification(verificationId, {
            verificationId,
            requestId: (body as { requestId: string }).requestId,
            ok: true
        })
        return { status: 200, body: { verificationId, ok: true } }
    })

    stacks.set(issuerNetworkId, stack)
    return stack
}
