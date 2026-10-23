import type { Address } from "viem"

export { OperationType } from "@safe-global/types-kit"
export type { MetaTransactionData, SafeSignature, SafeTransactionData, SafeVersion } from "@safe-global/types-kit"

/**
 * Which Safe, on which chain, a transaction is bound to.
 *
 * `safeVersion` selects the encoding: Safe changed both the EIP-712 domain and
 * the `SafeTx` struct across versions, so a digest computed for the wrong version
 * is silently wrong. It defaults to the SDK's default version; read the Safe's
 * own `VERSION()` and pass it when governing an older deployment.
 */
export interface SafeContext {
    /** The governance Safe's address. */
    safeAddress: Address
    /** The chain the Safe is deployed on. */
    chainId: number | bigint
    /** The Safe's contract version. Defaults to the SDK's default. */
    safeVersion?: import("@safe-global/types-kit").SafeVersion
    /**
     * MultiSendCallOnly to batch through. Defaults to the canonical deployment
     * for this chain and Safe version, from `@safe-global/safe-deployments`. Pass
     * one only for a chain where that deployment is missing.
     */
    multiSend?: Address
}

/** The result of checking a signature set against a Safe's owners. */
export interface QuorumCheck {
    /** Whether the set is enough for the Safe to execute. */
    hasQuorum: boolean
    /** The distinct owners that signed, sorted ascending. */
    signers: Address[]
    /** How many more owner signatures are needed. Zero once quorum is met. */
    missing: number
}
