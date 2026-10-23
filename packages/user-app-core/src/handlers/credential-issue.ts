import { buildDeviceBindingMessage, deriveKeys, signAccountBinding, type Hex } from "@coordination-network/identity"
import { Identity } from "@semaphore-protocol/identity"
import {
    countryCode,
    deriveRevocationCommitment,
    generateRevocationSecret,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    parseZkCredential,
    programmeHash,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    type ZkCredential
} from "@coordination-network/credential"
import { issuerKeyLeaf } from "@coordination-network/issuer-set"
import type { ChainStateLoader, Wallet, WalletChainState } from "@coordination-network/wallet"
import { LinkError, type CredentialIssueParams, type CredentialIssueResult } from "@coordination-network/user-app-link"
import { listsMatchChain, readLists } from "../chain-state"
import { DeviceKeyError, mapDeviceKeyError, mapWalletError } from "../errors"
import { bigintToBytes32, bytesToHex, hexToBytes } from "../hex"
import { challengeResponseSchema, issueCredentialResponseSchema, postToMember, type MemberRefusal } from "../member-api"
import { readIssuerEntry, writeIssuerEntry } from "../issuer-index"
import { nowFn } from "../now"
import { CREDENTIAL_ISSUE_STEPS } from "../steps"
import { buildWallet, type IdentitySeedCache } from "../wallet-factory"
import type { KeyPrompt, UserAppPorts } from "../types"

type Refusal = Extract<CredentialIssueResult, { status: "refused" }>

/** The issuer answered, but named no reason of its own. */
const UNNAMED_REFUSAL = "ISSUANCE_REFUSED"

/** A Baby Jubjub point as the decimal-string pair the wire protocol carries. */
const pointToStrings = (point: readonly [bigint, bigint]): [string, string] => [String(point[0]), String(point[1])]

/** Relayed in the issuer's own words, under a stand-in code when it named none of its own. */
const refused = ({ code, message }: MemberRefusal): Refusal => ({
    status: "refused",
    code: code ?? UNNAMED_REFUSAL,
    message
})

const isMemberKey = (memberKeyLeaves: ReadonlySet<bigint>, key: readonly [string, string]): boolean =>
    memberKeyLeaves.has(issuerKeyLeaf([BigInt(key[0]), BigInt(key[1])]))

/** A cancel or an invalidated key reaches the person as the link error that says so, not as an internal failure. */
async function keyUse<T>(use: Promise<T>): Promise<T> {
    try {
        return await use
    } catch (error) {
        throw error instanceof DeviceKeyError ? mapDeviceKeyError(error) : error
    }
}

/**
 * Whether an indexed credential still stops this member issuing another for the same programme.
 * Only one that is valid right now does: a revoked or expired credential, or an entry whose
 * credential is gone, would otherwise leave the person with no way back but erasing everything.
 */
async function isStillValid(wallet: Wallet, credentialId: string, load: ChainStateLoader): Promise<boolean> {
    if ((await wallet.getCredential(credentialId)) === null) return false
    await wallet.syncCredential(credentialId, load)
    return (await wallet.getCredential(credentialId))?.status === "valid"
}

/**
 * The whole issuance, behind the one consent the link boundary already took: hold check, nonce,
 * binding, the issuer's signature, the two authority checks, storage. Assembly over existing
 * functions, no new cryptography.
 *
 * The revocation secret is generated and opened inside this one call, so it never leaves the
 * function and nothing has to persist it between two deep links.
 */
export async function credentialIssueHandler(
    ports: UserAppPorts,
    seeds: IdentitySeedCache,
    deviceSecret: Hex,
    params: CredentialIssueParams
): Promise<CredentialIssueResult> {
    const step = (name: string) => ports.progress("credential.issue", name)

    step(CREDENTIAL_ISSUE_STEPS.held)
    const held = await readIssuerEntry(ports.store, params.issuerNetworkId, params.approvalScope)

    // Read before the issuer signs: the revocation secret below never leaves this call, so a
    // failure after the 201 would orphan the credential at the issuer with nothing able to open it.
    // So is the chain read, and an empty key list refuses before any challenge. Whether the signing
    // key is among the keys can only be known after the signature; that mismatch is refused below.
    step(CREDENTIAL_ISSUE_STEPS.lists)
    const [lists, leafRead, rootsRead] = await Promise.allSettled([
        readLists(ports.http, params.issuersUrl, params.revocationsUrl),
        ports.directory.issuerKeyLeavesOf(params.issuerNetworkId),
        ports.roots.currentRoots()
    ])
    if (lists.status === "rejected") {
        throw new LinkError(
            "ISSUER_UNREACHABLE",
            lists.reason instanceof Error
                ? lists.reason.message
                : "the issuer's approved-issuer set or revocation snapshot is unreadable"
        )
    }
    if (leafRead.status === "rejected") {
        // Fixed text: a viem message carries the RPC URL, which can hold a provider key.
        throw new LinkError("CHAIN_UNREACHABLE", "the approved issuer keys could not be read from chain")
    }
    if (rootsRead.status === "rejected") {
        throw new LinkError("CHAIN_UNREACHABLE", "the current roots could not be read from chain")
    }
    // The wallet's own check only runs once the issuer has signed, which would orphan the credential.
    if (!listsMatchChain(lists.value, rootsRead.value)) {
        throw new LinkError("ISSUER_UNREACHABLE", "the issuer's lists do not match the chain")
    }
    const chainState: WalletChainState = {
        ...lists.value,
        approvedIssuerRoot: rootsRead.value.approvedIssuerRoot,
        revocationRoot: rootsRead.value.revocationRoot
    }
    const memberKeyLeaves = new Set(leafRead.value)
    if (memberKeyLeaves.size === 0) {
        throw new LinkError("ISSUER_NOT_APPROVED", `no approved issuer key is known for ${params.issuerNetworkId}`)
    }

    const loadChainState: ChainStateLoader = async () => chainState
    // The hold check below reads and syncs only, so it asks nothing of the keys; the seed and the
    // signature come after the challenge.
    const prompt: KeyPrompt = {
        title: "Bind a credential to this phone",
        subtitle: `${params.approvalScope.programme} (${params.approvalScope.country})`
    }
    const wallet = buildWallet(ports, seeds, loadChainState, prompt)
    if (
        held !== null &&
        isMemberKey(memberKeyLeaves, held.issuerPublicKey) &&
        (await isStillValid(wallet, held.credentialId, loadChainState))
    ) {
        return { status: "alreadyHeld", credentialId: held.credentialId }
    }

    const keys = deriveKeys(deviceSecret)

    step(CREDENTIAL_ISSUE_STEPS.challenge)
    const challenge = await postToMember(
        ports.http,
        params.challengeUrl,
        { subjectNetworkId: keys.networkId },
        { status: 200, schema: challengeResponseSchema, unreachable: "ISSUER_UNREACHABLE" }
    )
    if (challenge.refusal) return refused(challenge.refusal)
    const nonce = challenge.value.nonce

    step(CREDENTIAL_ISSUE_STEPS.binding)
    const seed = await keyUse(seeds.resolve())
    const identity = new Identity(seed)
    const confirmationKey = await ports.deviceKey.getPublicKeyJwk()
    const revocationSecret = generateRevocationSecret()
    const ownership = signCommitmentOwnership(revocationSecret, hexToBytes(nonce))
    const holderOwnership = signHolderKeyOwnership(seed, hexToBytes(nonce))

    const deviceBindingMessage = buildDeviceBindingMessage(
        nonce,
        keys.networkId,
        bigintToBytes32(identity.commitment),
        issuanceRequestCommitment(params.issuerNetworkId, params.approvalScope)
    )
    const devicePopSignature = bytesToHex(await keyUse(ports.deviceKey.signerFor(prompt).sign(deviceBindingMessage)))
    const { signature: accountPopSignature } = signAccountBinding(
        keys.account.privateKey,
        nonce,
        jwkToPublicKeyBytes(confirmationKey)
    )

    step(CREDENTIAL_ISSUE_STEPS.signing)
    const deviceAttestation = await ports.deviceKey.getAttestationChain()
    const issued = await postToMember(
        ports.http,
        params.credentialsUrl,
        {
            challengeId: challenge.value.challengeId,
            subjectNetworkId: keys.networkId,
            approvalScope: params.approvalScope,
            confirmationKey,
            accountPublicKey: keys.account.uncompressedPublicKey,
            devicePopSignature,
            accountPopSignature,
            identityPublicKey: pointToStrings(identity.publicKey),
            identityOwnershipSignature: {
                R8: pointToStrings(holderOwnership.signature.R8),
                S: String(holderOwnership.signature.S)
            },
            revocation: {
                commitment: deriveRevocationCommitment(revocationSecret).toString(),
                publicKey: pointToStrings(ownership.publicKey),
                ownershipSignature: {
                    R8: pointToStrings(ownership.signature.R8),
                    S: String(ownership.signature.S)
                }
            },
            ...(deviceAttestation.length > 0 && { deviceAttestation })
        },
        { status: 201, schema: issueCredentialResponseSchema, unreachable: "ISSUER_UNREACHABLE" }
    )
    if (issued.refusal) return refused(issued.refusal)

    let parsed: ZkCredential
    try {
        parsed = parseZkCredential(issued.value.credential)
    } catch (error) {
        throw new LinkError("ISSUER_UNREACHABLE", error instanceof Error ? error.message : "malformed credential")
    }
    // The issuer's own binding check enforces this; a dishonest issuer is not trusted to.
    if (
        parsed.body.programmeHash !== programmeHash(params.approvalScope.programme) ||
        parsed.body.countryCode !== countryCode(params.approvalScope.country)
    ) {
        throw new LinkError("ISSUER_UNREACHABLE", "credential is not for the programme and country consented to")
    }
    const issuerPublicKey: [string, string] = [
        parsed.issuerPublicKey[0].toString(),
        parsed.issuerPublicKey[1].toString()
    ]

    if (!isMemberKey(memberKeyLeaves, issuerPublicKey)) {
        throw new LinkError("ISSUER_NOT_APPROVED", `the credential is not signed by a key of ${params.issuerNetworkId}`)
    }

    // Built above for the hold check; the lists are read before the signature, so this is the
    // only step left that can fail.
    step(CREDENTIAL_ISSUE_STEPS.storing)
    let credentialId: string
    try {
        credentialId = await wallet.addCredential({
            id: issued.value.id,
            credential: issued.value.credential,
            revocationSecret
        })
    } catch (error) {
        throw mapWalletError(error, "ISSUER_UNREACHABLE")
    }

    await writeIssuerEntry(ports.store, params.issuerNetworkId, {
        credentialId,
        issuerPublicKey,
        issuersUrl: params.issuersUrl,
        programme: params.approvalScope.programme,
        country: params.approvalScope.country,
        issuedAt: Math.floor(nowFn(ports) / 1000)
    })

    return { status: "stored", credentialId }
}
