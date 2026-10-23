import { rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Server as HttpServer } from "node:http"
import qrcodeTerminal from "qrcode-terminal"
import {
    Address,
    createPublicClient,
    getAddress,
    Hex,
    http,
    isAddressEqual,
    parseAbi,
    parseEther,
    parseEventLogs,
    PublicClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import {
    deriveRevocationCommitment,
    generateRevocationSecret,
    Hex32,
    InMemoryResolver,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    LocalP256Signer,
    signCommitmentOwnership,
    signHolderKeyOwnership
} from "@coordination-network/credential"
import {
    buildDeviceBindingMessage,
    deriveEddsaKeypair,
    eddsaPeerPointBytes,
    signAccountBinding
} from "@coordination-network/identity"
import { governanceThreshold, type SafeVersion } from "@coordination-network/network-member-governance"
import { buildRegistrationRequest, ChainDomain, DerivedKeys, onboard } from "@coordination-network/user-client"
import { ActivityLog } from "../../issuer-service/src/activity"
import {
    AttestationVerifier,
    GOOGLE_ATTESTATION_ROOTS,
    createAttestationVerifier,
    createStatusListCache
} from "../../issuer-service/src/attestation"
import { DEFAULT_DEVICE_ATTESTATION_STATUS_URL } from "../../issuer-service/src/config"
import { buildSponsoredDeliveryPorts } from "../../issuer-service/src/delivery-ports"
import { GovernancePorts, buildGovernancePorts } from "../../issuer-service/src/governance-ports"
import { IssuerSetBacking, buildChainIssuerSet } from "../../issuer-service/src/issuer-set"
import { memberIssuancePolicy } from "../../issuer-service/src/issuance-policy"
import { buildSponsoredRegistrationPorts } from "../../issuer-service/src/registration-ports"
import { buildSponsoredRevocation } from "../../issuer-service/src/revocation"
import { MINIMUM_DEVICE_SECURITY_LEVELS, MinimumDeviceSecurityLevel } from "../../issuer-service/src/security-level"
import { buildServer } from "../../issuer-service/src/server"
import { Chain, DedicatedAnvil, optionalEnvironmentVariable, startDedicatedAnvil } from "./anvil"
import { Bundler, startBundler } from "./bundler"
import { createDashboardGatherer, Dashboard, FLOW_TITLES, StackActivityLog, startDashboard } from "./dashboard"
import {
    deployCredentialRevocationRegistry,
    seedCredentialRevocationRegistry,
    deployRevocationRegistry,
    deployStealthContracts,
    type ContractDeployment
} from "./deployer"
import { deployGovernanceStack, GovernanceFounder } from "./governance-deployer"
import { deployIdentityRegistry, deploySemaphore } from "./identity-deployer"
import {
    buildMember,
    buildMembers,
    deriveCredentialSigner,
    deriveMemberSigningKeys,
    lanAddress,
    type Brand,
    type Member,
    type MemberRole,
    MEMBER_PORTS,
    MEMBER_PROFILES,
    memberSecrets,
    portFromEnvironment,
    STACK_PORT,
    validateStackSettings
} from "./members"
import { runGenesis } from "./genesis"
import { OperatorError } from "./operator-error"
import { mirrorMembersIntoPaymaster } from "./paymaster-group"
import { describeError } from "./redact-urls"
import { RpcProxy, startRpcProxy } from "./rpc-proxy"
import { preflight, publicRpcOverride, readPaymasterDeposit, resolveTestnetStack } from "./testnet-stack"
import {
    buildStackSecrets,
    dashboardHeaders,
    memberServerHeaders,
    pairingUrl,
    StackSecrets,
    writeStackSecrets
} from "./stack-secrets"

export {
    buildMember,
    buildMembers,
    deriveCredentialSigner,
    deriveMemberSigningKeys,
    lanAddress,
    memberSecrets,
    MEMBER_PORTS,
    MEMBER_PROFILES,
    portFromEnvironment,
    STACK_PORT,
    validateStackSettings
}
export type { Brand, Member, MemberRole }

const CHECK_ADMISSION_FLAG = process.argv.includes("--check-admission")
const CHECK_MODE = process.argv.includes("--check") || CHECK_ADMISSION_FLAG
const GENESIS_MODE = process.argv.includes("--genesis")
const WEB_DEMO_MODE = process.argv.includes("--demo")
const TESTNET_MODE = process.env.TESTBED_MODE === "testnet"
/** A deployed network confirms a block in seconds and a provider can trail the head, so `--check` waits longer there. */
const CHECK_TIMEOUT_MS = TESTNET_MODE ? 180_000 : 20_000
const STACK_BUNDLER_PORT = portFromEnvironment("STACK_BUNDLER_PORT", 4337)
const STACK_DASHBOARD_PORT = portFromEnvironment("STACK_DASHBOARD_PORT", 8080)
const STACK_FILE = join(__dirname, "..", "stack.json")

/** Read when needed rather than at load, so a bad value is an operator error and not a failed import. */
function minDeviceSecurityLevel(): MinimumDeviceSecurityLevel {
    const setting = optionalEnvironmentVariable("STACK_MIN_DEVICE_SECURITY_LEVEL") ?? "SOFTWARE"
    const parsed = z.enum(MINIMUM_DEVICE_SECURITY_LEVELS).safeParse(setting)
    if (!parsed.success) {
        throw new OperatorError(
            `STACK_MIN_DEVICE_SECURITY_LEVEL must be one of ${MINIMUM_DEVICE_SECURITY_LEVELS.join(", ")}, got "${setting}"`
        )
    }
    return parsed.data
}

let sharedDeviceAttestation: Promise<AttestationVerifier> | undefined

/** One verifier and status list for all three servers; undefined at SOFTWARE, where nothing is fetched. */
function deviceAttestationVerifier(): Promise<AttestationVerifier> | undefined {
    if (minDeviceSecurityLevel() === "SOFTWARE") return undefined
    sharedDeviceAttestation ??= (async () => {
        const statusList = createStatusListCache({ url: DEFAULT_DEVICE_ATTESTATION_STATUS_URL })
        if (!(await statusList.start())) {
            console.warn("device attestation status list not loaded; issuance answers 503 until it is")
        }
        return createAttestationVerifier({ roots: GOOGLE_ATTESTATION_ROOTS, statusList })
    })()
    return sharedDeviceAttestation
}

/** The `IdentityRegistry.identity` fragment `--check` reads to prove the registry is reachable. */
const IDENTITY_REGISTRY_ABI = [
    {
        type: "function",
        name: "identity",
        stateMutability: "view",
        inputs: [{ name: "networkId", type: "bytes32" }],
        outputs: [{ type: "bytes" }]
    }
] as const

/** The ERC-5564 event `--check` reads the delivery's `caller` from. */
const ANNOUNCEMENT_EVENT_ABI = parseAbi([
    "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)"
])

/** The Safe fragments `--check` and the dashboard both read; shared so the two copies can't drift. */
export const SAFE_READ_ABI = [
    { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
    { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

/** The `NetworkMemberRegistry` fragment `--check` reads to confirm which orgs are approved. */
const NETWORK_MEMBER_REGISTRY_CHECK_ABI = [
    {
        type: "function",
        name: "isApproved",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "bool" }]
    }
] as const

/** Shared by `NetworkMemberGroup` and `SemaphorePaymaster`, both of which own exactly one group. */
const GROUP_ID_ABI = [
    { type: "function", name: "GROUP_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

/** Semaphore's own group-size read, shared by the approved-member group and the paymaster's group. */
const SEMAPHORE_GROUP_SIZE_ABI = [
    {
        type: "function",
        name: "getMerkleTreeSize",
        stateMutability: "view",
        inputs: [{ name: "groupId", type: "uint256" }],
        outputs: [{ type: "uint256" }]
    }
] as const

/** The `ApprovedIssuerSet` fragment `--check` reads to confirm the founder published a key. */
const ISSUER_SET_CHECK_ABI = [
    {
        type: "function",
        name: "issuerKeysOf",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "uint256[]" }]
    }
] as const

function diagnostic(message: string): void {
    process.stdout.write(`${message}\n`)
}

/** One JSON-RPC call against the stack's own bundler, for `--check` to prove it answers. */
async function callBundler(bundlerUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch(bundlerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
    const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } }
    if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
    return body.result
}

/** The issuance route allows 30 requests a minute per server, so a faster poll would be answered 429. */
const ENROLMENT_POLL_MS = 2_500

/** Enrols a fresh subject through a member's sponsored registration route, the way the phones do,
 *  so the issuer finds it in the identity registry. Returns the subject's keys. */
async function enrolSubject(member: StackMember, secrets: StackSecrets, domain: ChainDomain): Promise<DerivedKeys> {
    const { keys } = onboard(randomBytes(32))
    const response = await fetch(`${member.serverUrl}/v1/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, member) },
        body: JSON.stringify(buildRegistrationRequest(keys, domain))
    })
    if (response.status !== 201) {
        throw new Error(`enrolling a subject through ${member.name} returned ${response.status}`)
    }
    return keys
}

/** Issues one credential to an enrolled subject through an org's own challenge and credentials
 *  routes, the holder-side dance a wallet runs, so `--check` has a credential to revoke. Retries
 *  with the same challenge while the issuer has not yet seen the enrolment. Returns its id. */
async function issueCredential(serverUrl: string, issuerNetworkId: Hex32, subject: DerivedKeys): Promise<string> {
    const approvalScope = { programme: "demo-programme", country: "ZZZ" }
    const devicePrivateKey = randomBytes(32)
    const accountPrivateKey = hexToBytes(subject.account.privateKey.slice(2))
    const deviceSigner = new LocalP256Signer(devicePrivateKey)
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const subjectNetworkId = subject.networkId
    const holder = deriveEddsaKeypair(p256.getSharedSecret(devicePrivateKey, eddsaPeerPointBytes()).slice(1, 33))
    const revocationSecret = generateRevocationSecret()

    const challenge = await fetch(`${serverUrl}/v1/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectNetworkId })
    })
    const { challengeId, nonce: nonceHex } = (await challenge.json()) as { challengeId: string; nonce: string }
    const nonce = hexToBytes(nonceHex)
    const ownership = signCommitmentOwnership(revocationSecret, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

    const body = JSON.stringify({
        challengeId,
        subjectNetworkId,
        approvalScope,
        confirmationKey,
        accountPublicKey: bytesToHex(secp256k1.getPublicKey(accountPrivateKey, true)),
        devicePopSignature: bytesToHex(
            await deviceSigner.sign(
                buildDeviceBindingMessage(
                    nonce,
                    subjectNetworkId,
                    hexToBytes(holder.commitment.toString(16).padStart(64, "0")),
                    issuanceRequestCommitment(issuerNetworkId, approvalScope)
                )
            )
        ),
        accountPopSignature: signAccountBinding(
            accountPrivateKey,
            nonce,
            jwkToPublicKeyBytes(confirmationKey)
        ).signature.slice(2),
        identityPublicKey: holder.publicKey.map(String),
        identityOwnershipSignature: {
            R8: holderOwnership.signature.R8.map(String),
            S: holderOwnership.signature.S.toString()
        },
        revocation: {
            commitment: deriveRevocationCommitment(revocationSecret).toString(),
            publicKey: ownership.publicKey.map(String),
            ownershipSignature: { R8: ownership.signature.R8.map(String), S: ownership.signature.S.toString() }
        }
    })

    // While the issuer's registry read lags the enrolment, it answers 409 and the same challenge is retried.
    const deadline = Date.now() + CHECK_TIMEOUT_MS
    let status: number
    let text: string
    for (;;) {
        const response = await fetch(`${serverUrl}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
        })
        status = response.status
        text = await response.text()
        const enrolmentPending =
            status === 409 && (JSON.parse(text) as { code?: string }).code === "SUBJECT_ENROLMENT_PENDING"
        if (!enrolmentPending || Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, ENROLMENT_POLL_MS))
    }
    if (status !== 201) throw new Error(`issuance through ${serverUrl} returned ${status}: ${text}`)
    return (JSON.parse(text) as { id: string }).id
}

/**
 * Polls `read` until `isReady` accepts its result. A read or a predicate that throws counts as not ready yet, since
 * a status page can answer a transient non-200 and a provider can answer 429 through the proxy.
 * Once `timeoutMs` has elapsed it throws an error naming the last value and the last error.
 * `--check` uses it for the reads that follow an on-chain write, where a server or the provider
 * may still be a block or two behind.
 */
export async function pollUntil<T>(
    read: () => Promise<T>,
    isReady: (value: T) => boolean,
    timeoutMs: number,
    intervalMs = 250
): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let last: { value: T } | undefined
    let lastError: { error: unknown } | undefined
    for (;;) {
        try {
            const value = await read()
            last = { value }
            if (isReady(value)) return value
        } catch (error) {
            lastError = { error }
        }
        if (Date.now() >= deadline) {
            if (!last && lastError) throw lastError.error
            const parts: string[] = []
            if (last)
                parts.push(`last value: ${typeof last.value === "object" ? JSON.stringify(last.value) : last.value}`)
            if (lastError) {
                const { error } = lastError
                parts.push(`last error: ${error instanceof Error ? error.message : String(error)}`)
            }
            throw new Error(`condition not met within ${timeoutMs}ms (${parts.join("; ")})`)
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
}

/** Fetches `url` and parses its JSON body, throwing on a non-2xx status so `pollUntil` retries it: an
 *  error body such as `{"error":"internal error"}` must never be read as an answer. */
export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}`)
    return (await response.json()) as T
}

/** Ready once a revocation snapshot carries a root other than `previous`. */
export const rootMovedFrom =
    (previous: string) =>
    (snapshot: { root?: string }): boolean =>
        typeof snapshot.root === "string" && snapshot.root !== previous

const pollCheck = <T>(read: () => Promise<T>, isReady: (value: T) => boolean) =>
    pollUntil(read, isReady, CHECK_TIMEOUT_MS)

/**
 * Whether `--check` plays the admission story. A local chain is rebuilt each run, so it always does.
 * A deployed one admits the candidate once, so it does so only when asked and only while the
 * candidate is still outside. A run cut short after the request resumes at the approvals.
 */
export function admissionPlan({
    testnet,
    requested,
    candidateApproved,
    requestPending
}: {
    testnet: boolean
    requested: boolean
    candidateApproved: boolean
    requestPending: boolean
}): { run: true; resumeAtApprovals: boolean } | { run: false; reason: string } {
    if (!testnet) return { run: true, resumeAtApprovals: false }
    if (!requested) return { run: false, reason: "admission story skipped: pass --check-admission to play it" }
    if (candidateApproved) {
        return {
            run: false,
            reason: "admission story skipped: the candidate is already approved, and the story runs once per deployment"
        }
    }
    return { run: true, resumeAtApprovals: requestPending }
}

/** Why the story cannot run when the founders' seats cannot reach the Safe's threshold, if they cannot. */
export function admissionSeatShortfall(
    founderSigners: readonly Address[],
    owners: readonly Address[],
    threshold: number
): string | undefined {
    const seats = new Set(
        founderSigners.filter((signer) => owners.some((owner) => isAddressEqual(owner, signer))).map(getAddress)
    ).size
    return seats < threshold
        ? `the founders own ${seats} of the ${threshold} approvals the Safe needs; the Safe's other owners must approve, so the admission story cannot run`
        : undefined
}

/** What `POST /v1/governance/admissions` answers with once the request is a real candidate's. */
interface AdmissionResult {
    status: string
    approvals: number
    threshold: number
    message: string
}

/** One org's click of its own Admit button, as `--check` makes it — through the dashboard's own
 *  proxy, the same path the real Admit button posts to; no client ever reaches an org server
 *  directly. */
async function admit(
    dashboardUrl: string,
    secrets: StackSecrets,
    approverIndex: number,
    networkId: Hex32
): Promise<AdmissionResult> {
    const response = await fetch(`${dashboardUrl}/api/orgs/${approverIndex}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json", ...dashboardHeaders(secrets) },
        body: JSON.stringify({ networkId })
    })
    if (response.status !== 200) {
        throw new Error(`admission at org index ${approverIndex} returned ${response.status}`)
    }
    return (await response.json()) as AdmissionResult
}

/** Whether `approver`'s server lists a join request from `candidate` that is not yet admitted. */
async function hasPendingRequest(
    approver: StackMember,
    secrets: StackSecrets,
    candidate: StackMember
): Promise<boolean> {
    // Polled for an answer, not for a request: a server that is still catching up may refuse the read.
    const pending = await pollCheck(
        () =>
            readJson<{ requests: { memberNetworkId: string }[] }>(`${approver.serverUrl}/v1/governance/requests`, {
                headers: memberServerHeaders(secrets, approver)
            }),
        () => true
    )
    return pending.requests.some((request) => request.memberNetworkId === candidate.networkId)
}

/** The dashboard's "Network setup" counts, which `--check` reads before and after the admission. */
async function readDashboardNetworkSetup(
    dashboardUrl: string
): Promise<{ membersAdmitted: number; membersTotal: number }> {
    const response = await fetch(`${dashboardUrl}/api/state`)
    if (response.status !== 200) throw new Error(`${dashboardUrl}/api/state returned ${response.status}`)
    const { networkSetup } = (await response.json()) as {
        networkSetup: { membersAdmitted: number; membersTotal: number }
    }
    return networkSetup
}

export interface StackMember {
    name: string
    networkId: Hex32
    serverUrl: string
    authAddress: Address
    governanceSigner: Address
    role: MemberRole
    brand: Brand
    /** The org app's own deep-link scheme; absent for the server-only candidate. */
    scheme?: string
}

export interface StackDescriptor {
    rpcUrl: string
    chainId: number
    identityRegistry: Address
    announcer: Address
    revocation: { address: Address; registry: Address; registryId: string }
    semaphore: Address
    networkMemberRegistry: Address
    networkMemberGroup: Address
    networkMemberGovernance: Address
    approvedIssuerSet: Address
    governanceSafe: Address
    entryPoint: Address
    paymaster: Address
    accountImplementation: Address
    bundlerUrl: string
    dashboardUrl: string
    members: StackMember[]
}

/** The addresses `buildStackDescriptor` shapes into `stack.json`, named the way that file names them. */
export interface StackAddresses {
    identityRegistry: Address
    announcer: Address
    revocation: Address
    credentialRevocationRegistry: Address
    credentialRevocationRegistryId: bigint
    semaphore: Address
    networkMemberRegistry: Address
    networkMemberGroup: Address
    networkMemberGovernance: Address
    approvedIssuerSet: Address
    governanceSafe: Address
    entryPoint: Address
    paymaster: Address
    accountImplementation: Address
}

/** Shapes the descriptor `stack.json` writes and the QR encodes, from what each deploy step returned. */
export function buildStackDescriptor(
    host: string,
    { rpcUrl, chainId }: { rpcUrl: string; chainId: number },
    addresses: StackAddresses,
    members: Member[]
): StackDescriptor {
    return {
        rpcUrl,
        chainId,
        identityRegistry: addresses.identityRegistry,
        announcer: addresses.announcer,
        revocation: {
            address: addresses.revocation,
            registry: addresses.credentialRevocationRegistry,
            registryId: addresses.credentialRevocationRegistryId.toString()
        },
        semaphore: addresses.semaphore,
        networkMemberRegistry: addresses.networkMemberRegistry,
        networkMemberGroup: addresses.networkMemberGroup,
        networkMemberGovernance: addresses.networkMemberGovernance,
        approvedIssuerSet: addresses.approvedIssuerSet,
        governanceSafe: addresses.governanceSafe,
        entryPoint: addresses.entryPoint,
        paymaster: addresses.paymaster,
        accountImplementation: addresses.accountImplementation,
        bundlerUrl: `http://${host}:${STACK_BUNDLER_PORT}`,
        dashboardUrl: `http://${host}:${STACK_DASHBOARD_PORT}`,
        members: members.map((member) => ({
            name: member.name,
            networkId: member.networkId,
            serverUrl: `http://${host}:${member.port}`,
            authAddress: member.authAddress,
            governanceSigner: member.governanceSignerAddress,
            role: member.role,
            brand: member.brand,
            scheme: member.scheme
        }))
    }
}

async function fundMember(anvil: DedicatedAnvil, address: Address): Promise<void> {
    const hash = await anvil.walletClient.sendTransaction({
        account: anvil.deployer,
        chain: anvil.chainDefinition,
        to: address,
        value: parseEther("10")
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash })
}

interface StartMemberServerOptions {
    member: Member
    otherMembers: Member[]
    rpcUrl: string
    addresses: StackAddresses
    chainId: number
    /** The block the governance contracts were deployed at: every event read starts here. */
    deployBlock: bigint
    safeVersion: SafeVersion
    /** Set for a local chain, whose Safe is deployed with its own `MultiSendCallOnly`; a public chain
     *  leaves it to the SDK's canonical address. */
    multiSend?: Address
    /** The provider's `eth_getLogs` block-range cap, when it has one. */
    logWindowBlocks?: number
    /** Blocks a governance event is buried under before the server acts on it. */
    logConfirmations?: number
    issuerSetBacking: IssuerSetBacking
    bundlerUrl: string
    host: string
    /** The interface the server binds; every one when absent. */
    listenHost?: string
    dashboardUrl: string
}

export function webDemoOrigins(host: string, memberPort: number): string[] {
    return [
        ...new Set(
            [host, "127.0.0.1", "localhost"].flatMap((address) =>
                [memberPort, 4173, 4174, 4175, 4176].map((port) => `http://${address}:${port}`)
            )
        )
    ]
}

async function startMemberServer({
    member,
    otherMembers,
    rpcUrl,
    addresses,
    chainId,
    deployBlock,
    safeVersion,
    multiSend,
    logWindowBlocks,
    logConfirmations,
    issuerSetBacking,
    bundlerUrl,
    host,
    listenHost,
    dashboardUrl
}: StartMemberServerOptions): Promise<HttpServer> {
    const resolver = new InMemoryResolver()
    resolver.approveMember(member.networkId)

    const sponsored = {
        memberSecret: `0x${bytesToHex(member.semaphoreSecret)}` as Hex,
        entryPoint: addresses.entryPoint,
        paymaster: addresses.paymaster,
        accountImplementation: addresses.accountImplementation,
        bundlerUrl,
        paymasterGroupFromBlock: Number(deployBlock),
        logWindowBlocks
    }
    const registration = await buildSponsoredRegistrationPorts(
        {
            identityRegistryAddress: addresses.identityRegistry,
            chainId,
            memberIdentitySecret: member.semaphoreSecret,
            memberGroupFromBlock: Number(deployBlock),
            logWindowBlocks,
            sponsored
        },
        rpcUrl
    )
    const delivery = await buildSponsoredDeliveryPorts(
        {
            identityRegistryAddress: addresses.identityRegistry,
            chainId,
            announcerAddress: addresses.announcer,
            memberIdentitySecret: member.semaphoreSecret,
            sponsored
        },
        rpcUrl,
        resolver
    )
    // Sponsored, like registration: the registry reads no `msg.sender`, so relaying each revoke
    // through a fresh disposable sender leaves nothing on chain saying which org revoked what.
    const revocationBacking = await buildSponsoredRevocation(
        {
            address: addresses.credentialRevocationRegistry,
            memberIdentitySecret: member.semaphoreSecret,
            memberGroupFromBlock: Number(deployBlock),
            logWindowBlocks,
            sponsored
        },
        rpcUrl,
        resolver
    )
    const governancePorts: GovernancePorts = buildGovernancePorts(
        {
            authPrivateKey: member.authPrivateKey,
            governanceSignerPrivateKey: member.governanceSignerPrivateKey,
            networkId: member.networkId,
            semaphoreCommitment: member.semaphoreCommitment,
            metaStealthAddress: member.metaStealthAddress,
            registry: addresses.networkMemberRegistry,
            group: addresses.networkMemberGroup,
            governance: addresses.networkMemberGovernance,
            safe: addresses.governanceSafe,
            issuerSet: addresses.approvedIssuerSet,
            multiSend,
            deployBlock: Number(deployBlock),
            logWindowBlocks,
            logConfirmations,
            metadataURI: `http://${host}:${member.port}`,
            safeVersion,
            chainId
        },
        rpcUrl
    )
    const otherKeys = await Promise.all(otherMembers.map((other) => other.signer.getPublicKey()))
    const issuancePolicy = memberIssuancePolicy({ programme: "demo-programme", country: "ZZZ" })

    const app = buildServer({
        issuerNetworkId: member.networkId,
        signer: member.signer,
        resolver: revocationBacking,
        minDeviceSecurityLevel: minDeviceSecurityLevel(),
        deviceAttestation: await deviceAttestationVerifier(),
        registration,
        identityReader: registration.identityReader,
        issuancePolicy,
        delivery,
        revocation: revocationBacking,
        governance: governancePorts,
        issuerSet: issuerSetBacking,
        issuerPublicKeys: otherKeys,
        activityLog: new ActivityLog(),
        displayName: member.name,
        dashboardUrl,
        peers: otherMembers.map((other) => ({ name: other.name, url: `http://${host}:${other.port}` })),
        accent: member.brand.accent,
        memberServerToken: member.memberServerToken,
        allowedOrigins: WEB_DEMO_MODE ? webDemoOrigins(host, member.port) : []
    })

    return new Promise((resolve, reject) => {
        const onListening = () => resolve(listener)
        const listener =
            listenHost === undefined
                ? app.listen(member.port, onListening)
                : app.listen(member.port, listenHost, onListening)
        listener.once("error", reject)
    })
}

interface AdmissionCheck {
    stack: StackDescriptor
    secrets: StackSecrets
    publicClient: PublicClient
    founders: StackMember[]
    candidate: StackMember
    groupId: bigint
    paymasterGroupId: bigint
    groupSizeBefore: bigint
    paymasterSizeBefore: bigint
    /** The Safe's approvals threshold, which the governance rule gives for its current owners. */
    safeThreshold: number
    domain: ChainDomain
    /** The candidate's request is already on chain, from a run that stopped before the approvals. */
    resumeAtApprovals: boolean
}

/** The admission story: the candidate asks to join, both founders admit it, and it registers, publishes
 *  a key and relays a sponsored registration as a member. */
async function checkAdmission({
    stack,
    secrets,
    publicClient,
    founders,
    candidate,
    groupId,
    paymasterGroupId,
    groupSizeBefore,
    paymasterSizeBefore,
    safeThreshold,
    domain,
    resumeAtApprovals
}: AdmissionCheck): Promise<void> {
    const [founder, otherFounder] = founders
    // The dashboard's own proxy routes address an org by its position in stack.members, the same
    // index the real Admit/Register/Publish buttons post to.
    const founderIndex = stack.members.indexOf(founder)
    const otherFounderIndex = stack.members.indexOf(otherFounder)
    const candidateIndex = stack.members.indexOf(candidate)

    // Live admission: the candidate asks to join, and it takes both founders to let it in, since
    // the Safe sits at its governance threshold. The paymaster's own group then mirrors the admission
    // off the member group's logs (paymaster-group.ts).

    if (resumeAtApprovals) {
        diagnostic(`${candidate.name}: request already on chain, resuming at the approvals`)
    } else {
        // The Membership panel renders server-side from the same standing the routes below change, so
        // its own request-to-join button should already be there before the candidate uses the route.
        const candidateStatusBeforeJoining = await fetch(`${candidate.serverUrl}/`)
        if (candidateStatusBeforeJoining.status !== 200) {
            throw new Error(`${candidate.serverUrl}/ returned ${candidateStatusBeforeJoining.status}`)
        }
        const candidateStatusBeforeJoiningHtml = await candidateStatusBeforeJoining.text()
        if (!candidateStatusBeforeJoiningHtml.includes('data-action="request-to-join"')) {
            throw new Error(`expected ${candidate.name}'s status page to offer request-to-join before it joined`)
        }
        diagnostic(`${candidate.name}: status page offers request-to-join`)

        const candidateRequestResponse = await fetch(
            `${stack.dashboardUrl}/api/orgs/${candidateIndex}/request-to-join`,
            {
                method: "POST",
                headers: { "content-type": "application/json", ...dashboardHeaders(secrets) }
            }
        )
        if (candidateRequestResponse.status !== 201) {
            throw new Error(`membership request through the dashboard returned ${candidateRequestResponse.status}`)
        }
        diagnostic(`${candidate.name}: requested to join the network, through the dashboard`)
    }

    // A member server reads governance events only once they are `logConfirmations` blocks deep, so
    // on a deployed chain the request shows up a few blocks after it landed.
    for (const approver of founders) {
        const candidateRequests = await pollCheck(
            async () => {
                const pendingRequests = await readJson<{ requests: { memberNetworkId: string }[] }>(
                    `${approver.serverUrl}/v1/governance/requests`,
                    { headers: memberServerHeaders(secrets, approver) }
                )
                return pendingRequests.requests.filter((request) => request.memberNetworkId === candidate.networkId)
            },
            (requests) => requests.length > 0
        )
        if (candidateRequests.length !== 1) {
            throw new Error(
                `expected ${approver.name} to list ${candidate.name}'s request once, got ${candidateRequests.length}`
            )
        }
        diagnostic(`${approver.name}: sees ${candidate.name}'s pending join request`)
    }

    const founderAdmit = await admit(stack.dashboardUrl, secrets, founderIndex, candidate.networkId)
    if (
        founderAdmit.status !== "awaitingApprovals" ||
        founderAdmit.approvals !== 1 ||
        founderAdmit.threshold !== safeThreshold
    ) {
        throw new Error(
            `expected ${founder.name}'s admission to wait at 1 of ${safeThreshold}, got ${JSON.stringify(founderAdmit)}`
        )
    }
    diagnostic(`${founder.name}: ${founderAdmit.message}`)

    const notYetApproved = await publicClient.readContract({
        address: stack.networkMemberRegistry,
        abi: NETWORK_MEMBER_REGISTRY_CHECK_ABI,
        functionName: "isApproved",
        args: [candidate.networkId]
    })
    if (notYetApproved) throw new Error(`${candidate.name} was admitted on one approval, at threshold ${safeThreshold}`)
    diagnostic(`${candidate.name} is still not approved on one org's approval`)

    const otherFounderAdmit = await admit(stack.dashboardUrl, secrets, otherFounderIndex, candidate.networkId)
    if (otherFounderAdmit.status !== "admitted" || otherFounderAdmit.approvals !== safeThreshold) {
        throw new Error(
            `expected ${otherFounder.name}'s admission to execute, got ${JSON.stringify(otherFounderAdmit)}`
        )
    }
    diagnostic(`${otherFounder.name}: ${otherFounderAdmit.message}`)

    await pollCheck(
        () =>
            publicClient.readContract({
                address: stack.networkMemberRegistry,
                abi: NETWORK_MEMBER_REGISTRY_CHECK_ABI,
                functionName: "isApproved",
                args: [candidate.networkId]
            }),
        (approved) => approved
    )
    diagnostic(`${candidate.name} is approved on the registry`)

    const groupSizeAfterAdmission = await pollCheck(
        () =>
            publicClient.readContract({
                address: stack.semaphore,
                abi: SEMAPHORE_GROUP_SIZE_ABI,
                functionName: "getMerkleTreeSize",
                args: [groupId]
            }),
        (size) => size === groupSizeBefore + 1n
    )
    diagnostic(`NetworkMemberGroup ${stack.networkMemberGroup}: ${groupSizeAfterAdmission} member(s)`)

    // The paymaster's own group mirror is async (a poll of the member group's logs); its size
    // catching up by one is what proves the mirror ran for this admission, not just that the chain did.
    const paymasterSizeAfterAdmission = await pollCheck(
        () =>
            publicClient.readContract({
                address: stack.paymaster,
                abi: SEMAPHORE_GROUP_SIZE_ABI,
                functionName: "getMerkleTreeSize",
                args: [paymasterGroupId]
            }),
        (size) => size === paymasterSizeBefore + 1n
    )
    diagnostic(`Paymaster ${stack.paymaster}: ${paymasterSizeAfterAdmission} member(s) (mirrored)`)

    const repeatAdmitResponse = await fetch(`${founder.serverUrl}/v1/governance/admissions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, founder) },
        body: JSON.stringify({ networkId: candidate.networkId })
    })
    if (repeatAdmitResponse.status !== 409) {
        throw new Error(`repeat admission of ${candidate.name} returned ${repeatAdmitResponse.status}, expected 409`)
    }
    diagnostic(`Repeat admission of ${candidate.name}: 409`)

    const unknownNetworkId = `0x${"ff".repeat(32)}`
    const unknownAdmitResponse = await fetch(`${founder.serverUrl}/v1/governance/admissions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, founder) },
        body: JSON.stringify({ networkId: unknownNetworkId })
    })
    if (unknownAdmitResponse.status !== 404) {
        throw new Error(`admission of an unknown networkId returned ${unknownAdmitResponse.status}, expected 404`)
    }
    diagnostic("Admission of an unknown networkId: 404")

    const candidateIdentityResponse = await fetch(
        `${stack.dashboardUrl}/api/orgs/${candidateIndex}/register-identity`,
        { method: "POST", headers: { "content-type": "application/json", ...dashboardHeaders(secrets) } }
    )
    if (candidateIdentityResponse.status !== 201) {
        throw new Error(`registerIdentity through the dashboard returned ${candidateIdentityResponse.status}`)
    }
    diagnostic(`${candidate.name}: registered its member identity, through the dashboard`)

    const candidateIssuerKeyResponse = await fetch(
        `${stack.dashboardUrl}/api/orgs/${candidateIndex}/publish-issuer-key`,
        { method: "POST", headers: { "content-type": "application/json", ...dashboardHeaders(secrets) } }
    )
    if (candidateIssuerKeyResponse.status !== 201) {
        throw new Error(`publishIssuerKey through the dashboard returned ${candidateIssuerKeyResponse.status}`)
    }
    diagnostic(`${candidate.name}: published its credential signing key, through the dashboard`)

    // Now approved, registered, and published, with nobody left waiting: the Membership panel
    // should be down to no action buttons at all.
    await pollCheck(
        async () => {
            const candidateStatusAfterPublishing = await fetch(`${candidate.serverUrl}/`)
            if (candidateStatusAfterPublishing.status !== 200) {
                throw new Error(`${candidate.serverUrl}/ returned ${candidateStatusAfterPublishing.status}`)
            }
            return candidateStatusAfterPublishing.text()
        },
        // Not "data-action=" alone: the page's own inline script builds that attribute with an
        // escaped quote (data-action=\"), which is present in the source regardless of panel state.
        (html) => !html.includes('data-action="')
    ).catch((error: unknown) => {
        throw new Error(
            `expected ${candidate.name}'s status page to offer no actions once fully admitted: ${error instanceof Error ? error.message : String(error)}`
        )
    })
    diagnostic(`${candidate.name}: status page offers no actions once fully admitted`)

    const candidateIssuers = await pollCheck(
        () => readJson<{ leaves: string[] }>(`${candidate.serverUrl}/v1/issuers`),
        (issuers) => issuers.leaves.length >= stack.members.length
    )
    diagnostic(`${candidate.name}: issuer set holds ${candidateIssuers.leaves.length} leaves`)

    const candidateMembership = await pollCheck(
        () =>
            readJson<{ status: string; identityRegistered: boolean; issuerKeyPublished: boolean }>(
                `${candidate.serverUrl}/v1/membership`,
                { headers: memberServerHeaders(secrets, candidate) }
            ),
        (membership) =>
            membership.status === "approved" && membership.identityRegistered && membership.issuerKeyPublished
    )
    diagnostic(
        `${candidate.name}: membership reads ${candidateMembership.status}, identityRegistered, issuerKeyPublished`
    )

    // The same sponsored-registration path as the founder's, now proving admission gave
    // candidate a working one too.
    const secondRequest = buildRegistrationRequest(onboard(randomBytes(32)).keys, domain)
    const secondSubmittedResponse = await fetch(`${candidate.serverUrl}/v1/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, candidate) },
        body: JSON.stringify(secondRequest)
    })
    if (secondSubmittedResponse.status !== 201) {
        throw new Error(`sponsored registration through ${candidate.name} returned ${secondSubmittedResponse.status}`)
    }
    const secondSubmitted = (await secondSubmittedResponse.json()) as {
        status: string
        sponsorship?: { senderBalanceAfter: string }
    }
    if (secondSubmitted.status !== "submitted") {
        throw new Error(`expected a submitted registration through ${candidate.name}, got ${secondSubmitted.status}`)
    }
    if (!secondSubmitted.sponsorship) {
        throw new Error(`expected the registration through ${candidate.name} to carry sponsorship`)
    }
    if (secondSubmitted.sponsorship.senderBalanceAfter !== "0") {
        throw new Error(
            `expected senderBalanceAfter 0 for the registration through ${candidate.name}, got ${secondSubmitted.sponsorship.senderBalanceAfter}`
        )
    }
    diagnostic(`Sponsored registration through ${candidate.name}: sender paid 0 ETH`)
}

async function runChecks(
    stack: StackDescriptor,
    secrets: StackSecrets,
    members: Member[],
    bundlerAddress: Address
): Promise<void> {
    // No open route may carry a secret, and the relay must refuse a POST without the dashboard key.
    const openRoutes = await Promise.all(
        ["/stack.json", "/api/state", "/"].map(
            async (route) => [route, await (await fetch(`${stack.dashboardUrl}${route}`)).text()] as const
        )
    )
    for (const secret of [secrets.dashboardKey, ...Object.values(secrets.memberServerTokens)]) {
        for (const [route, body] of openRoutes) {
            if (body.includes(secret)) throw new Error(`the dashboard's open ${route} carries a secret`)
        }
    }
    const keyless = await fetch(`${stack.dashboardUrl}/api/orgs/0/request-to-join`, {
        method: "POST",
        headers: { "content-type": "application/json" }
    })
    if (keyless.status !== 401) {
        throw new Error(`the dashboard relayed a POST without its key with ${keyless.status}, expected 401`)
    }
    diagnostic("Dashboard: no secret on any open route, and the relay refuses a POST without its key")

    for (const member of stack.members) {
        const health = await fetch(`${member.serverUrl}/health`)
        if (health.status !== 200) throw new Error(`${member.serverUrl}/health returned ${health.status}`)
        const issuers = await fetch(`${member.serverUrl}/v1/issuers`)
        if (issuers.status !== 200) throw new Error(`${member.serverUrl}/v1/issuers returned ${issuers.status}`)
        diagnostic(`${member.name}: /health and /v1/issuers ok`)
    }

    const publicClient = createPublicClient({ transport: http(stack.rpcUrl) })
    const identity = await publicClient.readContract({
        address: stack.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "identity",
        args: [`0x${"00".repeat(32)}`]
    })
    diagnostic(`identity(0x${"00".repeat(32)}) = ${identity}`)

    // The network opens already founded: two admitted orgs, and a Safe at the threshold its own
    // rule gives its owners, so admitting the third takes both founders.
    const founders = stack.members.filter((member) => member.role === "founder")
    const candidates = stack.members.filter((member) => member.role === "candidate")
    if (founders.length !== 2 || candidates.length !== 1) {
        throw new Error(`expected two founders and one candidate, got ${founders.length} and ${candidates.length}`)
    }
    const [founder, otherFounder] = founders
    const [candidate] = candidates
    // The dashboard's own proxy routes address an org by its position in stack.members, the same
    // index the real Admit/Register/Publish buttons post to.
    const candidateIndex = stack.members.indexOf(candidate)

    const [owners, threshold] = await Promise.all([
        publicClient.readContract({ address: stack.governanceSafe, abi: SAFE_READ_ABI, functionName: "getOwners" }),
        publicClient.readContract({ address: stack.governanceSafe, abi: SAFE_READ_ABI, functionName: "getThreshold" })
    ])
    const missingOwners = founders.filter(
        (member) => !owners.some((owner) => isAddressEqual(owner, member.governanceSigner))
    )
    if (missingOwners.length > 0) {
        throw new Error(
            `expected every founder's governance signer to own the Safe, missing ${missingOwners.map((member) => member.name).join(", ")}`
        )
    }
    if (threshold !== BigInt(governanceThreshold(owners.length))) {
        throw new Error(
            `expected the Safe at the governance rule's threshold ${governanceThreshold(owners.length)} for ${owners.length} owner(s), got ${threshold}`
        )
    }
    diagnostic(`Safe ${stack.governanceSafe}: ${owners.length} owner(s), threshold ${threshold}`)

    const approvals = await Promise.all(
        stack.members.map((member) =>
            publicClient.readContract({
                address: stack.networkMemberRegistry,
                abi: NETWORK_MEMBER_REGISTRY_CHECK_ABI,
                functionName: "isApproved",
                args: [member.networkId]
            })
        )
    )
    for (const [index, member] of stack.members.entries()) {
        if (member.role === "founder" && !approvals[index]) {
            throw new Error(`expected ${member.name} to be approved on the registry`)
        }
    }
    const candidateApprovedAtStart = approvals[candidateIndex]
    // A local chain opens with the candidate outside; only a deployed one may already have let it in.
    if (!TESTNET_MODE && candidateApprovedAtStart) {
        throw new Error(`expected ${candidate.name} to be unapproved on the registry`)
    }
    diagnostic(
        `Registry: ${founders.map((member) => member.name).join(" and ")} approved, ${candidate.name} ${candidateApprovedAtStart ? "already approved" : "not yet"}`
    )

    // Decided before --check spends anything, so a story that cannot run refuses without leaving a
    // sponsored registration, a delivery or an enrolment behind.
    const admission = admissionPlan({
        testnet: TESTNET_MODE,
        requested: CHECK_ADMISSION_FLAG,
        candidateApproved: candidateApprovedAtStart,
        requestPending:
            TESTNET_MODE &&
            CHECK_ADMISSION_FLAG &&
            !candidateApprovedAtStart &&
            (await hasPendingRequest(founders[0], secrets, candidate))
    })
    if (admission.run) {
        const shortfall = admissionSeatShortfall(
            founders.map((member) => member.governanceSigner),
            owners,
            Number(threshold)
        )
        if (shortfall) throw new Error(shortfall)
    }

    // A deployed network also holds the founding member the runbook's deploy admitted, one more than
    // the stack's own founders; and a later run may have let the candidate in as well.
    const foundingSize = BigInt(founders.length + (TESTNET_MODE ? 1 : 0))
    const sizeIsFounded = (size: bigint) => (TESTNET_MODE ? size >= foundingSize : size === foundingSize)

    const groupId = await publicClient.readContract({
        address: stack.networkMemberGroup,
        abi: GROUP_ID_ABI,
        functionName: "GROUP_ID"
    })
    const groupSize = await publicClient.readContract({
        address: stack.semaphore,
        abi: SEMAPHORE_GROUP_SIZE_ABI,
        functionName: "getMerkleTreeSize",
        args: [groupId]
    })
    if (!sizeIsFounded(groupSize)) {
        throw new Error(`expected the approved-member group to hold ${foundingSize} members, got ${groupSize}`)
    }
    diagnostic(`NetworkMemberGroup ${stack.networkMemberGroup}: ${groupSize} member(s)`)

    for (const member of founders) {
        const issuerKeys = await publicClient.readContract({
            address: stack.approvedIssuerSet,
            abi: ISSUER_SET_CHECK_ABI,
            functionName: "issuerKeysOf",
            args: [member.networkId]
        })
        if (issuerKeys.length === 0) throw new Error(`${member.name} has no issuer key published`)
        diagnostic(`${member.name} has ${issuerKeys.length} issuer key(s) published`)
    }

    const paymasterGroupId = await publicClient.readContract({
        address: stack.paymaster,
        abi: GROUP_ID_ABI,
        functionName: "GROUP_ID"
    })
    const paymasterGroupSize = await publicClient.readContract({
        address: stack.paymaster,
        abi: SEMAPHORE_GROUP_SIZE_ABI,
        functionName: "getMerkleTreeSize",
        args: [paymasterGroupId]
    })
    if (!sizeIsFounded(paymasterGroupSize)) {
        throw new Error(`expected the paymaster group to hold ${foundingSize} members, got ${paymasterGroupSize}`)
    }
    diagnostic(`Paymaster ${stack.paymaster}: ${paymasterGroupSize} member(s)`)

    const supportedEntryPoints = await callBundler(stack.bundlerUrl, "eth_supportedEntryPoints")
    if (!Array.isArray(supportedEntryPoints) || supportedEntryPoints[0] !== stack.entryPoint) {
        throw new Error(
            `expected the bundler to support ${stack.entryPoint}, got ${JSON.stringify(supportedEntryPoints)}`
        )
    }
    diagnostic(`Bundler ${stack.bundlerUrl}: supports entry point ${stack.entryPoint}`)

    // A sponsored registration for a synthetic user, the way a real user app would submit one,
    // proving flow 2 end to end: sender pays nothing, the paymaster's deposit drops, and a repeat
    // resolves to the dedup path rather than a second on-chain write.
    const domain = { chainId: stack.chainId, verifyingContract: stack.identityRegistry }
    const request = buildRegistrationRequest(onboard(randomBytes(32)).keys, domain)
    const registrationBody = JSON.stringify(request)

    const submittedResponse = await fetch(`${founder.serverUrl}/v1/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, founder) },
        body: registrationBody
    })
    if (submittedResponse.status !== 201) {
        throw new Error(`sponsored registration through ${founder.name} returned ${submittedResponse.status}`)
    }
    const submitted = (await submittedResponse.json()) as {
        status: string
        sponsorship?: {
            senderBalanceBefore: string
            senderBalanceAfter: string
            paymasterDepositBefore: string
            paymasterDepositAfter: string
        }
    }
    if (submitted.status !== "submitted") throw new Error(`expected a submitted registration, got ${submitted.status}`)
    if (!submitted.sponsorship) throw new Error("expected the registration response to carry sponsorship")
    const { sponsorship } = submitted
    if (sponsorship.senderBalanceBefore !== "0") {
        throw new Error(`expected senderBalanceBefore 0, got ${sponsorship.senderBalanceBefore}`)
    }
    if (sponsorship.senderBalanceAfter !== "0") {
        throw new Error(`expected senderBalanceAfter 0, got ${sponsorship.senderBalanceAfter}`)
    }
    // The server read its "after" once, straight after the receipt, which a lagging provider still
    // answers with the old deposit; so this reads the chain until it shows the drop.
    const depositBefore = BigInt(sponsorship.paymasterDepositBefore)
    const depositAfter = await pollCheck(
        () => readPaymasterDeposit(publicClient, stack.paymaster),
        (deposit) => deposit < depositBefore
    )
    diagnostic(
        `Sponsored registration through ${founder.name}: sender paid 0 ETH; paymaster deposit ${depositBefore} -> ${depositAfter}`
    )

    // Polled, and before the repeat below: a provider still serving the block before the registration
    // would let the other founder resubmit it and answer "submitted" instead of "alreadyRegistered".
    await pollCheck(
        () =>
            publicClient.readContract({
                address: stack.identityRegistry,
                abi: IDENTITY_REGISTRY_ABI,
                functionName: "identity",
                args: [request.networkId]
            }),
        (registeredIdentity) => registeredIdentity !== "0x"
    )
    diagnostic(`identity(${request.networkId}) set on chain`)

    // The delivery is sponsored too: the announcement's indexed `caller` is a one-time sender and
    // the bundler's account sends the transaction, so neither the log nor `tx.from` names a member.
    const deliveryResponse = await fetch(`${founder.serverUrl}/v1/deliveries`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, founder) },
        body: JSON.stringify({ networkId: request.networkId })
    })
    if (deliveryResponse.status !== 201) {
        throw new Error(`sponsored delivery through ${founder.name} returned ${deliveryResponse.status}`)
    }
    const { txHash: deliveryTxHash } = (await deliveryResponse.json()) as { txHash: Hex }
    const [deliveryTransaction, deliveryReceipt] = await pollCheck(
        () =>
            Promise.all([
                publicClient.getTransaction({ hash: deliveryTxHash }),
                publicClient.getTransactionReceipt({ hash: deliveryTxHash })
            ]),
        () => true
    )
    const [announcement] = parseEventLogs({
        abi: ANNOUNCEMENT_EVENT_ABI,
        eventName: "Announcement",
        logs: deliveryReceipt.logs.filter((log) => log.address.toLowerCase() === stack.announcer.toLowerCase())
    })
    if (!announcement) throw new Error("expected the delivery to emit an Announcement")
    // The wallet key is not in the descriptor, and it is what the direct path announces from.
    const memberAddresses = members.flatMap((member) => [
        member.authAddress,
        member.governanceSignerAddress,
        privateKeyToAccount(member.walletPrivateKey).address
    ])
    if (memberAddresses.some((address) => address.toLowerCase() === announcement.args.caller.toLowerCase())) {
        throw new Error(`the announcement's caller ${announcement.args.caller} is a member address`)
    }
    if (deliveryTransaction.from.toLowerCase() !== bundlerAddress.toLowerCase()) {
        throw new Error(
            `expected the delivery to be sent by the bundler ${bundlerAddress}, got ${deliveryTransaction.from}`
        )
    }
    diagnostic(
        `Sponsored delivery through ${founder.name}: announced from ${announcement.args.caller}, sent by the bundler`
    )

    // Flow 5: the other founder finds, in the shared registry, a person this founder registered.
    const repeatResponse = await fetch(`${otherFounder.serverUrl}/v1/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...memberServerHeaders(secrets, otherFounder) },
        body: registrationBody
    })
    const repeat = (await repeatResponse.json()) as { status: string; matchesRequest?: boolean }
    if (repeat.status !== "alreadyRegistered" || repeat.matchesRequest !== true) {
        throw new Error(
            `expected a matching repeat registration through ${otherFounder.name}, got ${JSON.stringify(repeat)}`
        )
    }
    diagnostic(`Repeat registration through ${otherFounder.name}: alreadyRegistered, matchesRequest`)

    const otherFounderStatusAfterRepeat = await readJson<{ counts: { existingRegistrations: number } }>(
        `${otherFounder.serverUrl}/v1/status`
    )
    if (otherFounderStatusAfterRepeat.counts.existingRegistrations !== 1) {
        throw new Error(
            `expected ${otherFounder.name}'s existingRegistrations to be 1, got ${otherFounderStatusAfterRepeat.counts.existingRegistrations}`
        )
    }
    diagnostic(`${otherFounder.name}: existingRegistrations is 1`)

    const otherFounderSubject = await enrolSubject(otherFounder, secrets, domain)
    const otherFounderCredentialId = await issueCredential(
        otherFounder.serverUrl,
        otherFounder.networkId,
        otherFounderSubject
    )
    diagnostic(`${otherFounder.name}: issued its own credential ${otherFounderCredentialId}`)

    const admittedAtStart = founders.length + (candidateApprovedAtStart ? 1 : 0)
    const setupBeforeAdmission = await pollCheck(
        () => readDashboardNetworkSetup(stack.dashboardUrl),
        (setup) => setup.membersAdmitted === admittedAtStart && setup.membersTotal === stack.members.length
    )
    diagnostic(
        `Dashboard: ${setupBeforeAdmission.membersAdmitted} of ${setupBeforeAdmission.membersTotal} orgs admitted before the admission`
    )

    if (admission.run) {
        await checkAdmission({
            stack,
            secrets,
            publicClient,
            founders,
            candidate,
            groupId,
            paymasterGroupId,
            groupSizeBefore: groupSize,
            paymasterSizeBefore: paymasterGroupSize,
            safeThreshold: governanceThreshold(owners.length),
            domain,
            resumeAtApprovals: admission.resumeAtApprovals
        })
    } else {
        diagnostic(admission.reason)
    }
    const candidateApprovedAtEnd = admission.run || candidateApprovedAtStart

    // One revocation registry for the network: the verifier's snapshot follows the issuer's revocation
    // without being told, and since the wallet refuses to prove a revoked credential, this check closes
    // the request the way the member app does.
    const [issuer, verifier] = stack.members
    const verifierSnapshot = await pollCheck(
        () =>
            readJson<{ registryAddress: string; registryId: string; root: string }>(
                `${verifier.serverUrl}/v1/revocations/snapshot`
            ),
        (snapshot) => typeof snapshot.root === "string"
    )
    if (verifierSnapshot.registryId !== stack.revocation.registryId) {
        throw new Error(
            `expected ${verifier.name} to serve registry ${stack.revocation.registryId}, got ${verifierSnapshot.registryId}`
        )
    }
    // The local deployment seeds the tree, so a zero root means the seeding did not happen. A deployed
    // network starts empty, which is fine there.
    if (!TESTNET_MODE && verifierSnapshot.root === "0") {
        throw new Error(`expected ${verifier.name}'s revocation tree to be seeded, got the empty root`)
    }
    diagnostic(
        `${verifier.name}: serves the network registry ${verifierSnapshot.registryId} at root ${verifierSnapshot.root.slice(0, 12)}…`
    )

    const issuerIndex = stack.members.indexOf(issuer)
    const issuerSubject = await enrolSubject(issuer, secrets, domain)
    const credentialId = await issueCredential(issuer.serverUrl, issuer.networkId, issuerSubject)
    const revokeResponse = await fetch(`${stack.dashboardUrl}/api/orgs/${issuerIndex}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", ...dashboardHeaders(secrets) },
        body: JSON.stringify({ credentialId })
    })
    if (revokeResponse.status !== 200) {
        throw new Error(`revoking through the dashboard returned ${revokeResponse.status}`)
    }
    diagnostic(`${issuer.name}: issued a credential and revoked it, through the dashboard`)

    const { credentials: issuerCredentials } = await pollCheck(
        () =>
            readJson<{ credentials: { id: string; revoked: boolean }[] }>(
                `${stack.dashboardUrl}/api/orgs/${issuerIndex}/credentials`,
                { headers: dashboardHeaders(secrets) }
            ),
        (listing) => listing.credentials.some((credential) => credential.id === credentialId)
    )
    const revokedCredential = issuerCredentials.find((credential) => credential.id === credentialId)
    if (!revokedCredential?.revoked) {
        throw new Error(`expected the dashboard's listing to show ${credentialId} revoked`)
    }
    diagnostic(`Dashboard: /api/orgs/${issuerIndex}/credentials shows ${credentialId} revoked`)

    // The dashboard reads each org's listing itself, for the Orgs tab, and that read is a
    // member-side route too. Its own fetch treats any non-200 as "nothing to show", so forgetting
    // the token there empties the panel instead of failing.
    const listsCredential = (state: { members: { name: string; credentials: { id: string }[] | null }[] }) =>
        state.members
            .find((member) => member.name === issuer.name)
            ?.credentials?.some((credential) => credential.id === credentialId) === true
    await pollCheck(
        () => readJson<Parameters<typeof listsCredential>[0]>(`${stack.dashboardUrl}/api/state`),
        listsCredential
    )
    diagnostic(`Dashboard: /api/state carries ${issuer.name}'s own credential listing`)

    // The assertion this check was missing, and the reason the bug it covers reached a phone: the
    // listing above is the revoking org's own server, which always sees its own write. This one is
    // the verifier's, which never wrote to the tree - and the verifier's snapshot is the tree a
    // wallet builds its non-membership proof against. A root that has not moved here is a revoked
    // credential that still presents successfully, inside the service's root grace, from an honest
    // wallet. The commitment itself is deliberately not reachable through any route (it would name
    // the holder), so the root moving is what says the revocation arrived.
    await pollCheck(
        () => readJson<{ root: string }>(`${verifier.serverUrl}/v1/revocations/snapshot`),
        rootMovedFrom(verifierSnapshot.root)
    ).catch((error: unknown) => {
        throw new Error(
            `expected ${verifier.name}'s revocation root to move after ${issuer.name} revoked, still ${verifierSnapshot.root}: ${error instanceof Error ? error.message : String(error)}`
        )
    })
    diagnostic(`${verifier.name}: its snapshot followed ${issuer.name}'s revocation without being told`)

    const presentationRequest = await fetch(`${verifier.serverUrl}/v1/presentation-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programme: "demo-programme", country: "ZZZ" })
    })
    const { requestId } = (await presentationRequest.json()) as { requestId: string }
    const closeResponse = await fetch(`${verifier.serverUrl}/v1/presentation-requests/${requestId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "CREDENTIAL_REVOKED" })
    })
    if (closeResponse.status !== 200) {
        throw new Error(`closing a presentation request at ${verifier.name} returned ${closeResponse.status}`)
    }
    const { verificationId } = (await closeResponse.json()) as { verificationId: string }
    const closed = await readJson<{ ok: boolean; code: string }>(
        `${verifier.serverUrl}/v1/verifications/${verificationId}`,
        { headers: memberServerHeaders(secrets, verifier) }
    )
    if (closed.ok || closed.code !== "CREDENTIAL_REVOKED") {
        throw new Error(`expected ${verifier.name} to record CREDENTIAL_REVOKED, got ${JSON.stringify(closed)}`)
    }
    diagnostic(`${verifier.name}: recorded the wallet's refusal to present a revoked credential`)

    const flowsAfterRevocation = await pollCheck(
        async () =>
            (await readJson<{ flows: { title: string; state: string }[] }>(`${stack.dashboardUrl}/api/state`)).flows,
        (flows) => [3, 4].every((index) => flows[index].state === "done")
    )
    for (const index of [3, 4]) diagnostic(`Dashboard: "${flowsAfterRevocation[index].title}" reads done`)

    const dashboardState = await fetch(`${stack.dashboardUrl}/api/state`)
    if (dashboardState.status !== 200) {
        throw new Error(`${stack.dashboardUrl}/api/state returned ${dashboardState.status}`)
    }
    diagnostic(`Dashboard ${stack.dashboardUrl}: /api/state ok`)

    const dashboardStateBody = (await dashboardState.json()) as {
        members: { name: string; credentials: { id: string }[] | null }[]
        flows: { title: string; prompt: string; state: string; count: { value: number; noun: string } }[]
        networkSetup: { membersAdmitted: number; membersTotal: number }
        liveLine: { name: string; message: string } | null
    }
    const flowTitles = dashboardStateBody.flows.map((flow) => flow.title)
    if (flowTitles.join("|") !== FLOW_TITLES.join("|")) {
        throw new Error(
            `expected the dashboard's five flow titles ${FLOW_TITLES.join(", ")}, got ${flowTitles.join(", ")}`
        )
    }
    diagnostic("Dashboard: carries the five flow titles")

    const admittedAtEnd = founders.length + (candidateApprovedAtEnd ? 1 : 0)
    const { membersAdmitted, membersTotal } = await pollCheck(
        () => readDashboardNetworkSetup(stack.dashboardUrl),
        (setup) => setup.membersAdmitted === admittedAtEnd && setup.membersTotal === stack.members.length
    )
    diagnostic(`Dashboard: network setup panel reports ${membersAdmitted} of ${membersTotal} orgs admitted`)

    if (!dashboardStateBody.liveLine) throw new Error("expected the dashboard's live line to carry an event")
    diagnostic(
        `Dashboard: live line reports "${dashboardStateBody.liveLine.name}: ${dashboardStateBody.liveLine.message}"`
    )

    // The live line has no panel of its own any more: it hangs off the step the demo is on, so
    // exactly one step has to claim that place and carry the instruction that advances it.
    const currentFlows = dashboardStateBody.flows.filter((flow) => flow.state === "current")
    if (currentFlows.length !== 1 || !currentFlows[0].prompt) {
        throw new Error(
            `expected exactly one current flow carrying a prompt, got ${currentFlows.length}: ${currentFlows.map((flow) => flow.title).join(", ")}`
        )
    }
    diagnostic(`Dashboard: "${currentFlows[0].title}" is the current step, and says what to do next`)

    const dashboardPage = await (await fetch(`${stack.dashboardUrl}/`)).text()
    for (const [missing, reason] of [
        ['<div class="panel-grid panel-grid-lead">', "the Flow tab does not lead with the flow"],
        ["flow-row flow-current", "no step is marked current on the page"],
        ['class="flow-figure"', "the steps carry no figures"],
        ['class="feed-split"', "Recent activity does not carry both feeds"]
    ] as const) {
        if (!dashboardPage.includes(missing)) throw new Error(`Dashboard: ${reason} (expected ${missing})`)
    }
    if (dashboardPage.includes("Just happened")) {
        throw new Error("Dashboard: the live line still has a panel of its own")
    }
    diagnostic("Dashboard: the flow leads its tab, with the live line on the current step")

    for (const member of stack.members) {
        const status = await fetch(`${member.serverUrl}/v1/status`)
        if (status.status !== 200) throw new Error(`${member.serverUrl}/v1/status returned ${status.status}`)
        const membership = await fetch(`${member.serverUrl}/v1/membership`, {
            headers: memberServerHeaders(secrets, member)
        })
        if (membership.status !== 200) {
            throw new Error(`${member.serverUrl}/v1/membership returned ${membership.status}`)
        }
        const { status: membershipStatus } = (await membership.json()) as { status: string }
        // The founders were admitted at genesis, the candidate by the story above or an earlier run.
        if (membershipStatus !== "approved" && (member.role === "founder" || candidateApprovedAtEnd)) {
            throw new Error(`expected ${member.name}'s membership status to be approved, got ${membershipStatus}`)
        }
        const unauthenticated = await fetch(`${member.serverUrl}/v1/membership`)
        if (unauthenticated.status !== 401) {
            throw new Error(
                `${member.serverUrl}/v1/membership answered ${unauthenticated.status} without a token, expected 401`
            )
        }
        const wrongOrg = await fetch(`${member.serverUrl}/v1/credentials`, {
            headers: memberServerHeaders(secrets, stack.members.find((other) => other !== member) ?? member)
        })
        if (wrongOrg.status !== 401) {
            throw new Error(`${member.serverUrl}/v1/credentials accepted another org's token with ${wrongOrg.status}`)
        }
        diagnostic(`${member.name}: /v1/status and /v1/membership ok (${membershipStatus}), and its own token only`)
    }
}

/** Everything `run()` needs once the chain side is settled, however it got there: deployed here on a
 *  throwaway Anvil, or read off a deployment file on a public chain. */
export interface ResolvedStack {
    chain: Chain
    addresses: StackAddresses
    deployBlock: bigint
    /** The approved-member group's id on the Semaphore contract. */
    groupId: bigint
    safeVersion: SafeVersion
    chainId: number
    members: Member[]
    logWindowBlocks?: number
    logConfirmations?: number
    /** Where `stack.json` tells the phones to find the chain. */
    publicRpcUrl: string
    /** The Safe's own `MultiSendCallOnly`, when it was deployed with one; a public chain has the
     *  SDK's canonical address instead. */
    multiSend?: Address
    /** What the paymaster's group mirror reads and writes, and how often it polls. */
    paymasterMirror: {
        paymaster: ContractDeployment
        group: ContractDeployment
        paymasterGroupFromBlock: bigint
        pollingIntervalMs: number
    }
}

/** A throwaway Anvil with the whole network deployed on it and the two founders admitted. */
async function resolveLocalStack(diagnostic: (message: string) => void): Promise<ResolvedStack> {
    diagnostic("Starting an isolated local chain, reachable on the LAN")
    const anvil = await startDedicatedAnvil(diagnostic, { host: "0.0.0.0", port: STACK_PORT })

    try {
        diagnostic("Deploying revocation, stealth, and identity contracts")
        const revocation = await deployRevocationRegistry(anvil, diagnostic)
        const stealth = await deployStealthContracts(anvil, diagnostic)
        const semaphore = await deploySemaphore(anvil, diagnostic)

        const secrets = memberSecrets()
        const members = buildMembers(secrets, anvil.chainDefinition.id)
        for (const member of members) {
            const walletAddress = privateKeyToAccount(member.walletPrivateKey).address
            await fundMember(anvil, walletAddress)
            await fundMember(anvil, member.authAddress)
            await fundMember(anvil, member.governanceSignerAddress)

            diagnostic(
                `${member.name} (${member.role}): wallet ${walletAddress}, auth ${member.authAddress}, governance signer ${member.governanceSignerAddress}`
            )
        }

        const founders: GovernanceFounder[] = await Promise.all(
            members
                .filter((member) => member.role === "founder")
                .map(async (member) => ({
                    networkId: member.networkId,
                    authPrivateKey: member.authPrivateKey,
                    governanceSignerPrivateKey: member.governanceSignerPrivateKey,
                    semaphoreCommitment: member.semaphoreCommitment,
                    credentialPublicKey: await member.signer.getPublicKey()
                }))
        )

        const governance = await deployGovernanceStack(anvil, semaphore, founders, diagnostic)
        const credentialRevocation = await deployCredentialRevocationRegistry(
            anvil,
            semaphore.semaphore.address,
            governance.groupId,
            revocation.address,
            diagnostic
        )
        await seedCredentialRevocationRegistry(
            anvil,
            credentialRevocation,
            semaphore.semaphore.address,
            governance.groupId,
            secrets[0],
            governance.deployBlock,
            diagnostic
        )
        const identity = await deployIdentityRegistry(anvil, semaphore, governance.groupId, diagnostic)

        return {
            chain: anvil,
            addresses: {
                identityRegistry: identity.registry.address,
                announcer: stealth.announcer.address,
                revocation: revocation.address,
                credentialRevocationRegistry: credentialRevocation.address,
                credentialRevocationRegistryId: credentialRevocation.registryId,
                semaphore: semaphore.semaphore.address,
                networkMemberRegistry: governance.registry.address,
                networkMemberGroup: governance.group.address,
                networkMemberGovernance: governance.governance.address,
                approvedIssuerSet: governance.issuerSet.address,
                governanceSafe: governance.safe.address,
                entryPoint: stealth.execution.entryPoint.address,
                paymaster: stealth.execution.paymaster.address,
                accountImplementation: stealth.execution.accountImplementation.address
            },
            deployBlock: governance.deployBlock,
            groupId: governance.groupId,
            safeVersion: governance.context.safeVersion,
            chainId: anvil.chainDefinition.id,
            members,
            publicRpcUrl: `http://${lanAddress()}:${STACK_PORT}`,
            multiSend: governance.context.multiSend,
            paymasterMirror: {
                paymaster: stealth.execution.paymaster,
                group: governance.group,
                paymasterGroupFromBlock: stealth.paymasterGroupStartBlock,
                pollingIntervalMs: 1000
            }
        }
    } catch (error) {
        anvil.stop()
        throw error
    }
}

/** What to stop if the process dies on a bug rather than a signal; set once a stack is running. */
let stopStack: (() => Promise<void>) | undefined

/**
 * The handler for a bug in a fire-and-forget path: print the redacted stack, stop what is running so
 * no Anvil or listener outlives the process, and exit non-zero. A second failure while stopping
 * does not start a second shutdown.
 */
export function createFatalHandler({
    cleanup,
    write,
    exit,
    cleanupTimeoutMs = 10_000
}: {
    cleanup: () => Promise<void> | undefined
    write: (text: string) => void
    exit: (code: number) => void
    /** How long stopping may take before the process exits anyway. */
    cleanupTimeoutMs?: number
}): (event: string, error: unknown) => Promise<void> {
    let failing = false
    return async (event, error) => {
        if (failing) return
        failing = true
        write(`${event}: ${describeError(error)}\n`)
        // A cleanup that never settles must not keep a dead stack alive.
        let timer: NodeJS.Timeout | undefined
        try {
            await Promise.race([
                cleanup(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, cleanupTimeoutMs)
                })
            ])
        } catch {
            // Already failing; a second error while stopping has nothing more to say.
        } finally {
            clearTimeout(timer)
        }
        exit(1)
    }
}

/** Runs `task` on the first call; a later call waits for that run rather than returning while it is under way. */
export function runOnce(task: () => Promise<void>): () => Promise<void> {
    let running: Promise<void> | undefined
    return () => (running ??= task())
}

/** `--genesis`: the one-time on-chain setup a deployed network needs, then exit. */
async function runGenesisCommand(): Promise<void> {
    if (!TESTNET_MODE) throw new OperatorError("--genesis sets up a deployed network; set TESTBED_MODE=testnet")

    const stack = await resolveTestnetStack(diagnostic)
    const founders = stack.members.filter((member) => member.role === "founder")
    // OWNER's own key is the chain's signer, which genesis holds already.
    const heldKeys = founders.flatMap((member) => [member.governanceSignerPrivateKey, member.authPrivateKey])
    await preflight(stack, stack.chain.publicClient, "genesis", [
        stack.chain.deployer,
        ...heldKeys.map((key) => privateKeyToAccount(key).address)
    ])
    const actions = await runGenesis(stack, heldKeys, diagnostic)
    diagnostic(
        actions.length === 0
            ? "Genesis: nothing to do, the network is set up"
            : `Genesis: ${actions.length} step(s) done`
    )
}

async function run(): Promise<void> {
    validateStackSettings()
    minDeviceSecurityLevel()
    if (GENESIS_MODE) return runGenesisCommand()

    let resolved: ResolvedStack | undefined
    let bundler: Bundler | undefined
    let dashboard: Dashboard | undefined
    let rpcProxy: RpcProxy | undefined
    const listeners: HttpServer[] = []
    let stopPaymasterMirror: (() => void) | undefined
    let secretsFile: string | undefined
    const cleanup = runOnce(async () => {
        stopPaymasterMirror?.()
        await Promise.all(listeners.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))))
        await dashboard?.close()
        await bundler?.close()
        await rpcProxy?.close()
        resolved?.chain.stop()
        // The secrets are per-run, so their file goes with the run.
        if (secretsFile) rmSync(dirname(secretsFile), { recursive: true, force: true })
    })
    stopStack = cleanup

    const activity = new StackActivityLog()
    const trackedDiagnostic = (message: string): void => {
        diagnostic(message)
        activity.append("deploy", message)
    }

    try {
        const testnet = TESTNET_MODE ? await resolveTestnetStack(trackedDiagnostic) : undefined
        if (testnet) {
            const { warnings } = await preflight(testnet, testnet.chain.publicClient, "serve")
            for (const warning of warnings) trackedDiagnostic(`warning: ${warning}`)
        }
        resolved = testnet ?? (await resolveLocalStack(trackedDiagnostic))
        const { chain, addresses, members, paymasterMirror } = resolved

        stopPaymasterMirror = await mirrorMembersIntoPaymaster(
            chain,
            paymasterMirror.paymaster,
            paymasterMirror.group,
            trackedDiagnostic,
            (commitment, change) =>
                activity.append(
                    "paymaster",
                    `${change === "added" ? "mirrored" : "removed"} commitment ${commitment} ${change === "added" ? "into" : "from"} the paymaster group`
                ),
            (commitment, error) =>
                activity.append("paymaster", `failed to mirror commitment ${commitment}: ${describeError(error)}`),
            {
                fromBlock: resolved.deployBlock,
                paymasterGroupFromBlock: paymasterMirror.paymasterGroupFromBlock,
                logWindowBlocks: resolved.logWindowBlocks,
                logConfirmations: resolved.logConfirmations,
                pollingIntervalMs: paymasterMirror.pollingIntervalMs
            }
        )

        const host = lanAddress()
        // A local chain's stack is for the phones on the LAN; a deployed one answers only where the operator says.
        const bindHost = testnet ? host : "0.0.0.0"
        // The phones reach a public chain through this process so the provider's key never leaves
        // the stack's environment, unless `STACK_PUBLIC_RPC_URL` names an endpoint they can use directly.
        if (testnet && !publicRpcOverride()) {
            rpcProxy = await startRpcProxy({
                upstream: chain.rpcUrl,
                host,
                port: STACK_PORT,
                onUpstreamError: (message) => activity.append("deploy", `RPC proxy: ${message}`)
            })
            trackedDiagnostic(`RPC proxy on ${rpcProxy.url}`)
        }
        const stack = buildStackDescriptor(
            host,
            { rpcUrl: resolved.publicRpcUrl, chainId: resolved.chainId },
            addresses,
            members
        )
        const stackSecrets = buildStackSecrets(members)

        trackedDiagnostic(`Starting the bundler on :${STACK_BUNDLER_PORT}`)
        bundler = await startBundler({
            chain,
            entryPoint: addresses.entryPoint,
            paymaster: addresses.paymaster,
            account: testnet?.bundlerAccount,
            host: bindHost,
            port: STACK_BUNDLER_PORT,
            onActivity: (message) => activity.append("bundler", message)
        })

        const issuerSetBacking = buildChainIssuerSet(addresses.approvedIssuerSet, chain.rpcUrl)

        trackedDiagnostic(`Starting member servers on ${members.map((member) => `:${member.port}`).join(", ")}`)
        for (const member of members) {
            listeners.push(
                await startMemberServer({
                    member,
                    otherMembers: members.filter((other) => other !== member),
                    rpcUrl: chain.rpcUrl,
                    addresses,
                    chainId: resolved.chainId,
                    deployBlock: resolved.deployBlock,
                    safeVersion: resolved.safeVersion,
                    multiSend: resolved.multiSend,
                    logWindowBlocks: resolved.logWindowBlocks,
                    logConfirmations: resolved.logConfirmations,
                    issuerSetBacking,
                    bundlerUrl: bundler.url,
                    host,
                    listenHost: testnet ? host : undefined,
                    dashboardUrl: stack.dashboardUrl
                })
            )
        }

        const stackJson = JSON.stringify(
            stack,
            (_key, value) => (typeof value === "bigint" ? value.toString() : value),
            2
        )
        writeFileSync(STACK_FILE, `${stackJson}\n`)
        diagnostic(`Wrote ${STACK_FILE}`)
        diagnostic(stackJson)
        secretsFile = writeStackSecrets(stack, stackSecrets)
        diagnostic(`Wrote ${secretsFile} (operator only: the dashboard link with its key, and every org's token)`)

        trackedDiagnostic(`Starting the dashboard on :${STACK_DASHBOARD_PORT}`)
        const stackBundler = bundler
        dashboard = await startDashboard({
            stack,
            secrets: stackSecrets,
            getState: createDashboardGatherer({
                stack,
                secrets: stackSecrets,
                publicClient: chain.publicClient,
                deployBlock: resolved.deployBlock,
                logWindowBlocks: resolved.logWindowBlocks === undefined ? undefined : BigInt(resolved.logWindowBlocks),
                logConfirmations:
                    resolved.logConfirmations === undefined ? undefined : BigInt(resolved.logConfirmations),
                bundler: stackBundler,
                activity
            }),
            host: bindHost,
            port: STACK_DASHBOARD_PORT,
            // Each poll of a provider costs requests; a local node answers for nothing.
            stateTtlMs: testnet ? 5_000 : 0
        })
        diagnostic(`Dashboard: ${stack.dashboardUrl}`)
        // `generate` must be called as a method: it reads `this.error`, which a destructured reference loses.
        diagnostic("Wallet: scan this to point it at the stack")
        qrcodeTerminal.generate(`${stack.dashboardUrl}/stack.json`, { small: true })
        // QRs only, so no raw token reaches scrollback or logs; `--check` pairs no phone, so it prints none.
        stack.members.forEach((member, index) => {
            if (!member.scheme || CHECK_MODE) return
            diagnostic(`${member.name}'s app (${member.scheme}): scan this from its Setup screen to pair it`)
            qrcodeTerminal.generate(pairingUrl(stack, stackSecrets, index), { small: true })
        })

        if (CHECK_MODE) {
            await runChecks(stack, stackSecrets, members, bundler.address)
            diagnostic("stack check passed")
            return
        }

        diagnostic("Stack is up. Press Ctrl+C to stop.")
        await new Promise<void>((resolve) => {
            for (const signal of ["SIGINT", "SIGTERM"] as const) {
                process.once(signal, () => resolve())
            }
        })
    } finally {
        await cleanup()
    }
}

// Guarded so tests can import the pure builders above without spinning up a chain.
if (require.main === module) {
    const fatal = createFatalHandler({
        cleanup: () => stopStack?.(),
        write: (text) => void process.stderr.write(text),
        exit: (code) => process.exit(code)
    })
    for (const event of ["unhandledRejection", "uncaughtException"] as const) {
        process.on(event, (error: unknown) => void fatal(event, error))
    }
    run()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(describeError(error))
            process.exit(1)
        })
}
