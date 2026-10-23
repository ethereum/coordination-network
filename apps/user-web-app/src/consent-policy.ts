import type { Wallet } from "@coordination-network/wallet"

type StatusWallet = Pick<Wallet, "syncRevocations" | "listCredentials">

export type PresentationConsentDecision = "prompt" | "deny"

/** Known-invalid approvals are denied; an unavailable status check must never bypass the prompt. */
export async function presentationConsentDecision(wallet: StatusWallet): Promise<PresentationConsentDecision> {
    try {
        await wallet.syncRevocations()
        return (await wallet.listCredentials()).some(({ status }) => status === "valid") ? "prompt" : "deny"
    } catch {
        return "prompt"
    }
}
