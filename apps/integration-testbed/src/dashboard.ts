import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { toString as qrCodeToString } from "qrcode"
import { z } from "zod"
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem"
import type { Hex32 } from "@coordination-network/credential"
import {
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    decodeJoinRequestLog
} from "@coordination-network/network-member-governance"
import type { NetworkMemberJoinRequest } from "@coordination-network/network-member-governance"
import type { ActivityExcerpt } from "../../issuer-service/src/activity"
import { EventLogIndex } from "../../issuer-service/src/chain-logs"
import { GOVERNANCE_ROUTES } from "../../issuer-service/src/routes/governance"
import type { MemberStatusSnapshot } from "../../issuer-service/src/routes/status"
import {
    actionButton,
    badge,
    escapeHtml,
    keyValueTable,
    list,
    renderPage,
    tabsScript,
    type BadgeTone,
    type Panel,
    type Tab
} from "../../issuer-service/src/status/template"
import type { Bundler, BundlerOperationSummary } from "./bundler"
import { refuseForeignHost } from "./host-guard"
import { redactUrls } from "./redact-urls"
import { SAFE_READ_ABI } from "./serve"
import type { MemberRole, StackDescriptor, StackMember } from "./serve"
import { hasDashboardKey, memberServerHeaders, type StackSecrets } from "./stack-secrets"

/** What the dashboard keeps of a member's `/v1/status`: the page's own pending-request list is not parsed. */
export type MemberStatus = Omit<MemberStatusSnapshot, "pendingRequests">

/** `EntryPoint.UserOperationEvent`, for `getLogs`; matches `entryPoint08Abi`'s own fragment,
 *  which doesn't export it standalone. */
const USER_OPERATION_EVENT = parseAbiItem(
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
)

/** `SemaphorePaymaster`'s own reads: it is itself a Semaphore group, so `GROUP_ID` etc. live
 *  elsewhere; these are the deposit and the per-operation cap unique to the paymaster. */
const PAYMASTER_ABI = [
    { type: "function", name: "getDeposit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "MAX_COST_PER_OP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

/** The one `NetworkMemberRegistry` read the dashboard needs beyond `network-member-governance`'s
 *  own ABI (which carries only `requestToJoin` and its event). */
const REGISTRY_ABI = [
    {
        type: "function",
        name: "isApproved",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "bool" }]
    }
] as const

/** `IdentityRegistry`'s own event, for `getLogs`; matches `IdentityRegistry.sol`'s fragment,
 *  which doesn't export it standalone. */
const IDENTITY_REGISTERED = parseAbiItem(
    "event IdentityRegistered(bytes32 indexed networkId, bytes metaStealthAddress)"
)

/** The one `ApprovedIssuerSet` read the dashboard needs: its live key count. */
const ISSUER_SET_ABI = [
    { type: "function", name: "getSize", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

const hex = (bytesLength: number) =>
    z.templateLiteral(["0x", z.string().regex(new RegExp(`^[0-9a-fA-F]{${bytesLength * 2}}$`))])

/** The `/v1/status` body a member server answers with, validated on the way in: an unreachable
 *  or malformed response becomes `null` rather than an `unknown` the rest of the dashboard can't use. */
const MEMBER_STATUS_SCHEMA = z.object({
    networkId: hex(32),
    displayName: z.string(),
    authAddress: hex(20),
    membership: z.object({
        status: z.enum(["approved", "requested", "none"]),
        safe: z.object({ address: hex(20), threshold: z.number(), owners: z.array(hex(20)) }),
        identityRegistered: z.boolean(),
        issuerKeyPublished: z.boolean()
    }),
    issuerKey: z.object({ x: z.string(), y: z.string(), published: z.boolean() }),
    issuerSet: z.object({ address: hex(20).nullable(), root: z.string(), size: z.number() }),
    counts: z.object({
        registrations: z.number(),
        existingRegistrations: z.number(),
        credentials: z.number(),
        revocations: z.number(),
        verifications: z.number(),
        rejectedVerifications: z.number()
    }),
    recentActivity: z.array(
        z.object({
            at: z.number(),
            kind: z.enum(["registration", "credential", "revocation", "verification", "governance"]),
            message: z.string()
        })
    )
})

/** One row of `GET /v1/credentials`, validated the same way `/v1/status` is: an unreachable or
 *  malformed response becomes `null` rather than an `unknown` the rest of the dashboard can't use. */
const CREDENTIAL_SUMMARY_SCHEMA = z.object({
    id: z.string(),
    programme: z.string(),
    country: z.string(),
    issuedAt: z.number(),
    expiresAt: z.number(),
    revoked: z.boolean()
})
const CREDENTIALS_SCHEMA = z.object({ credentials: z.array(CREDENTIAL_SUMMARY_SCHEMA) })
export type CredentialSummary = z.infer<typeof CREDENTIAL_SUMMARY_SCHEMA>

export type StackActivityKind = "deploy" | "paymaster" | "bundler"

export interface StackActivityEntry {
    at: number
    kind: StackActivityKind
    message: string
}

const MAX_STACK_ACTIVITY_ENTRIES = 100

/** In-memory ring of the stack's own activity: deploy steps, the paymaster mirror, and the
 *  bundler all append to one shared instance. Distinct from each member server's own `ActivityLog`. */
export class StackActivityLog {
    private readonly entries: StackActivityEntry[] = []

    append(kind: StackActivityKind, message: string): void {
        this.entries.push({ at: Date.now(), kind, message: redactUrls(message) })
        if (this.entries.length > MAX_STACK_ACTIVITY_ENTRIES) this.entries.shift()
    }

    recent(limit = MAX_STACK_ACTIVITY_ENTRIES): StackActivityEntry[] {
        return this.entries.slice(-limit).reverse()
    }
}

export interface ChainPanelState {
    blockNumber: string
    chainId: number
    rpcUrl: string
}

export interface PaymasterOperationState {
    hash: Hex
    sender: Address
    gasCost: string
    success: boolean
}

export interface PaymasterPanelState {
    address: Address
    deposit: string
    maxCostPerOp: string
    operations: PaymasterOperationState[]
}

export interface SafeMemberState {
    name: string
    networkId: Hex32
    authAddress: Address
    role: MemberRole
    approved: boolean
}

export interface PendingJoinRequestState {
    networkId: Hex32
    semaphoreCommitment: string
    governanceSigner: Address
    metadataURI: string
}

export interface SafePanelState {
    address: Address
    threshold: number
    owners: Address[]
    members: SafeMemberState[]
    pendingJoinRequests: PendingJoinRequestState[]
}

export interface BundlerPanelState {
    address: Address
    balance: string
    nonce: number
    recent: BundlerOperationSummary[]
}

export interface MemberServerState {
    name: string
    url: string
    healthy: boolean
    status: MemberStatus | null
    /** This org's own `GET /v1/credentials`, read the same server-to-server way `/v1/status` is.
     *  Optional so a fixture that predates this field still type-checks; a live read always sets
     *  it, to `null` on the same unreachable/malformed conditions as `status`. */
    credentials?: CredentialSummary[] | null
}

/** `current` is the first step not yet finished - the one the demo is on. Exactly one row carries
 *  it, so the live line and the prompt always have a home, even once every step is done. */
export type FlowState = "done" | "current" | "waiting"

export interface FlowRow {
    number: number
    title: string
    oneLiner: string
    /** What to do, on which app, to move this step along. Static per step, so it cannot drift out
     *  of true with live state; shown only while the step is the current one. */
    prompt: string
    state: FlowState
    /**
     * One headline figure for the step. It is the same number the step's own end condition tests,
     * so the count and the state cannot disagree; a non-zero count on a step that is not yet done
     * is how "started" reads.
     */
    count: { value: number; noun: string }
}

/** What the old "Network membership" flow row carried, now its own panel above the flows: the
 *  network being stood up, before the five-flow story starts. */
export interface NetworkSetupState {
    membersAdmitted: number
    membersTotal: number
    issuerKeysPublished: number
    safeThreshold: number
    safeOwners: Address[]
    pendingJoinRequests: PendingJoinRequestState[]
}

/** One org event, as {@link buildOrgActivity} merges them: a member's own `recentActivity` entry
 *  plus the name of the org that reported it. */
export interface OrgActivityEntry {
    at: number
    kind: "registration" | "credential" | "revocation" | "verification" | "governance"
    message: string
    name: string
}

/** The newest thing any org reports, for the line above the flows; `null` before anything has
 *  happened. `at` is rendered as a relative time, so it travels raw rather than pre-formatted. */
export interface LiveLineState {
    name: string
    message: string
    at: number
}

export interface DashboardState {
    chain: ChainPanelState
    contracts: Record<string, Address>
    paymaster: PaymasterPanelState
    safe: SafePanelState
    bundler: BundlerPanelState
    members: MemberServerState[]
    stack: StackDescriptor
    activity: StackActivityEntry[]
    liveLine: LiveLineState | null
    /** Every org's own events in one feed; see {@link buildOrgActivity}. */
    orgActivity: OrgActivityEntry[]
    networkSetup: NetworkSetupState
    flows: FlowRow[]
}

/** The already-fetched chain and network reads `buildDashboardState` shapes into JSON: bigints
 *  turned into decimal strings, membership matched to `stack.members` by index. */
export interface DashboardInputs {
    stack: StackDescriptor
    chain: { blockNumber: bigint; chainId: number; rpcUrl: string }
    paymaster: {
        address: Address
        deposit: bigint
        maxCostPerOp: bigint
        operations: { hash: Hex; sender: Address; gasCost: bigint; success: boolean }[]
    }
    safe: {
        address: Address
        threshold: number
        owners: Address[]
        /** Parallel to `stack.members`: whether the registry approves that member. */
        approvals: boolean[]
        pendingJoinRequests: {
            networkId: Hex32
            semaphoreCommitment: bigint
            governanceSigner: Address
            metadataURI?: string
        }[]
    }
    bundler: {
        address: Address
        balance: bigint
        nonce: number
        recent: BundlerOperationSummary[]
    }
    /** Count of `IdentityRegistered` logs on the `IdentityRegistry` since the deploy block. */
    registrations: number
    /** `ApprovedIssuerSet.getSize()`. */
    issuerKeys: number
    members: MemberServerState[]
    activity: StackActivityEntry[]
}

function contractsTable(stack: StackDescriptor): Record<string, Address> {
    return {
        identityRegistry: stack.identityRegistry,
        announcer: stack.announcer,
        revocation: stack.revocation.address,
        semaphore: stack.semaphore,
        networkMemberRegistry: stack.networkMemberRegistry,
        networkMemberGroup: stack.networkMemberGroup,
        networkMemberGovernance: stack.networkMemberGovernance,
        approvedIssuerSet: stack.approvedIssuerSet,
        governanceSafe: stack.governanceSafe,
        entryPoint: stack.entryPoint,
        paymaster: stack.paymaster,
        accountImplementation: stack.accountImplementation
    }
}

/** The newest `at` among every member's `recentActivity` entries matching `predicate`, or `null`
 *  when none match. Each member's own `recentActivity` is only its last five entries, so a match
 *  older than that has already fallen out of the window and reads the same as no match at all. */
function newestActivityAt(members: MemberServerState[], predicate: (entry: ActivityExcerpt) => boolean): number | null {
    let newest: number | null = null
    for (const member of members) {
        for (const entry of member.status?.recentActivity ?? []) {
            if (predicate(entry) && (newest === null || entry.at > newest)) newest = entry.at
        }
    }
    return newest
}

/** Each member's own counts, summed; a member with no parsed status (`status: null`, whether
 *  unreachable or just an unparseable `/v1/status` read) contributes 0. */
function sumMemberCounts(members: MemberServerState[], pick: (status: MemberStatus) => number): number {
    return members.reduce((total, member) => total + (member.status ? pick(member.status) : 0), 0)
}

/** The five flow titles, in order: shared with `serve --check`'s own assertions, so the two can't
 *  drift. */
export const FLOW_TITLES = [
    "Onboard the user",
    "Verify and issue the credential",
    "Prove with the credential",
    "Revoke the credential",
    "Another org, same person"
] as const

/** The five spec flows, shaped once here so the page script only ever inserts strings. */
function buildFlows(inputs: DashboardInputs): FlowRow[] {
    const { registrations, members } = inputs
    const credentials = sumMemberCounts(members, (status) => status.counts.credentials)
    const verifications = sumMemberCounts(members, (status) => status.counts.verifications)
    const revocations = sumMemberCounts(members, (status) => status.counts.revocations)
    const existingRegistrations = sumMemberCounts(members, (status) => status.counts.existingRegistrations)
    // A count of rejected verifications has no notion of order, so a rejection for an unrelated
    // reason (a replayed request id, say) before any revocation would count the same as a proof
    // that actually failed because of one. Ask the ordering question instead: is the newest
    // rejected verification anywhere newer than the newest revocation anywhere.
    const newestRevocationAt = newestActivityAt(members, (entry) => entry.kind === "revocation")
    const newestRejectedVerificationAt = newestActivityAt(
        members,
        (entry) => entry.kind === "verification" && entry.message.startsWith("verification rejected:")
    )
    const provenAfterRevoke =
        newestRevocationAt !== null &&
        newestRejectedVerificationAt !== null &&
        newestRejectedVerificationAt > newestRevocationAt

    // Flow 5 is the second founder's own match and issue, so only its counts and activity decide
    // whether the row is done, not a network-wide sum.
    const secondFounder = members[1]
    const secondFounderCounts = secondFounder?.status?.counts
    const newestSecondFounderCredentialAt = secondFounder
        ? newestActivityAt(
              [secondFounder],
              (entry) => entry.kind === "credential" && entry.message === "issued a credential"
          )
        : null
    const newestSecondFounderExistingRegistrationAt = secondFounder
        ? newestActivityAt(
              [secondFounder],
              (entry) => entry.kind === "registration" && entry.message === "found an existing registration"
          )
        : null
    const secondFounderIssuedAfterMatching =
        newestSecondFounderCredentialAt !== null &&
        newestSecondFounderExistingRegistrationAt !== null &&
        newestSecondFounderCredentialAt > newestSecondFounderExistingRegistrationAt
    const secondFounderMatchedAndIssued =
        (secondFounderCounts?.existingRegistrations ?? 0) > 0 &&
        (secondFounderCounts?.credentials ?? 0) > 0 &&
        secondFounderIssuedAfterMatching

    const finished = [
        registrations > 0,
        credentials > 0,
        verifications > 0,
        // This row ends when the *next proof fails*, not on the revocation alone, so it needs the
        // newest rejected verification to be newer than the newest revocation rather than both
        // counts merely being positive.
        provenAfterRevoke,
        secondFounderMatchedAndIssued
    ]
    const unfinished = finished.indexOf(false)
    // Falls back to the last row once every step is done, so the live line always has a home.
    const current = unfinished === -1 ? finished.length - 1 : unfinished
    const stateOf = (index: number): FlowState => (finished[index] ? "done" : index === current ? "current" : "waiting")

    // Each count is the figure its own row's end condition tests, so the two cannot disagree.
    return [
        {
            number: 1,
            title: FLOW_TITLES[0],
            oneLiner: "The person creates an identity; Member A registers it on chain.",
            prompt: "Create the identity in the wallet, then tap Register in Member A.",
            state: stateOf(0),
            count: { value: registrations, noun: "registered" }
        },
        {
            number: 2,
            title: FLOW_TITLES[1],
            oneLiner: "Member A checks the person, then signs them a credential.",
            prompt: "Tap Issue in Member A, then approve it in the wallet.",
            state: stateOf(1),
            count: { value: credentials, noun: "issued" }
        },
        {
            number: 3,
            title: FLOW_TITLES[2],
            oneLiner: "Member B checks a zero-knowledge proof without learning the person's identity.",
            prompt: "Tap Check eligibility in Member B, then share the proof from the wallet.",
            state: stateOf(2),
            count: { value: verifications, noun: "verified" }
        },
        {
            number: 4,
            title: FLOW_TITLES[3],
            oneLiner: "Member A revokes the credential on chain; the next proof fails.",
            prompt: "Revoke it on the Orgs tab, then tap Check again in Member B.",
            state: stateOf(3),
            count: { value: revocations, noun: "revoked" }
        },
        {
            number: 5,
            title: FLOW_TITLES[4],
            oneLiner: "Member B matched the record and issued its own credential.",
            prompt: "Register the same person in Member B, then tap Issue.",
            state: stateOf(4),
            count: { value: existingRegistrations, noun: "matched" }
        }
    ]
}

/** What the old "Network membership" flow row carried, gathered once here the same way
 *  `buildFlows` gathers its own numbers. */
function buildNetworkSetup(inputs: DashboardInputs, safe: SafePanelState): NetworkSetupState {
    return {
        membersAdmitted: safe.members.filter((member) => member.approved).length,
        membersTotal: safe.members.length,
        issuerKeysPublished: inputs.issuerKeys,
        safeThreshold: safe.threshold,
        safeOwners: safe.owners,
        pendingJoinRequests: safe.pendingJoinRequests
    }
}

/**
 * Every org's own events in one feed, newest first, each named by the org that reported it. The
 * flow panel beside this carries one figure per step and no per-org breakdown, so this is where
 * "which org did what" is answered.
 *
 * Needs no cap of its own: `/v1/status` carries only each member's last five entries, so three
 * orgs give fifteen rows at most.
 */
function buildOrgActivity(members: MemberServerState[]): OrgActivityEntry[] {
    return members
        .flatMap((member) => (member.status?.recentActivity ?? []).map((entry) => ({ ...entry, name: member.name })))
        .sort((a, b) => b.at - a.at)
}

/** The newest entry across the orgs' `recentActivity` (each already newest first); `null` before
 *  any of them has reported anything. */
function buildLiveLine(members: MemberServerState[]): LiveLineState | null {
    let newest: LiveLineState | null = null
    for (const member of members) {
        const entry = member.status?.recentActivity[0]
        if (entry && (!newest || entry.at > newest.at))
            newest = { name: member.name, message: entry.message, at: entry.at }
    }
    return newest
}

/** Pure shaping: every chain and network read has already happened by the time this runs. */
export function buildDashboardState(inputs: DashboardInputs): DashboardState {
    const safe: SafePanelState = {
        address: inputs.safe.address,
        threshold: inputs.safe.threshold,
        owners: inputs.safe.owners,
        members: inputs.stack.members.map((member, index) => ({
            name: member.name,
            networkId: member.networkId,
            authAddress: member.authAddress,
            role: member.role,
            approved: inputs.safe.approvals[index] ?? false
        })),
        pendingJoinRequests: inputs.safe.pendingJoinRequests.map((request) => ({
            networkId: request.networkId,
            semaphoreCommitment: request.semaphoreCommitment.toString(),
            governanceSigner: request.governanceSigner,
            metadataURI: request.metadataURI ?? ""
        }))
    }

    return {
        chain: {
            blockNumber: inputs.chain.blockNumber.toString(),
            chainId: inputs.chain.chainId,
            rpcUrl: inputs.chain.rpcUrl
        },
        contracts: contractsTable(inputs.stack),
        paymaster: {
            address: inputs.paymaster.address,
            deposit: inputs.paymaster.deposit.toString(),
            maxCostPerOp: inputs.paymaster.maxCostPerOp.toString(),
            operations: inputs.paymaster.operations.map((operation) => ({
                ...operation,
                gasCost: operation.gasCost.toString()
            }))
        },
        safe,
        bundler: { ...inputs.bundler, balance: inputs.bundler.balance.toString() },
        members: inputs.members,
        stack: inputs.stack,
        activity: inputs.activity,
        liveLine: buildLiveLine(inputs.members),
        orgActivity: buildOrgActivity(inputs.members),
        networkSetup: buildNetworkSetup(inputs, safe),
        flows: buildFlows(inputs)
    }
}

/** GETs and validates one endpoint, `null` on anything short of a schema-matching 200 - an
 *  unreachable or malformed response becomes `null` rather than a thrown error. A 401 lands the
 *  same way, silently, so a member-side route has to be given `headers` here or its panel just
 *  empties. */
async function fetchValidated<T>(
    url: string,
    schema: z.ZodType<T>,
    headers?: Record<string, string>
): Promise<T | null> {
    return fetch(url, { headers })
        .then((response) => (response.status === 200 ? response.json() : null))
        .then((body) => (body === null ? null : (schema.safeParse(body).data ?? null)))
        .catch(() => null)
}

async function readMemberServer(member: StackMember, secrets: StackSecrets): Promise<MemberServerState> {
    const healthy = await fetch(`${member.serverUrl}/health`)
        .then((response) => response.status === 200)
        .catch(() => false)
    const status = await fetchValidated(`${member.serverUrl}/v1/status`, MEMBER_STATUS_SCHEMA)
    const credentials =
        (
            await fetchValidated(
                `${member.serverUrl}/v1/credentials`,
                CREDENTIALS_SCHEMA,
                memberServerHeaders(secrets, member)
            )
        )?.credentials ?? null
    return { name: member.name, url: member.serverUrl, healthy, status, credentials }
}

/** viem types every indexed log argument as possibly `undefined` (some events hash a dynamic
 *  indexed type instead of storing it raw); `UserOperationEvent`'s are all static, so a decode
 *  always fills them, and a missing one means the ABI fragment above drifted from the real event. */
function requireLogField<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new Error(`log is missing ${field}`)
    return value
}

export interface GatherDashboardStateDeps {
    stack: StackDescriptor
    /** Org tokens for the Orgs tab's credential-list read. */
    secrets: StackSecrets
    publicClient: PublicClient
    /** The governance contracts' own deploy block, so join-request and sponsored-operation logs
     *  never scan before it. */
    deployBlock: bigint
    /** Caps the block span of each `eth_getLogs`, for RPC providers that limit it. */
    logWindowBlocks?: bigint
    /** Blocks the log scans trail the head by, out of reorg reach. Unset follows the head. */
    logConfirmations?: bigint
    bundler: Bundler
    activity: StackActivityLog
}

function createLogIndexes({
    stack,
    publicClient,
    deployBlock,
    logWindowBlocks,
    logConfirmations
}: GatherDashboardStateDeps) {
    const index = <TLog>(fetch: (from: bigint, to: bigint) => Promise<TLog[]>) =>
        new EventLogIndex({
            fromBlock: deployBlock,
            windowBlocks: logWindowBlocks,
            confirmations: logConfirmations,
            fetch
        })
    return {
        operations: index((fromBlock, toBlock) =>
            publicClient.getLogs({
                address: stack.entryPoint,
                event: USER_OPERATION_EVENT,
                args: { paymaster: stack.paymaster },
                fromBlock,
                toBlock
            })
        ),
        joinRequests: index(async (fromBlock, toBlock) => {
            const logs = await publicClient.getLogs({
                address: stack.networkMemberRegistry,
                event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
                fromBlock,
                toBlock
            })
            return logs.map((log) => decodeJoinRequestLog(log, stack.networkMemberRegistry))
        }),
        identityRegistrations: index((fromBlock, toBlock) =>
            publicClient.getLogs({ address: stack.identityRegistry, event: IDENTITY_REGISTERED, fromBlock, toBlock })
        )
    }
}

type DashboardLogIndexes = ReturnType<typeof createLogIndexes>

/**
 * A refresh function that holds the log indexes across calls, so each refresh reads only
 * the blocks added since the last one. Hold one for the stack's lifetime.
 */
export function createDashboardGatherer(deps: GatherDashboardStateDeps): () => Promise<DashboardState> {
    const indexes = createLogIndexes(deps)
    return () => gatherDashboardState(deps, indexes)
}

/** Everything `buildDashboardState` needs, read live from the chain, the bundler, and the member
 *  servers. */
async function gatherDashboardState(
    { stack, secrets, publicClient, bundler, activity }: GatherDashboardStateDeps,
    indexes: DashboardLogIndexes
): Promise<DashboardState> {
    const [blockNumber, deposit, maxCostPerOp, threshold, owners, issuerKeys] = await Promise.all([
        publicClient.getBlockNumber({ cacheTime: 0 }),
        publicClient.readContract({ address: stack.paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" }),
        publicClient.readContract({
            address: stack.paymaster,
            abi: PAYMASTER_ABI,
            functionName: "MAX_COST_PER_OP"
        }),
        publicClient.readContract({
            address: stack.governanceSafe,
            abi: SAFE_READ_ABI,
            functionName: "getThreshold"
        }),
        publicClient.readContract({ address: stack.governanceSafe, abi: SAFE_READ_ABI, functionName: "getOwners" }),
        publicClient.readContract({
            address: stack.approvedIssuerSet,
            abi: ISSUER_SET_ABI,
            functionName: "getSize"
        })
    ])

    const [operationLogs, approvals, allJoinRequests, identityRegisteredLogs, bundlerBalance, bundlerNonce, members] =
        await Promise.all([
            indexes.operations.sync(blockNumber),
            Promise.all(
                stack.members.map((member) =>
                    publicClient.readContract({
                        address: stack.networkMemberRegistry,
                        abi: REGISTRY_ABI,
                        functionName: "isApproved",
                        args: [member.networkId]
                    })
                )
            ),
            indexes.joinRequests.sync(blockNumber),
            indexes.identityRegistrations.sync(blockNumber),
            publicClient.getBalance({ address: bundler.address }),
            publicClient.getTransactionCount({ address: bundler.address }),
            Promise.all(stack.members.map((member) => readMemberServer(member, secrets)))
        ])

    // A candidate may publish several requests before admission; the latest one is the live one.
    const latestJoinRequests = new Map<Hex, NetworkMemberJoinRequest>()
    for (const request of allJoinRequests) latestJoinRequests.set(request.memberNetworkId, request)
    const joinRequests = [...latestJoinRequests.values()]
    const joinRequestApprovals = await Promise.all(
        joinRequests.map((request) =>
            publicClient.readContract({
                address: stack.networkMemberRegistry,
                abi: REGISTRY_ABI,
                functionName: "isApproved",
                args: [request.memberNetworkId]
            })
        )
    )

    return buildDashboardState({
        stack,
        chain: { blockNumber, chainId: stack.chainId, rpcUrl: stack.rpcUrl },
        paymaster: {
            address: stack.paymaster,
            deposit,
            maxCostPerOp,
            operations: operationLogs.map((log) => ({
                hash: requireLogField(log.args.userOpHash, "userOpHash"),
                sender: requireLogField(log.args.sender, "sender"),
                gasCost: requireLogField(log.args.actualGasCost, "actualGasCost"),
                success: requireLogField(log.args.success, "success")
            }))
        },
        safe: {
            address: stack.governanceSafe,
            threshold: Number(threshold),
            owners: [...owners],
            approvals,
            pendingJoinRequests: joinRequests
                .filter((_request, index) => !joinRequestApprovals[index])
                .map((request) => ({
                    networkId: request.memberNetworkId,
                    semaphoreCommitment: request.semaphoreCommitment,
                    governanceSigner: request.governanceSigner,
                    metadataURI: request.metadataURI
                }))
        },
        bundler: { address: bundler.address, balance: bundlerBalance, nonce: bundlerNonce, recent: bundler.recent() },
        registrations: identityRegisteredLogs.length,
        issuerKeys: Number(issuerKeys),
        members,
        activity: activity.recent()
    })
}

/** The counts a poll compares against the one before it, to point at the tab where something just
 *  happened. Verifications are missing on purpose: the Flow tab is already on screen for those. */
export interface HintCounts {
    sponsoredOperations: number
    pendingJoinRequests: number
    membersAdmitted: number
    credentials: number
    revocations: number
}

export interface TabHint {
    tab: string
    text: string
}

export function hintCounts(state: DashboardState): HintCounts {
    return {
        sponsoredOperations: state.paymaster.operations.length,
        pendingJoinRequests: state.networkSetup.pendingJoinRequests.length,
        membersAdmitted: state.networkSetup.membersAdmitted,
        credentials: sumMemberCounts(state.members, (status) => status.counts.credentials),
        revocations: sumMemberCounts(state.members, (status) => status.counts.revocations)
    }
}

/** The one hint a poll earns, or none. Ordered rarest first, so an admission or a revocation wins
 *  over the sponsored operation that any flow racks up. Mirrored by `pollingScript`'s own copy. */
export function hintBetween(previous: HintCounts, next: HintCounts): TabHint | null {
    if (next.pendingJoinRequests > previous.pendingJoinRequests) return { tab: "network", text: "An org asked to join" }
    if (next.membersAdmitted > previous.membersAdmitted) return { tab: "network", text: "Org admitted" }
    if (next.revocations > previous.revocations) return { tab: "orgs", text: "Credential revoked" }
    if (next.credentials > previous.credentials) return { tab: "orgs", text: "Credential issued" }
    if (next.sponsoredOperations > previous.sponsoredOperations) return { tab: "chain", text: "Gas sponsored" }
    return null
}

/** A step's state, as the three things that draw it: its marker, its word, and the word's tone. */
const FLOW_STATE: Record<FlowState, { mark: string; label: string; tone: BadgeTone }> = {
    done: { mark: "✓", label: "Done", tone: "success" },
    current: { mark: "▸", label: "Now", tone: "warning" },
    waiting: { mark: "·", label: "Waiting", tone: "default" }
}

/** `live` is {@link liveLineText}'s output: already escaped, and only drawn on the current row. */
function flowRowHtml(row: FlowRow, live: string): string {
    const { mark, label, tone } = FLOW_STATE[row.state]
    const here =
        row.state === "current"
            ? `<p class="flow-live">${live}</p><p class="flow-next">${escapeHtml(row.prompt)}</p>`
            : ""
    return (
        `<div class="flow-row flow-${row.state}">` +
        `<span class="flow-mark" aria-hidden="true">${mark}</span>` +
        `<div><p class="flow-title">${row.number}. ${escapeHtml(row.title)}</p>` +
        `<p class="flow-line">${escapeHtml(row.oneLiner)}</p></div>` +
        `<div class="flow-aside">${badge(label, tone)}` +
        `<p class="flow-stat"><span class="flow-figure">${row.count.value}</span>` +
        `<span class="flow-noun">${escapeHtml(row.count.noun)}</span></p></div>` +
        here +
        `</div>`
    )
}

/**
 * The Flow tab's whole story, and the tab's main visual. The newest event hangs off the current
 * step, with the one instruction that advances it, so there is a single place to look rather than
 * two panels to join up.
 */
function flowsPanel(state: DashboardState): Panel {
    const live = liveLineText(state.liveLine)
    return { id: "flows", title: "Flow", body: state.flows.map((row) => flowRowHtml(row, live)).join("") }
}

/** This member's own index into `state.stack.members`, the way every `/api/orgs/:index/...`
 *  proxy route addresses it; every other member array here (`safe.members`, `MemberServerState[]`)
 *  is already parallel to `stack.members` by construction. */
function founderIndices(state: DashboardState): number[] {
    return state.stack.members.flatMap((member, index) => (member.role === "founder" ? [index] : []))
}

/** A member has asked nothing yet once it is neither approved nor among the pending join
 *  requests; those two states already get their own row. */
function membersWithNoRequestYet(state: DashboardState): number[] {
    const pending = new Set(state.networkSetup.pendingJoinRequests.map((request) => request.networkId))
    return state.stack.members
        .map((member, index) => ({ member, index }))
        .filter(({ member, index }) => !state.safe.members[index]?.approved && !pending.has(member.networkId))
        .map(({ index }) => index)
}

/** Joins already-built `<li>` markup as-is, unlike `list` (imported from `template.ts`), which
 *  escapes each item as plain text — these rows carry a button, not a string to escape. */
function htmlList(items: string[]): string {
    return items.length > 0 ? `<ul class="plain">${items.join("")}</ul>` : `<p class="empty">None yet.</p>`
}

function requestToJoinRow(state: DashboardState, index: number): string {
    const label = actionButton("Request to join", "request-to-join", { index: String(index) })
    return `<li>${escapeHtml(state.stack.members[index].name)} ${label}</li>`
}

function pendingRequestRow(state: DashboardState, request: PendingJoinRequestState, founders: number[]): string {
    const admitButtons = founders
        .map((index) =>
            actionButton(`Admit as ${state.stack.members[index].name}`, "admit", {
                index: String(index),
                "network-id": request.networkId
            })
        )
        .join(" ")
    return `<li>${escapeHtml(request.networkId)} — signer ${escapeHtml(request.governanceSigner)} ${admitButtons}</li>`
}

function networkSetupPanel(state: DashboardState): Panel {
    const { networkSetup } = state
    const founders = founderIndices(state)
    const body =
        keyValueTable([
            ["Orgs admitted", `${networkSetup.membersAdmitted} of ${networkSetup.membersTotal}`],
            ["Issuer keys published", String(networkSetup.issuerKeysPublished)],
            ["Governance Safe", `threshold ${networkSetup.safeThreshold} of ${networkSetup.safeOwners.length} owner(s)`]
        ]) +
        `<p class="kv-label" style="margin:12px 0 4px">Not yet asked</p>` +
        htmlList(membersWithNoRequestYet(state).map((index) => requestToJoinRow(state, index))) +
        `<p class="kv-label" style="margin:12px 0 4px">Pending join requests</p>` +
        htmlList(networkSetup.pendingJoinRequests.map((request) => pendingRequestRow(state, request, founders)))
    return { id: "network-setup", title: "Network setup", body }
}

/** The first 8 characters of a credential id, once its `urn:uuid:` prefix is stripped — enough to
 *  tell rows apart without printing the whole thing next to a Revoke button. */
function shortCredentialId(id: string): string {
    return id.replace(/^urn:uuid:/, "").slice(0, 8)
}

function credentialRowHtml(orgIndex: number, credential: CredentialSummary): string {
    const statusBadge = credential.revoked ? badge("revoked", "danger") : badge("valid", "success")
    const revoke = credential.revoked
        ? ""
        : ` ${actionButton("Revoke", "revoke", { index: String(orgIndex), "credential-id": credential.id })}`
    return `<li>${escapeHtml(shortCredentialId(credential.id))} — ${escapeHtml(credential.programme)} · ${escapeHtml(credential.country)} ${statusBadge}${revoke}</li>`
}

const MEMBERSHIP_TONE: Record<MemberStatus["membership"]["status"], BadgeTone> = {
    approved: "success",
    requested: "warning",
    none: "default"
}

/** Whether this org's server answered at all, and whether what it answered with parsed: a healthy
 *  server whose `/v1/status` didn't parse reads differently from one that never answered. */
function orgHealthBadge(server: MemberServerState | undefined): string {
    if (!server?.healthy) return badge("unreachable", "danger")
    return server.status === null ? badge("status unreadable", "warning") : badge("healthy", "success")
}

function orgCountsLine(status: MemberStatus): string {
    const { counts } = status
    return `${counts.registrations} registered · ${counts.credentials} issued · ${counts.revocations} revoked · ${counts.verifications} verified`
}

/** One card per org, left-bordered in its own brand colour: whether its server is up, whether the
 *  network admitted it, what it has done, what it has issued, and a way through to its own page. */
function orgCardHtml(state: DashboardState, index: number): string {
    const member = state.stack.members[index]
    const server = state.members[index]
    const status = server?.status
    const credentials = server?.credentials ?? []
    const rows =
        credentials.length > 0
            ? `<ul class="plain">${credentials.map((credential) => credentialRowHtml(index, credential)).join("")}</ul>`
            : `<p class="empty">None yet.</p>`
    return (
        `<div class="org-card" style="--org-accent:${escapeHtml(member.brand.accent)}">` +
        `<p style="margin:0 0 4px"><strong>${escapeHtml(member.name)}</strong> ${orgHealthBadge(server)}` +
        `${status ? ` ${badge(status.membership.status, MEMBERSHIP_TONE[status.membership.status])}` : ""}</p>` +
        `${status ? `<p class="kv-label" style="margin:0 0 6px">${escapeHtml(orgCountsLine(status))}</p>` : ""}` +
        `${rows}<p style="margin:6px 0 0"><a href="${escapeHtml(member.serverUrl)}">Status page</a></p></div>`
    )
}

function orgsPanel(state: DashboardState): Panel {
    const body = state.stack.members.map((_member, index) => orgCardHtml(state, index)).join("")
    return { id: "orgs", title: "Orgs", body }
}

/** "just now" under a minute, then whole minutes and hours; the demo runs minutes at a time, so
 *  nothing coarser than an hour is worth showing. */
function relativeTime(at: number, now: number): string {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000)
    if (minutes < 1) return "just now"
    if (minutes < 60) return `${minutes} min ago`
    return `${Math.floor(minutes / 60)} hr ago`
}

/** Escaped inner text, not a paragraph: the current flow row wraps it (see {@link flowRowHtml}).
 *  Formatted here rather than in `buildFlows` so the relative time is fresh on every poll. */
function liveLineText(liveLine: LiveLineState | null): string {
    if (!liveLine) return "Nothing has happened yet."
    return `${escapeHtml(liveLine.name)}: ${escapeHtml(liveLine.message)} — ${relativeTime(liveLine.at, Date.now())}`
}

/** Wraps a technical panel's content in a closed `<details>`, so the page leads with the story
 *  instead of addresses and wei balances. */
function folded(caption: string, content: string): string {
    return `<details><summary>${escapeHtml(caption)}</summary>${content}</details>`
}

function chainPanel(state: DashboardState): Panel {
    const body = keyValueTable([
        ["Block number", state.chain.blockNumber],
        ["Chain ID", String(state.chain.chainId)],
        ["RPC URL", state.chain.rpcUrl]
    ])
    return { id: "chain", title: "Chain", body: folded("The chain this stack runs against.", body) }
}

function contractsPanel(state: DashboardState): Panel {
    const body = keyValueTable(Object.entries(state.contracts))
    return {
        id: "contracts",
        title: "Contracts",
        body: folded("Every contract address the stack deployed.", body)
    }
}

function paymasterOperationLine(operation: PaymasterOperationState): string {
    return `${operation.hash} — sender ${operation.sender}, gas ${operation.gasCost}, ${operation.success ? "success" : "failed"}`
}

function paymasterPanel(state: DashboardState): Panel {
    const { paymaster } = state
    const body =
        keyValueTable([
            ["Address", paymaster.address],
            ["Deposit", paymaster.deposit],
            ["Max cost per op", paymaster.maxCostPerOp]
        ]) +
        `<p class="kv-label" style="margin:12px 0 4px">Sponsored operations</p>` +
        list(paymaster.operations.map(paymasterOperationLine))
    return {
        id: "paymaster",
        title: "Paymaster",
        body: folded("Sponsors gas, so nobody pays to register or prove.", body)
    }
}

function safePanel(state: DashboardState): Panel {
    const { safe } = state
    const body =
        keyValueTable([
            ["Address", safe.address],
            ["Threshold", String(safe.threshold)]
        ]) +
        `<p class="kv-label" style="margin:12px 0 4px">Orgs</p>` +
        list(
            safe.members.map(
                (member) => `${member.name} (${member.role}) — ${member.approved ? "approved" : "not approved"}`
            )
        ) +
        `<p class="kv-label" style="margin:12px 0 4px">Pending join requests</p>` +
        list(safe.pendingJoinRequests.map((request) => `${request.networkId} — signer ${request.governanceSigner}`))
    return {
        id: "safe",
        title: "Governance Safe",
        body: folded("The multisig that admits orgs to the network.", body)
    }
}

function bundlerOperationLine(operation: BundlerOperationSummary): string {
    const status = operation.success === null ? "pending" : operation.success ? "success" : "failed"
    return `${operation.userOpHash} — sender ${operation.sender}, ${status}`
}

function bundlerPanel(state: DashboardState): Panel {
    const { bundler } = state
    const body =
        keyValueTable([
            ["Address", bundler.address],
            ["Balance", bundler.balance],
            ["Nonce", String(bundler.nonce)]
        ]) +
        `<p class="kv-label" style="margin:12px 0 4px">Recent operations</p>` +
        list(bundler.recent.map(bundlerOperationLine))
    return { id: "bundler", title: "Bundler", body: folded("Submits sponsored operations to the chain.", body) }
}

function stackPanel(state: DashboardState): Panel {
    // The QR stays open: scanning it is how a phone joins this stack.
    const body =
        `<p class="caption">Scan this with the wallet to point it at this stack. Member apps pair ` +
        `from their own pairing QR, printed in the terminal running yarn stack.</p>` +
        `<img src="/stack.svg" alt="stack.json QR code">` +
        folded("What the QR carries.", `<pre>${escapeHtml(JSON.stringify(state.stack, null, 2))}</pre>`)
    return { id: "stack", title: "Stack descriptor", body }
}

function activityLine(entry: StackActivityEntry): string {
    return `${new Date(entry.at).toLocaleTimeString()} — [${entry.kind}] ${entry.message}`
}

/** How many of the stack's own entries the panel shows. The ring behind it holds a hundred, which
 *  is far more than a panel beside the flow can carry without stretching it. */
const STACK_ACTIVITY_SHOWN = 15

function feedHtml(rows: string[]): string {
    return rows.length > 0 ? `<ul class="feed">${rows.join("")}</ul>` : `<p class="empty">None yet.</p>`
}

function orgActivityRow(entry: OrgActivityEntry): string {
    return (
        `<li><span class="feed-at">${escapeHtml(new Date(entry.at).toLocaleTimeString())}</span>` +
        `<strong>${escapeHtml(entry.name)}</strong> ${escapeHtml(entry.message)}</li>`
    )
}

/**
 * The reference beside the flow: what the orgs did, then what the stack itself did. Two feeds in
 * one panel because they answer different questions - the first is the demo, the second is the
 * plumbing.
 */
function activityPanel(state: DashboardState): Panel {
    return {
        id: "activity",
        title: "Recent activity",
        body:
            feedHtml(state.orgActivity.map(orgActivityRow)) +
            `<p class="feed-split">The stack itself</p>` +
            feedHtml(
                state.activity
                    .slice(0, STACK_ACTIVITY_SHOWN)
                    .map((entry) => `<li>${escapeHtml(activityLine(entry))}</li>`)
            )
    }
}

/** The vanilla script the page ships: polls `/api/state` every 2s and rewrites the panels whose
 *  content changes over time. `contracts` and `stack` never change once the stack is up, so they
 *  render once at load and are left alone here. A folded panel's open/closed state is read off the
 *  DOM before its body is replaced and restored after, so a presenter's click survives the poll. */
function pollingScript(): string {
    return `
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
function kv(rows) { return "<table class=\\"kv\\">" + rows.map(function (r) { return "<tr><td class=\\"kv-label\\">" + esc(r[0]) + "</td><td class=\\"kv-value\\">" + esc(r[1]) + "</td></tr>"; }).join("") + "</table>"; }
function listHtml(items) { return items.length ? "<ul class=\\"plain\\">" + items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" : "<p class=\\"empty\\">None yet.</p>"; }
function rawListHtml(items) { return items.length ? "<ul class=\\"plain\\">" + items.join("") + "</ul>" : "<p class=\\"empty\\">None yet.</p>"; }
function badgeClass(tone) { return tone === "success" ? "badge-success" : tone === "accent" ? "badge-warning" : tone === "danger" ? "badge-danger" : "badge-default"; }
// Mirrors flowRowHtml/flowsPanel above, by hand, as every renderer in this script does: the TS
// copy serves GET / and this one patches the panel on every poll. Drift here shows up as a page
// that looks right on load and wrong two seconds later.
var FLOW_STATE = { done: { mark: "\u2713", label: "Done", tone: "success" }, current: { mark: "\u25b8", label: "Now", tone: "warning" }, waiting: { mark: "\u00b7", label: "Waiting", tone: "default" } };
function flowsHtml(rows, liveLine) { var live = liveLineText(liveLine); return rows.map(function (row) { var st = FLOW_STATE[row.state]; var here = row.state === "current" ? "<p class=\\"flow-live\\">" + live + "</p><p class=\\"flow-next\\">" + esc(row.prompt) + "</p>" : ""; return "<div class=\\"flow-row flow-" + esc(row.state) + "\\"><span class=\\"flow-mark\\" aria-hidden=\\"true\\">" + st.mark + "</span><div><p class=\\"flow-title\\">" + row.number + ". " + esc(row.title) + "</p><p class=\\"flow-line\\">" + esc(row.oneLiner) + "</p></div><div class=\\"flow-aside\\"><span class=\\"badge badge-" + st.tone + "\\">" + st.label + "</span><p class=\\"flow-stat\\"><span class=\\"flow-figure\\">" + row.count.value + "</span><span class=\\"flow-noun\\">" + esc(row.count.noun) + "</span></p></div>" + here + "</div>"; }).join(""); }
function feedHtml(rows) { return rows.length ? "<ul class=\\"feed\\">" + rows.join("") + "</ul>" : "<p class=\\"empty\\">None yet.</p>"; }
function activityHtml(state) { var orgs = state.orgActivity.map(function (e) { return "<li><span class=\\"feed-at\\">" + esc(new Date(e.at).toLocaleTimeString()) + "</span><strong>" + esc(e.name) + "</strong> " + esc(e.message) + "</li>"; }); var stack = state.activity.slice(0, 15).map(function (e) { return "<li>" + esc(new Date(e.at).toLocaleTimeString() + " \u2014 [" + e.kind + "] " + e.message) + "</li>"; }); return feedHtml(orgs) + "<p class=\\"feed-split\\">The stack itself</p>" + feedHtml(stack); }
// Set for the duration of a proxy POST, so a poll landing mid-request re-renders every button
// disabled too, not just the one clicked (page.ts's status page follows the same pattern).
var inFlight = false;
function actionButtonHtml(label, action, dataAttrs) {
    var attrs = "";
    for (var key in dataAttrs) { attrs += " data-" + key + "=\\"" + esc(dataAttrs[key]) + "\\""; }
    return "<button type=\\"button\\" data-action=\\"" + esc(action) + "\\"" + attrs + (inFlight ? " disabled" : "") + ">" + esc(label) + "</button>";
}
function founderIndices(state) { var out = []; state.stack.members.forEach(function (m, i) { if (m.role === "founder") out.push(i); }); return out; }
function membersWithNoRequestYet(state) {
    var pending = {};
    state.networkSetup.pendingJoinRequests.forEach(function (r) { pending[r.networkId] = true; });
    var out = [];
    state.stack.members.forEach(function (m, i) { if (!(state.safe.members[i] && state.safe.members[i].approved) && !pending[m.networkId]) out.push(i); });
    return out;
}
function requestToJoinRow(state, index) { return "<li>" + esc(state.stack.members[index].name) + " " + actionButtonHtml("Request to join", "request-to-join", { index: String(index) }) + "</li>"; }
function pendingRequestRow(state, request, founders) {
    var admitButtons = founders.map(function (index) { return actionButtonHtml("Admit as " + state.stack.members[index].name, "admit", { index: String(index), "network-id": request.networkId }); }).join(" ");
    return "<li>" + esc(request.networkId) + " — signer " + esc(request.governanceSigner) + " " + admitButtons + "</li>";
}
function networkSetupHtml(state) {
    var s = state.networkSetup;
    var founders = founderIndices(state);
    return kv([["Orgs admitted", s.membersAdmitted + " of " + s.membersTotal], ["Issuer keys published", s.issuerKeysPublished], ["Governance Safe", "threshold " + s.safeThreshold + " of " + s.safeOwners.length + " owner(s)"]])
        + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Not yet asked</p>"
        + rawListHtml(membersWithNoRequestYet(state).map(function (index) { return requestToJoinRow(state, index); }))
        + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Pending join requests</p>"
        + rawListHtml(s.pendingJoinRequests.map(function (r) { return pendingRequestRow(state, r, founders); }));
}
function shortCredentialId(id) { return id.replace(/^urn:uuid:/, "").slice(0, 8); }
function credentialRowHtml(orgIndex, credential) {
    var statusBadge = "<span class=\\"badge " + (credential.revoked ? "badge-danger" : "badge-success") + "\\">" + (credential.revoked ? "revoked" : "valid") + "</span>";
    var revoke = credential.revoked ? "" : (" " + actionButtonHtml("Revoke", "revoke", { index: String(orgIndex), "credential-id": credential.id }));
    return "<li>" + esc(shortCredentialId(credential.id)) + " — " + esc(credential.programme) + " · " + esc(credential.country) + " " + statusBadge + revoke + "</li>";
}
function orgHealthBadgeHtml(server) {
    if (!server || !server.healthy) return "<span class=\\"badge badge-danger\\">unreachable</span>";
    return server.status === null ? "<span class=\\"badge badge-warning\\">status unreadable</span>" : "<span class=\\"badge badge-success\\">healthy</span>";
}
function membershipBadgeHtml(status) {
    var tone = status === "approved" ? "badge-success" : status === "requested" ? "badge-warning" : "badge-default";
    return "<span class=\\"badge " + tone + "\\">" + esc(status) + "</span>";
}
function orgCountsLine(status) {
    var c = status.counts;
    return c.registrations + " registered · " + c.credentials + " issued · " + c.revocations + " revoked · " + c.verifications + " verified";
}
function orgCardHtml(state, index) {
    var member = state.stack.members[index];
    var server = state.members[index];
    var status = server && server.status;
    var credentials = (server && server.credentials) || [];
    var rows = credentials.length ? ("<ul class=\\"plain\\">" + credentials.map(function (c) { return credentialRowHtml(index, c); }).join("") + "</ul>") : "<p class=\\"empty\\">None yet.</p>";
    return "<div class=\\"org-card\\" style=\\"--org-accent:" + esc(member.brand.accent) + "\\">"
        + "<p style=\\"margin:0 0 4px\\"><strong>" + esc(member.name) + "</strong> " + orgHealthBadgeHtml(server) + (status ? " " + membershipBadgeHtml(status.membership.status) : "") + "</p>"
        + (status ? "<p class=\\"kv-label\\" style=\\"margin:0 0 6px\\">" + esc(orgCountsLine(status)) + "</p>" : "")
        + rows + "<p style=\\"margin:6px 0 0\\"><a href=\\"" + esc(member.serverUrl) + "\\">Status page</a></p></div>";
}
function orgsHtml(state) { return state.stack.members.map(function (_m, index) { return orgCardHtml(state, index); }).join(""); }
function hintCounts(state) {
    var credentials = 0;
    var revocations = 0;
    state.members.forEach(function (m) { if (m.status) { credentials += m.status.counts.credentials; revocations += m.status.counts.revocations; } });
    return {
        sponsoredOperations: state.paymaster.operations.length,
        pendingJoinRequests: state.networkSetup.pendingJoinRequests.length,
        membersAdmitted: state.networkSetup.membersAdmitted,
        credentials: credentials,
        revocations: revocations
    };
}
function hintBetween(previous, next) {
    if (next.pendingJoinRequests > previous.pendingJoinRequests) return { tab: "network", text: "An org asked to join" };
    if (next.membersAdmitted > previous.membersAdmitted) return { tab: "network", text: "Org admitted" };
    if (next.revocations > previous.revocations) return { tab: "orgs", text: "Credential revoked" };
    if (next.credentials > previous.credentials) return { tab: "orgs", text: "Credential issued" };
    if (next.sponsoredOperations > previous.sponsoredOperations) return { tab: "chain", text: "Gas sponsored" };
    return null;
}
function relativeTime(at, now) { var minutes = Math.floor(Math.max(0, now - at) / 60000); if (minutes < 1) return "just now"; if (minutes < 60) return minutes + " min ago"; return Math.floor(minutes / 60) + " hr ago"; }
function liveLineText(liveLine) { return liveLine ? esc(liveLine.name) + ": " + esc(liveLine.message) + " — " + relativeTime(liveLine.at, Date.now()) : "Nothing has happened yet."; }
function folded(caption, content) { return "<details><summary>" + esc(caption) + "</summary>" + content + "</details>"; }
function setBody(id, html) {
    var el = document.getElementById("panel-body-" + id);
    if (!el) return;
    var wasOpen = !!el.querySelector("details") && el.querySelector("details").open;
    el.innerHTML = html;
    var details = el.querySelector("details");
    if (details && wasOpen) details.open = true;
}
// null until the first poll lands: a hint reads a delta, and the first state has nothing to
// differ from, so a page opened mid-demo doesn't pop five hints at once.
var lastHintCounts = null;
async function refresh() {
    try {
        var state = await (await fetch("/api/state")).json();
        var counts = hintCounts(state);
        var hint = lastHintCounts ? hintBetween(lastHintCounts, counts) : null;
        lastHintCounts = counts;
        if (hint) showHint(hint.tab, hint.text);
        setBody("network-setup", networkSetupHtml(state));
        setBody("flows", flowsHtml(state.flows, state.liveLine));
        setBody("orgs", orgsHtml(state));
        setBody("chain", folded("The chain this stack runs against.", kv([["Block number", state.chain.blockNumber], ["Chain ID", state.chain.chainId], ["RPC URL", state.chain.rpcUrl]])));
        setBody("paymaster", folded("Sponsors gas, so nobody pays to register or prove.", kv([["Address", state.paymaster.address], ["Deposit", state.paymaster.deposit], ["Max cost per op", state.paymaster.maxCostPerOp]]) + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Sponsored operations</p>" + listHtml(state.paymaster.operations.map(function (op) { return op.hash + " — sender " + op.sender + ", gas " + op.gasCost + ", " + (op.success ? "success" : "failed"); }))));
        setBody("safe", folded("The multisig that admits orgs to the network.", kv([["Address", state.safe.address], ["Threshold", state.safe.threshold]]) + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Orgs</p>" + listHtml(state.safe.members.map(function (m) { return m.name + " (" + m.role + ") — " + (m.approved ? "approved" : "not approved"); })) + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Pending join requests</p>" + listHtml(state.safe.pendingJoinRequests.map(function (r) { return r.networkId + " — signer " + r.governanceSigner; }))));
        setBody("bundler", folded("Submits sponsored operations to the chain.", kv([["Address", state.bundler.address], ["Balance", state.bundler.balance], ["Nonce", state.bundler.nonce]]) + "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Recent operations</p>" + listHtml(state.bundler.recent.map(function (op) { return op.userOpHash + " — sender " + op.sender + ", " + (op.success === null ? "pending" : op.success ? "success" : "failed"); }))));
        setBody("activity", activityHtml(state));
    } catch (err) {
        console.error("dashboard refresh failed", err);
    }
}
// The relay needs the per-run dashboard key, taken from the operator link's fragment or asked for once.
(function () {
    var match = /(?:^#|&)key=([0-9a-f]+)/.exec(location.hash);
    if (!match) return;
    try { sessionStorage.setItem("cn.dashboardKey", match[1]); } catch (err) { /* asked on the first click instead */ }
    history.replaceState(null, "", location.pathname + location.search);
})();
function heldKey() { try { return sessionStorage.getItem("cn.dashboardKey") || ""; } catch (err) { return ""; } }
function forgetKey() { try { sessionStorage.removeItem("cn.dashboardKey"); } catch (err) { /* nothing held */ } }
function askKey() {
    var value = (window.prompt("Dashboard key (in the stack.secrets.json yarn stack printed the path of)") || "").trim();
    if (value) { try { sessionStorage.setItem("cn.dashboardKey", value); } catch (err) { /* asked again next click */ } }
    return value;
}
document.addEventListener("click", async function (event) {
    var button = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!button || inFlight) return;
    var action = button.getAttribute("data-action");
    var index = button.getAttribute("data-index");
    if (index === null) return;
    inFlight = true;
    document.querySelectorAll("[data-action]").forEach(function (b) { b.disabled = true; });
    try {
        var body = "{}";
        if (action === "admit") body = JSON.stringify({ networkId: button.getAttribute("data-network-id") });
        if (action === "revoke") body = JSON.stringify({ credentialId: button.getAttribute("data-credential-id") });
        var key = heldKey() || askKey();
        if (!key) return;
        var res = await fetch("/api/orgs/" + index + "/" + action, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: body });
        if (res.status === 401) forgetKey();
    } catch (err) {
        console.error("dashboard action failed", err);
    } finally {
        inFlight = false;
    }
    refresh();
});
refresh();
setInterval(refresh, 2000);
`
}

/** The five tabs, in the order a room reads them: what is happening, who it is happening to, who
 *  is on the network, what carries it, and how to join with a phone. `hintBetween` above names
 *  these same keys. */
const TABS: Tab[] = [
    {
        key: "flow",
        label: "Flow",
        intro: "Five steps. The highlighted one is where the demo is.",
        panelIds: ["flows", "activity"],
        // The flow leads; the feed beside it is the reference for anyone who wants the detail.
        layout: "lead"
    },
    {
        key: "orgs",
        label: "Orgs",
        intro: "Each organisation on the network, and what it has issued.",
        panelIds: ["orgs"]
    },
    {
        key: "network",
        label: "Network",
        intro: "Who is admitted, and who is waiting.",
        panelIds: ["network-setup", "safe"]
    },
    {
        key: "chain",
        label: "Chain",
        intro: "The contracts and the account that pays the gas.",
        panelIds: ["chain", "contracts", "paymaster", "bundler"]
    },
    { key: "connect", label: "Connect", intro: "Point a phone here to join.", panelIds: ["stack"] }
]

/** Builds the dashboard's HTML page: five tabs over the live line and the spec flows, the orgs
 *  and what each has issued, the network's own setup, the folded technical panels, and the QR a
 *  phone scans to join. */
export function renderDashboardPage(state: DashboardState): string {
    return renderPage({
        title: "Coordination Network stack",
        subtitle: state.chain.rpcUrl,
        panels: [
            networkSetupPanel(state),
            flowsPanel(state),
            orgsPanel(state),
            chainPanel(state),
            contractsPanel(state),
            paymasterPanel(state),
            safePanel(state),
            bundlerPanel(state),
            stackPanel(state),
            activityPanel(state)
        ],
        tabs: TABS,
        tabScope: "dashboard",
        script: tabsScript() + pollingScript()
    })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify(body))
}

function sendHtml(response: ServerResponse, html: string): void {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(html)
}

function sendSvg(response: ServerResponse, svg: string): void {
    response.writeHead(200, { "content-type": "image/svg+xml" })
    response.end(svg)
}

function sendServerError(response: ServerResponse, error: unknown): void {
    // The message can embed the provider's keyed URL, and this answers anyone who can reach the dashboard.
    console.error(redactUrls(error instanceof Error ? error.message : String(error)))
    sendJson(response, 500, { error: "internal error" })
}

/** This server listens on every interface, so what it will buffer for one request is bounded;
 *  every action below sends a handful of fields. */
const MAX_BODY_BYTES = 64 * 1024

class BodyTooLargeError extends Error {}

/** A cross-origin form can't send application/json, so requiring it blocks cross-site admit or revoke. */
function isJson(request: IncomingMessage): boolean {
    return (request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json"
}

/** Buffers a request body and parses it as JSON; an empty body resolves to `undefined` rather
 *  than throwing, since three of the five proxied actions below carry no fields of their own. */
function readJsonBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = ""
        let size = 0
        request.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                // Buffering stops here; the caller answers 413 and drops the rest.
                request.pause()
                reject(new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`))
                return
            }
            raw += chunk
        })
        request.on("end", () => {
            if (!raw) {
                resolve(undefined)
                return
            }
            try {
                resolve(JSON.parse(raw))
            } catch (error) {
                reject(error)
            }
        })
        request.on("error", reject)
    })
}

/** What `POST /v1/credentials` hands out (see issuer-service's routes/credentials.ts), and so the
 *  only shape of id the revoke proxy builds a path from. */
const CREDENTIAL_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREDENTIAL_ID_EXAMPLE = "urn:uuid:<uuid>"

/** Every proxied action but `revoke`, whose target route takes the credential id as a path
 *  segment rather than a body field (handled separately below). */
const ORG_ACTION_ROUTE: Record<string, string> = {
    "request-to-join": GOVERNANCE_ROUTES.requestToJoin,
    admit: GOVERNANCE_ROUTES.admit,
    "register-identity": GOVERNANCE_ROUTES.registerIdentity,
    "publish-issuer-key": GOVERNANCE_ROUTES.publishIssuerKey
}

const ORG_ACTION_PATH = /^\/api\/orgs\/(\d+)\/(request-to-join|admit|register-identity|publish-issuer-key|revoke)$/
const ORG_CREDENTIALS_PATH = /^\/api\/orgs\/(\d+)\/credentials$/

/** `:index`, already digits-only per the two patterns above; still parsed and range-checked
 *  explicitly rather than trusted, so a huge or leading-zero digit string can't produce a
 *  surprising array index. Anything outside `[0, stack.members.length)` is the caller's 404. */
function memberAtIndex(stack: StackDescriptor, raw: string): StackMember | undefined {
    const index = Number.parseInt(raw, 10)
    if (!Number.isInteger(index) || index < 0 || index >= stack.members.length) return undefined
    return stack.members[index]
}

/** Relays one write to that member's `<path>`, forwarding `body` and the upstream status and JSON
 *  body verbatim. This is the only way the dashboard's own browser reaches an org server: none of
 *  them sets up CORS, so a direct fetch from the page would fail silently. */
async function proxyToMember(
    response: ServerResponse,
    member: StackMember,
    secrets: StackSecrets,
    path: string,
    body?: unknown
): Promise<void> {
    const upstream = await fetch(`${member.serverUrl}${path}`, {
        method: "POST",
        headers: {
            ...memberServerHeaders(secrets, member),
            ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    sendJson(response, upstream.status, await upstream.json().catch(() => ({})))
}

export interface StartDashboardOptions {
    stack: StackDescriptor
    /** Org tokens and the relay key, which no route serves. */
    secrets: StackSecrets
    getState(): Promise<DashboardState>
    host?: string
    port?: number
    /** How long one gathered state serves every request. 0 gathers on each request. */
    stateTtlMs?: number
}

export interface Dashboard {
    url: string
    close(): Promise<void>
}

/**
 * Serves the dashboard: `GET /` (HTML), `GET /api/state` (JSON), `GET /stack.json` (the
 * descriptor), `GET /stack.svg` (a QR code of `<dashboardUrl>/stack.json`).
 */
export async function startDashboard({
    stack,
    secrets,
    getState,
    host = "0.0.0.0",
    port = 8080,
    stateTtlMs = 0
}: StartDashboardOptions): Promise<Dashboard> {
    let cached: { at: number; state: Promise<DashboardState> } | undefined
    const readState = (): Promise<DashboardState> => {
        if (stateTtlMs === 0) return getState()
        if (cached && Date.now() - cached.at < stateTtlMs) return cached.state
        const state = getState()
        const entry = { at: Date.now(), state }
        cached = entry
        // A failed gather must not be replayed to every request for the rest of the window.
        state.catch(() => {
            if (cached === entry) cached = undefined
        })
        return state
    }
    const server = createServer((request, response) => {
        // Before any route: a rebinding page reaches this listener under a DNS name of its own, and
        // the relay holds every org's member server token.
        if (refuseForeignHost(request, response)) return

        const url = new URL(request.url ?? "/", "http://localhost")

        if (request.method === "GET" && url.pathname === "/") {
            readState()
                .then((state) => sendHtml(response, renderDashboardPage(state)))
                .catch((error: unknown) => sendServerError(response, error))
            return
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
            readState()
                .then((state) => sendJson(response, 200, state))
                .catch((error: unknown) => sendServerError(response, error))
            return
        }
        if (request.method === "GET" && url.pathname === "/stack.json") {
            sendJson(response, 200, stack)
            return
        }
        if (request.method === "GET" && url.pathname === "/stack.svg") {
            qrCodeToString(`${stack.dashboardUrl}/stack.json`, { type: "svg" })
                .then((svg) => sendSvg(response, svg))
                .catch((error: unknown) => sendServerError(response, error))
            return
        }

        // Checked first, so a caller without the key learns nothing, not even the org count.
        if (
            url.pathname.startsWith("/api/orgs/") &&
            !hasDashboardKey(request.headers.authorization, secrets.dashboardKey)
        ) {
            sendJson(response, 401, { error: "dashboard key required", code: "UNAUTHORIZED" })
            return
        }

        const orgAction = request.method === "POST" ? url.pathname.match(ORG_ACTION_PATH) : null
        if (orgAction) {
            if (!isJson(request)) {
                sendJson(response, 415, { error: "content-type must be application/json" })
                return
            }
            const member = memberAtIndex(stack, orgAction[1])
            if (!member) {
                sendJson(response, 404, { error: "no such org" })
                return
            }
            const action = orgAction[2]
            readJsonBody(request)
                .then((body) => {
                    if (action === "revoke") {
                        const credentialId = (body as { credentialId?: unknown } | undefined)?.credentialId
                        if (typeof credentialId !== "string" || !CREDENTIAL_ID.test(credentialId)) {
                            sendJson(response, 400, { error: `credentialId must look like ${CREDENTIAL_ID_EXAMPLE}` })
                            return undefined
                        }
                        // Only an id the org server itself issues gets this far: encodeURIComponent
                        // leaves a dot alone, so ".." would otherwise reach the upstream as one
                        // path segment that its server then resolves away.
                        return proxyToMember(
                            response,
                            member,
                            secrets,
                            `/v1/credentials/${encodeURIComponent(credentialId)}/revoke`
                        )
                    }
                    return proxyToMember(response, member, secrets, ORG_ACTION_ROUTE[action], body)
                })
                .catch((error: unknown) => {
                    if (!(error instanceof BodyTooLargeError)) {
                        sendServerError(response, error)
                        return
                    }
                    sendJson(response, 413, { error: error.message })
                    // Only once the answer is out: destroying the request takes the socket with it.
                    response.once("finish", () => request.destroy())
                })
            return
        }

        const orgCredentials = request.method === "GET" ? url.pathname.match(ORG_CREDENTIALS_PATH) : null
        if (orgCredentials) {
            const member = memberAtIndex(stack, orgCredentials[1])
            if (!member) {
                sendJson(response, 404, { error: "no such org" })
                return
            }
            fetch(`${member.serverUrl}/v1/credentials`, { headers: memberServerHeaders(secrets, member) })
                .then(async (upstream) => sendJson(response, upstream.status, await upstream.json().catch(() => ({}))))
                .catch((error: unknown) => sendServerError(response, error))
            return
        }

        response.writeHead(404).end("Not found")
    })

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
    })
    const bound = server.address()
    if (!bound || typeof bound === "string") throw new Error("dashboard server did not bind to a port")

    return {
        url: `http://127.0.0.1:${bound.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
}
