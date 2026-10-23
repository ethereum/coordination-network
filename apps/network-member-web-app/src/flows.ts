import {
    signedRegistrationRequestSchema,
    type RegistrationSignResult,
    type LinkClient
} from "@coordination-network/user-app-link"
import type { MemberPolicy } from "./business/policy"
import type { BusinessHooks } from "./business/hooks"

export interface MemberConfig {
    name: string
    networkId: `0x${string}`
    serverUrl: string
    appOrigin?: string
    scheme?: string
    approved?: boolean
    memberServerToken: string
}
export interface StackConfig {
    chainId: number
    identityRegistry: `0x${string}`
    apps?: { user: { origin: string }; relay: { url: string } }
    members: Omit<MemberConfig, "memberServerToken">[]
}
export interface FlowState {
    identity?: RegistrationSignResult["request"]
    credentialId?: string
}

async function requestJson(fetcher: typeof fetch, url: string, init?: RequestInit) {
    const response = await fetcher(url, init)
    const body = await response.json()
    if (!response.ok) throw new Error((body as { error?: string }).error ?? `${url} returned ${response.status}`)
    return body as Record<string, unknown>
}

export function createMemberFlows(options: {
    member: MemberConfig
    stack: StackConfig
    link: LinkClient
    policy: MemberPolicy
    hooks: BusinessHooks
    fetcher?: typeof fetch
    registrationStore?: Pick<Storage, "getItem" | "setItem">
}) {
    const { member, stack, link, policy, hooks } = options
    const fetcher = options.fetcher ?? fetch
    const state: FlowState = {}
    const registrationKey = `coordination-registration:${stack.chainId}:${stack.identityRegistry.toLowerCase()}:${member.networkId.toLowerCase()}:${new URL(member.serverUrl).origin}`
    try {
        const saved = options.registrationStore?.getItem(registrationKey)
        const parsed = signedRegistrationRequestSchema.safeParse(saved ? JSON.parse(saved) : undefined)
        if (
            parsed.success &&
            parsed.data.chainId === stack.chainId &&
            parsed.data.verifyingContract.toLowerCase() === stack.identityRegistry.toLowerCase()
        ) {
            state.identity = parsed.data
        }
    } catch {
        // An unavailable or stale tab cache does not prevent a fresh registration.
    }
    const post = (path: string, body: unknown, authenticated = false) =>
        requestJson(fetcher, `${member.serverUrl}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(authenticated ? { authorization: `Bearer ${member.memberServerToken}` } : {})
            },
            body: JSON.stringify(body)
        })
    return {
        state,
        async enrol() {
            const registration = await link.request("registration.sign", {
                chainId: stack.chainId,
                verifyingContract: stack.identityRegistry
            })
            if (!(await policy.decideEnrolment(registration.request.networkId)))
                throw new Error("business policy refused enrolment")
            const result = await post("/v1/registrations", registration.request, true)
            state.identity = registration.request
            try {
                options.registrationStore?.setItem(registrationKey, JSON.stringify(registration.request))
            } catch {
                // Registration succeeded even when the browser cannot save tab state.
            }
            hooks.onEvent("enrolment", result)
            return { result }
        },
        async issue() {
            if (!state.identity) throw new Error("register a wallet before issuing a credential")
            const scope = await policy.decideIssuance(state.identity.networkId)
            if (!scope) throw new Error("business policy refused issuance")
            const result = await link.request("credential.issue", {
                issuerNetworkId: member.networkId,
                approvalScope: scope,
                challengeUrl: `${member.serverUrl}/v1/challenge`,
                credentialsUrl: `${member.serverUrl}/v1/credentials`,
                issuersUrl: `${member.serverUrl}/v1/issuers`,
                revocationsUrl: `${member.serverUrl}/v1/revocations/snapshot`
            })
            if (result.status === "refused") throw new Error(result.message)
            state.credentialId = result.credentialId
            hooks.onEvent("issuance", { id: result.credentialId })
            return { id: result.credentialId }
        },
        async verify() {
            const scope = await policy.decideIssuance(state.identity?.networkId ?? member.networkId)
            if (!scope) throw new Error("business policy refused verification")
            const request = await post("/v1/presentation-requests", scope)
            const result = await link.request("presentation.create", {
                requestId: String(request.requestId),
                challenge: request.challenge as `0x${string}`,
                audience: String(request.audience),
                currentTime: Number(request.currentTime),
                ...scope,
                issuersUrl: `${member.serverUrl}/v1/issuers`,
                revocationsUrl: `${member.serverUrl}/v1/revocations/snapshot`,
                responseUrl: `${member.serverUrl}/v1/verify`
            })
            if (!result.verificationId) throw new Error("verification did not return a record")
            const record = await requestJson(
                fetcher,
                `${member.serverUrl}/v1/verifications/${encodeURIComponent(result.verificationId)}`,
                { headers: { authorization: `Bearer ${member.memberServerToken}` } }
            )
            if (record.requestId !== request.requestId)
                throw new Error("verification record belongs to another request")
            if (record.ok !== true) throw new Error(String(record.code ?? "verification failed"))
            hooks.onEvent("verification", record)
            return { result, record }
        },
        async revoke() {
            if (!state.credentialId) throw new Error("issue a credential before revoking")
            const result = await post(
                `/v1/credentials/${encodeURIComponent(state.credentialId)}/revoke`,
                undefined,
                true
            )
            hooks.onEvent("revocation", result)
            return result
        }
    }
}
