import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
    buildAdmissionTransaction,
    checkQuorum,
    decodeJoinRequestLog,
    encodeAdmitMember,
    encodeApproveHash,
    encodeExecTransaction,
    encodeExitNetwork,
    encodeRequestToJoin,
    hashSafeTransaction,
    memberAccountKey,
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    onChainApproval,
    type NetworkMemberJoinRequest
} from "@coordination-network/network-member-governance"
import type { AdmissionPorts, AdmissionStatus } from "../../issuer-service/src/types"
import type { NetworkMemberDeployment } from "../../registry-demo/scripts/deploy/network-member.js"
import { TESTBED_CHAIN } from "./config"
import type { Chain } from "./anvil"

const SAFE_ABI = [
    { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    {
        type: "function",
        name: "getOwners",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address[]" }]
    },
    {
        type: "function",
        name: "getThreshold",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    }
] as const
const MEMBER_REGISTRY_ABI = [
    {
        type: "function",
        name: "isApproved",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "bool" }]
    }
] as const
const ISSUER_SET_ABI = [
    {
        type: "function",
        name: "issuerSetRoot",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "issuerKeysOf",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "uint256[]" }]
    }
] as const

export async function ensureIssuerKeyPublished(options: {
    isPublished: () => Promise<boolean>
    publish: () => Promise<void>
}): Promise<void> {
    if (!(await options.isPublished())) await options.publish()
    if (!(await options.isPublished())) throw new Error("candidate issuer key was not published")
}

export interface AdmissionMember {
    name: string
    networkId: `0x${string}`
    semaphoreCommitment: bigint
    walletPrivateKey: `0x${string}`
    governancePrivateKey: `0x${string}`
    governanceSigner: Address
    approved: boolean
}

export interface AdmissionCoordinator {
    forMember(name: string): AdmissionPorts
    issuerRoot(): Promise<bigint>
}

export function createAdmissionCoordinator(options: {
    chain: Chain
    deployment: NetworkMemberDeployment
    members: AdmissionMember[]
    candidateName: string
    publishCandidateKey: () => Promise<void>
}): AdmissionCoordinator {
    const { chain, deployment, members, candidateName, publishCandidateKey } = options
    const candidate = members.find(({ name }) => name === candidateName)
    if (!candidate) throw new Error(`unknown admission candidate ${candidateName}`)
    let request: NetworkMemberJoinRequest | undefined
    let departed = false
    let earlyCompletionBlocked = false
    let outdatedDecisionBlocked = false
    const approvals = new Map<string, Address>()
    let pendingAdmissionApproval: { name: string; signer: Address } | undefined
    let queue = Promise.resolve()

    const send = async (privateKey: `0x${string}`, to: Address, data: Hex) => {
        const hash = await chain.walletClient.sendTransaction({
            account: privateKeyToAccount(privateKey),
            chain: TESTBED_CHAIN,
            to,
            data
        })
        const receipt = await chain.publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== "success") throw new Error(`governance transaction ${hash} reverted`)
        return receipt
    }

    const safeState = async () => {
        const [nonce, owners, threshold] = await Promise.all([
            chain.publicClient.readContract({ address: deployment.safe, abi: SAFE_ABI, functionName: "nonce" }),
            chain.publicClient.readContract({ address: deployment.safe, abi: SAFE_ABI, functionName: "getOwners" }),
            chain.publicClient.readContract({ address: deployment.safe, abi: SAFE_ABI, functionName: "getThreshold" })
        ])
        return { nonce: Number(nonce), owners: [...owners], threshold: Number(threshold) }
    }

    const issuerRoot = () =>
        chain.publicClient.readContract({
            address: deployment.issuerSet,
            abi: ISSUER_SET_ABI,
            functionName: "issuerSetRoot"
        })

    const candidateKeyPublished = async () =>
        (
            await chain.publicClient.readContract({
                address: deployment.issuerSet,
                abi: ISSUER_SET_ABI,
                functionName: "issuerKeysOf",
                args: [candidate.networkId]
            })
        ).length > 0

    const markAdmissionComplete = () => {
        candidate.approved = true
        if (pendingAdmissionApproval) {
            approvals.set(pendingAdmissionApproval.name, pendingAdmissionApproval.signer)
            pendingAdmissionApproval = undefined
        }
    }

    const finishAdmission = async () => {
        await ensureIssuerKeyPublished({ isPublished: candidateKeyPublished, publish: publishCandidateKey })
        markAdmissionComplete()
    }

    const isAdmitted = () =>
        chain.publicClient.readContract({
            address: deployment.registry,
            abi: MEMBER_REGISTRY_ABI,
            functionName: "isApproved",
            args: [candidate.networkId]
        })

    const statusFor = async (actor: AdmissionMember): Promise<AdmissionStatus> => {
        const [{ threshold }, admitted, root, keyPublished] = await Promise.all([
            safeState(),
            isAdmitted(),
            issuerRoot(),
            candidateKeyPublished()
        ])
        const admissionComplete = admitted && keyPublished
        if (admissionComplete) markAdmissionComplete()
        const hasApproved = approvals.has(actor.name)
        return {
            candidateName: candidate.name,
            profileUrl: request?.metadataURI,
            state: admissionComplete ? "admitted" : departed ? "departed" : request ? "pending" : "not-requested",
            approvals: [...approvals.keys()],
            threshold,
            canRequest: actor.name === candidate.name && !request && !admissionComplete,
            canApprove:
                actor.approved &&
                actor.name !== candidate.name &&
                Boolean(request) &&
                !admissionComplete &&
                !hasApproved,
            canLeave: actor.name === candidate.name && admissionComplete,
            hasApproved,
            issuerRoot: root.toString(),
            earlyCompletionBlocked,
            outdatedDecisionBlocked
        }
    }

    const requestMembership = async (actor: AdmissionMember): Promise<AdmissionStatus> => {
        if (actor.name !== candidate.name) throw new Error("only the candidate can request membership")
        if (await isAdmitted()) return statusFor(actor)
        if (request) return statusFor(actor)

        const accountKey = memberAccountKey(privateKeyToAccount(candidate.walletPrivateKey).publicKey)
        const announced: NetworkMemberJoinRequest = {
            ...accountKey,
            semaphoreCommitment: candidate.semaphoreCommitment,
            governanceSigner: candidate.governanceSigner,
            metadataURI: `https://example.invalid/${candidate.name}/membership.json`
        }
        const receipt = await send(candidate.walletPrivateKey, deployment.registry, encodeRequestToJoin(announced))
        const [log] = await chain.publicClient.getLogs({
            address: deployment.registry,
            event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
            args: { memberNetworkId: accountKey.memberNetworkId },
            fromBlock: receipt.blockNumber,
            toBlock: receipt.blockNumber
        })
        if (!log) throw new Error("membership request event was not found")
        request = decodeJoinRequestLog(log, deployment.registry)

        const { owners } = await safeState()
        try {
            await chain.publicClient.call({
                account: deployment.safe,
                to: deployment.governance,
                data: encodeAdmitMember(request, owners.length + 1)
            })
        } catch {
            outdatedDecisionBlocked = true
        }
        if (!outdatedDecisionBlocked) throw new Error("an outdated membership decision was not refused")
        return statusFor(actor)
    }

    const approveMembership = async (actor: AdmissionMember): Promise<AdmissionStatus> => {
        if (!request) throw new Error("the candidate has not requested membership")
        if (!actor.approved || actor.name === candidate.name) throw new Error("this operator cannot approve membership")
        if (await isAdmitted()) {
            if (!candidate.approved || !(await candidateKeyPublished())) await finishAdmission()
            return statusFor(actor)
        }
        if (approvals.has(actor.name)) return statusFor(actor)

        const { nonce, owners, threshold } = await safeState()
        const transaction = buildAdmissionTransaction(
            { governance: deployment.governance, registry: deployment.registry },
            request,
            deployment.context,
            nonce,
            owners.length
        )
        const safeTxHash = hashSafeTransaction(deployment.context, transaction)
        await send(actor.governancePrivateKey, deployment.safe, encodeApproveHash(deployment.context, safeTxHash))

        const proposedApprovals = new Map(approvals).set(actor.name, actor.governanceSigner)
        const quorum = checkQuorum(owners, threshold, [...proposedApprovals.values()])
        if (quorum.hasQuorum) {
            await send(
                actor.governancePrivateKey,
                deployment.safe,
                encodeExecTransaction(
                    deployment.context,
                    transaction,
                    quorum.signers.map((signer) => onChainApproval(signer))
                )
            )
            pendingAdmissionApproval = { name: actor.name, signer: actor.governanceSigner }
            await finishAdmission()
        } else {
            try {
                await send(
                    actor.governancePrivateKey,
                    deployment.safe,
                    encodeExecTransaction(
                        deployment.context,
                        transaction,
                        [...proposedApprovals.values()].map((signer) => onChainApproval(signer))
                    )
                )
            } catch {
                earlyCompletionBlocked = true
            }
            if (!earlyCompletionBlocked) throw new Error("membership completed without enough approvals")
            approvals.set(actor.name, actor.governanceSigner)
        }
        return statusFor(actor)
    }

    const leaveNetwork = async (actor: AdmissionMember): Promise<AdmissionStatus> => {
        if (actor.name !== candidate.name) throw new Error("only the member can leave the network")
        if (!(await isAdmitted())) return statusFor(actor)

        const { rebuildGroupFromChain, siblingsFor } =
            await import("../../registry-demo/scripts/shared/semaphore-group.js")
        const group = await rebuildGroupFromChain(deployment)
        await send(
            candidate.governancePrivateKey,
            deployment.governance,
            encodeExitNetwork(candidate.networkId, siblingsFor(group, candidate.semaphoreCommitment))
        )
        candidate.approved = false
        departed = true
        return statusFor(actor)
    }

    return {
        issuerRoot,
        forMember(name) {
            const actor = members.find((member) => member.name === name)
            if (!actor) throw new Error(`unknown admission actor ${name}`)
            return {
                status: () => statusFor(actor),
                request: () => requestMembership(actor),
                approve: () => {
                    const result = queue.then(() => approveMembership(actor))
                    queue = result.then(
                        () => undefined,
                        () => undefined
                    )
                    return result
                },
                leave: () => leaveNetwork(actor)
            }
        }
    }
}
