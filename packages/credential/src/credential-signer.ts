import { Identity } from "@semaphore-protocol/identity"
import { EddsaPublicKey, EddsaSignature } from "./types"

export interface CredentialSigner {
    getPublicKey(): Promise<EddsaPublicKey>
    sign(message: bigint): Promise<EddsaSignature>
}

export class LocalCredentialSigner implements CredentialSigner {
    private readonly identity: Identity

    constructor(secret: string | Uint8Array) {
        this.identity = new Identity(secret)
    }

    async getPublicKey(): Promise<EddsaPublicKey> {
        return [this.identity.publicKey[0], this.identity.publicKey[1]]
    }

    async sign(message: bigint): Promise<EddsaSignature> {
        const signature = this.identity.signMessage(message)
        return { R8: [signature.R8[0], signature.R8[1]], S: signature.S }
    }
}
