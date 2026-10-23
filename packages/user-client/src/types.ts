import { DerivedKeys } from "@coordination-network/identity"

export type Hex = `0x${string}`

/** The registry deployment the consent is bound to. */
export interface ChainDomain {
    chainId: number
    verifyingContract: Hex
}

export interface RegistrationRequest {
    version: "v1"
    networkId: Hex
    schemeId: 1
    metaStealthAddress: Hex
    chainId: number
    verifyingContract: Hex
    /** EIP-712 consent over the request, checked by the member server. */
    signature: Hex
}

export interface SubmissionReceipt {
    /** Null when the submitter queued the registration rather than broadcasting it itself. */
    txHash: Hex | null
}

export interface RegistryReader {
    /**
     * The 66-byte entry, or null when the networkId is unregistered. IdentityRegistry stores the
     * mapping as `bytes`, so a chain-backed reader must map its empty-bytes answer to null.
     */
    getIdentity(networkId: Hex): Promise<Hex | null>
}

/** Hands the signed request to the network member's server, which submits it on chain. */
export interface RegistrationSubmitter {
    submit(request: RegistrationRequest): Promise<SubmissionReceipt>
}

export interface Onboarding {
    keys: DerivedKeys
    networkId: Hex
    metaStealthAddress: Hex
    displayMetaStealthAddress: string
}

export interface RegisterParams {
    deviceSecret: Uint8Array | Hex
    registry: RegistryReader
    submitter: RegistrationSubmitter
    domain: ChainDomain
}

export type RegisterResult =
    | {
          /** Submitted, not confirmed: `register` returns as soon as the submitter accepts. */
          status: "registered"
          networkId: Hex
          metaStealthAddress: Hex
          request: RegistrationRequest
          receipt: SubmissionReceipt
      }
    | {
          status: "alreadyRegistered"
          networkId: Hex
          /** What the registry currently resolves to; a network member can change it via updateIdentity/removeIdentity. */
          metaStealthAddress: Hex
          /** What this device secret derives today. */
          derivedMetaStealthAddress: Hex
          matchesDerived: boolean
      }
