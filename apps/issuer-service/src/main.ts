import { InMemoryResolver, LocalCredentialSigner, NetworkMemberRegistryClient } from "@coordination-network/credential"
import type { DeliverToStealthPorts, SubmitRegistrationPorts } from "@coordination-network/network-member-client"
import {
    GOOGLE_ATTESTATION_ROOTS,
    createAttestationVerifier,
    createStatusListCache,
    type AttestationVerifier
} from "./attestation"
import { loadConfig } from "./config"
import { buildDeliveryPorts, buildSponsoredDeliveryPorts } from "./delivery-ports"
import { buildGovernancePorts } from "./governance-ports"
import { buildChainIssuerSet } from "./issuer-set"
import { buildIdentityReader, buildRegistrationPorts, buildSponsoredRegistrationPorts } from "./registration-ports"
import {
    RevocationBacking,
    buildChainRevocation,
    buildSponsoredRevocation,
    createInMemoryRevocation
} from "./revocation"
import { buildServer } from "./server"
import { memberIssuancePolicy } from "./issuance-policy"

async function main() {
    const config = loadConfig()
    if (!config.rpcUrl || !config.registryAddress || !config.issuance) {
        throw new Error(
            "RPC_URL, REGISTRY_ADDRESS, IDENTITY_REGISTRY_ADDRESS, CHAIN_ID, ISSUANCE_PROGRAMME, and ISSUANCE_COUNTRY are required for credential issuance"
        )
    }
    if (!config.issuerPrivateKey) throw new Error("ISSUER_PRIVATE_KEY is required for credential issuance")
    const signer = new LocalCredentialSigner(config.issuerPrivateKey)

    const resolver = new InMemoryResolver()
    resolver.approveMember(config.issuerNetworkId)

    // The executable always checks the issuer's live membership. Tests may still construct
    // buildServer with an explicit in-memory resolver.
    const approval = new NetworkMemberRegistryClient(config.registryAddress, config.rpcUrl)

    let registration: SubmitRegistrationPorts | undefined
    if (config.registration && config.rpcUrl) {
        const { submitterPrivateKey, sponsored } = config.registration
        if (sponsored) {
            registration = await buildSponsoredRegistrationPorts({ ...config.registration, sponsored }, config.rpcUrl)
        } else if (submitterPrivateKey) {
            console.warn(
                "registrations go out from SUBMITTER_PRIVATE_KEY's address and attribute every enrolled user to this member"
            )
            registration = await buildRegistrationPorts({ ...config.registration, submitterPrivateKey }, config.rpcUrl)
        }
    }

    const identityReader = await buildIdentityReader(
        config.issuance.identityRegistryAddress,
        config.issuance.chainId,
        config.rpcUrl
    )
    const issuancePolicy = memberIssuancePolicy(config.issuance.approvalScope)

    let delivery: DeliverToStealthPorts | undefined
    if (config.delivery && config.rpcUrl) {
        const { memberPrivateKey, sponsored, memberIdentitySecret } = config.delivery
        if (sponsored && memberIdentitySecret) {
            delivery = await buildSponsoredDeliveryPorts(
                { ...config.delivery, sponsored, memberIdentitySecret },
                config.rpcUrl,
                approval
            )
        } else if (memberPrivateKey) {
            console.warn(
                "announcements go out from MEMBER_PRIVATE_KEY's address and attribute every delivery to this member"
            )
            delivery = await buildDeliveryPorts({ ...config.delivery, memberPrivateKey }, config.rpcUrl, approval)
        }
    }

    const governance =
        config.governance && config.rpcUrl ? buildGovernancePorts(config.governance, config.rpcUrl) : undefined

    // Once the on-chain set is wired up, it replaces the in-memory allowlist for both
    // /v1/issuers and /v1/verify, not just the governance routes' own reads and writes.
    const issuerSet =
        config.governance && config.rpcUrl ? buildChainIssuerSet(config.governance.issuerSet, config.rpcUrl) : undefined

    // Also this service's resolver: `/v1/credentials/:id/revoke` and the network's revocation
    // registry are the same revocations, so both read and write through the same mirror. Approval
    // and credential-key lookups keep the plain InMemoryResolver's behaviour either way.
    if (!config.revocation) {
        console.warn("revocations live only in this process and are lost on restart")
    }
    // loadConfig only lets the in-memory fallback through under ALLOW_IN_MEMORY_REVOCATION.
    let revocation: RevocationBacking | undefined
    if (config.revocation && config.rpcUrl) {
        const { memberPrivateKey, sponsored } = config.revocation
        if (sponsored) {
            revocation = await buildSponsoredRevocation({ ...config.revocation, sponsored }, config.rpcUrl, resolver)
        } else if (memberPrivateKey) {
            console.warn(
                "revocations go out from MEMBER_PRIVATE_KEY's address and attribute every revocation to this member"
            )
            revocation = await buildChainRevocation({ ...config.revocation, memberPrivateKey }, config.rpcUrl, resolver)
        }
    }
    revocation ??= createInMemoryRevocation(resolver)

    let deviceAttestation: AttestationVerifier | undefined
    if (config.minDeviceSecurityLevel !== "SOFTWARE") {
        const statusList = createStatusListCache({
            url: config.deviceAttestationStatusUrl,
            maxStaleMs: config.deviceAttestationMaxStalenessSeconds * 1000
        })
        // The fetch times out at 10 s. Every other route serves either way; issuance answers 503
        // until a list arrives.
        if (!(await statusList.start())) {
            console.warn("device attestation status list not loaded; issuance answers 503 until it is")
        }
        deviceAttestation = createAttestationVerifier({ roots: GOOGLE_ATTESTATION_ROOTS, statusList })
    }

    const app = buildServer({
        issuerNetworkId: config.issuerNetworkId,
        signer,
        resolver: revocation,
        approval,
        challengesPerMinute: config.challengesPerMinute,
        issuancesPerMinute: config.issuancesPerMinute,
        minDeviceSecurityLevel: config.minDeviceSecurityLevel,
        deviceAttestation,
        identityReader,
        issuancePolicy,
        registration,
        registrationsPerMinute: config.registrationsPerMinute,
        delivery,
        deliveriesPerMinute: config.deliveriesPerMinute,
        revocationsPerMinute: config.revocationsPerMinute,
        governance,
        revocation,
        issuerSet,
        issuerPublicKeys: config.issuerPublicKeys,
        credentialCircuitPath: config.credentialCircuitPath,
        verifyMaxSkewSeconds: config.verifyMaxSkewSeconds,
        verifierAudience: config.verifierAudience,
        presentationRequestTtlSeconds: config.presentationRequestTtlSeconds,
        verificationRecordTtlSeconds: config.verificationRecordTtlSeconds,
        allowedOrigins: config.allowedOrigins,
        memberServerToken: config.memberServerToken
    })
    app.listen(config.port, () => {
        console.info(`issuer-service listening on :${config.port} as ${config.issuerNetworkId}`)
    })
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
