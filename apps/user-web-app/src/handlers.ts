import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"
import { buildDeviceBindingMessage, signAccountBinding } from "@coordination-network/identity"
import {
    deriveRevocationCommitment,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    parseZkCredential,
    programmeHash,
    countryCode,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    type SerializedZkCredential
} from "@coordination-network/credential"
import { buildRegistrationRequest } from "@coordination-network/user-client"
import { LinkError, type LinkHandlers } from "@coordination-network/user-app-link"
import { Wallet, type Store, type ChainStateLoader, type WalletChainState } from "@coordination-network/wallet"
import { memberChainStateLoader } from "./chain-state"
import type { BrowserIdentity } from "./identity"

const credentialKey = (issuer: string) => `app:credential:${issuer.toLowerCase()}`
const credentialMetaKey = (issuer: string) => `app:credential-meta:${issuer.toLowerCase()}`
export interface HandlerOptions {
    identity: BrowserIdentity
    serverUrlFor: (issuer: string) => string | undefined
    walletFor: (member: string, loadChainState?: ChainStateLoader) => Wallet
    store: Store
    onPresentationShared?: () => void
}

export function createUserHandlers({
    identity,
    serverUrlFor,
    walletFor,
    store,
    onPresentationShared
}: HandlerOptions): LinkHandlers {
    return {
        "registration.sign": async (params) => {
            const request = buildRegistrationRequest(identity.keys, params)
            await store.set(`app:registration:${params.chainId}:${params.verifyingContract.toLowerCase()}`, "signed")
            return { request, securityLevel: "SOFTWARE" }
        },
        "credential.issue": async (params) => {
            const serverUrl = serverUrlFor(params.issuerNetworkId)
            if (!serverUrl) throw new LinkError("INVALID_REQUEST", "unknown issuer")
            const origin = new URL(serverUrl).origin
            for (const endpoint of [
                params.challengeUrl,
                params.credentialsUrl,
                params.issuersUrl,
                params.revocationsUrl
            ]) {
                if (new URL(endpoint).origin !== origin) {
                    throw new LinkError("INVALID_REQUEST", "endpoint origin does not match the configured issuer")
                }
            }
            const load = memberChainStateLoader(serverUrl)
            let snapshot: Promise<WalletChainState> | undefined
            const loadSnapshot = () => (snapshot ??= load())
            const wallet = walletFor(params.issuerNetworkId, loadSnapshot)
            const state = await loadSnapshot()
            if (
                state.approvedIssuers.root !== state.approvedIssuerRoot ||
                state.revocations.root !== state.revocationRoot
            ) {
                throw new LinkError("ISSUER_UNREACHABLE", "issuer trees do not match their roots")
            }
            const response = await fetch(params.challengeUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ subjectNetworkId: identity.keys.networkId })
            })
            if (!response.ok) throw new LinkError("ISSUER_UNREACHABLE", "issuer challenge is unavailable")
            const challenge = (await response.json()) as { challengeId: string; nonce: string }
            const nonce = hexToBytes(challenge.nonce.replace(/^0x/, ""))
            const revocationSecret = randomBytes(32)
            const revocationCommitment = deriveRevocationCommitment(revocationSecret)
            const confirmationKey = await identity.deviceSigner.getPublicKeyJwk()
            const ownership = signCommitmentOwnership(revocationSecret, nonce)
            const holderOwnership = signHolderKeyOwnership(identity.identitySeed, nonce)
            const deviceBindingMessage = buildDeviceBindingMessage(
                nonce,
                identity.keys.networkId,
                hexToBytes(identity.identityCommitment.toString(16).padStart(64, "0")),
                issuanceRequestCommitment(params.issuerNetworkId, params.approvalScope)
            )
            const binding = {
                accountPublicKey: identity.keys.account.uncompressedPublicKey,
                confirmationKey,
                devicePopSignature: `0x${bytesToHex(await identity.deviceSigner.sign(deviceBindingMessage))}`,
                accountPopSignature: signAccountBinding(
                    identity.keys.account.privateKey,
                    nonce,
                    jwkToPublicKeyBytes(confirmationKey)
                ).signature,
                identityPublicKey: identity.identityPublicKey,
                identityOwnershipSignature: {
                    R8: holderOwnership.signature.R8.map(String) as [string, string],
                    S: holderOwnership.signature.S.toString()
                },
                revocation: {
                    commitment: revocationCommitment.toString(),
                    publicKey: ownership.publicKey.map(String) as [string, string],
                    ownershipSignature: {
                        R8: ownership.signature.R8.map(String) as [string, string],
                        S: ownership.signature.S.toString()
                    }
                }
            }
            const issued = await fetch(params.credentialsUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    challengeId: challenge.challengeId,
                    subjectNetworkId: identity.keys.networkId,
                    approvalScope: params.approvalScope,
                    ...binding
                })
            })
            const body = (await issued.json()) as {
                id: string
                credential: SerializedZkCredential
                code?: string
                error?: string
            }
            if (!issued.ok)
                return {
                    status: "refused",
                    code: body.code ?? "ISSUANCE_REFUSED",
                    message: body.error ?? "issuance refused"
                }
            const credential = parseZkCredential(body.credential)
            if (
                credential.body.programmeHash !== programmeHash(params.approvalScope.programme) ||
                credential.body.countryCode !== countryCode(params.approvalScope.country)
            ) {
                throw new LinkError("ISSUER_UNREACHABLE", "credential scope does not match consent")
            }
            await wallet.addCredential({ id: body.id, credential: body.credential, revocationSecret })
            await store.set(credentialKey(params.issuerNetworkId), body.id)
            await store.set(
                credentialMetaKey(params.issuerNetworkId),
                JSON.stringify({ id: body.id, ...params.approvalScope })
            )
            return { status: "stored", credentialId: body.id }
        },
        "presentation.create": async (params) => {
            let selected: { wallet: Wallet; id: string } | undefined
            const load = memberChainStateLoader(new URL(params.issuersUrl).origin)
            const state = await load()
            // Each local issuer store is checked against the verifier's shared network tree.
            for (const key of await store.list()) {
                if (!key.startsWith("app:credential:")) continue
                const issuer = key.slice("app:credential:".length)
                const raw = await store.get(credentialMetaKey(issuer))
                const metadata = raw ? (JSON.parse(raw) as { id: string; programme: string; country: string }) : null
                if (!metadata || metadata.programme !== params.programme || metadata.country !== params.country)
                    continue
                const wallet = walletFor(issuer)
                await wallet.syncCredential(metadata.id, async () => state)
                if ((await wallet.getCredential(metadata.id))?.status === "valid") {
                    selected = { wallet, id: metadata.id }
                    break
                }
            }
            if (!selected) throw new LinkError("NO_CREDENTIAL", "no valid credential matches the requested scope")
            let proof
            try {
                proof = await selected.wallet.present(
                    selected.id,
                    { ...params, challenge: hexToBytes(params.challenge.slice(2)) },
                    async () => state
                )
            } catch (error) {
                throw new LinkError("PROOF_FAILED", error instanceof Error ? error.message : "proof generation failed")
            }
            const response = await fetch(params.responseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    requestId: params.requestId,
                    proof: `0x${bytesToHex(proof.proof)}`,
                    publicInputs: proof.publicInputs
                })
            })
            if (!response.ok) throw new LinkError("VERIFIER_UNREACHABLE", "verifier is unavailable")
            const result = (await response.json()) as { verificationId: string }
            if (!result.verificationId) throw new LinkError("VERIFIER_UNREACHABLE", "verifier returned no record")
            onPresentationShared?.()
            return { verificationId: result.verificationId }
        }
    }
}
