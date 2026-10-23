import { keccak_256 } from "@noble/hashes/sha3"
import { utf8ToBytes } from "@noble/hashes/utils"
import { ChainDomain, Hex } from "./types"
import { UserClientError } from "./errors"
import { hexToBytes, bytesToHex, concatBytes, numberToWord, addressToWord } from "./bytes"
import {
    REGISTER_IDENTITY_TYPE,
    EIP712_DOMAIN_TYPE,
    IDENTITY_REGISTRY_DOMAIN_NAME,
    IDENTITY_REGISTRY_DOMAIN_VERSION,
    NETWORK_ID_LENGTH,
    SCHEME_ID
} from "./constants"

const EIP712_DOMAIN_TYPEHASH = keccak_256(utf8ToBytes(EIP712_DOMAIN_TYPE))
const REGISTER_IDENTITY_TYPEHASH = keccak_256(utf8ToBytes(REGISTER_IDENTITY_TYPE))

/** Every input is already a 32-byte word, so concatenating them is what abi.encode would emit. */
function hashEncodedWords(...words: Uint8Array[]): Uint8Array {
    return keccak_256(concatBytes(...words))
}

export function identityRegistryDomainSeparator(domain: ChainDomain): Hex {
    const nameHash = keccak_256(utf8ToBytes(IDENTITY_REGISTRY_DOMAIN_NAME))
    const versionHash = keccak_256(utf8ToBytes(IDENTITY_REGISTRY_DOMAIN_VERSION))
    return bytesToHex(
        hashEncodedWords(
            EIP712_DOMAIN_TYPEHASH,
            nameHash,
            versionHash,
            numberToWord(domain.chainId),
            addressToWord(domain.verifyingContract)
        )
    )
}

export function registerIdentityStructHash(networkId: Hex, metaStealthAddress: Hex): Hex {
    const networkIdWord = hexToBytes(networkId)
    if (networkIdWord.length !== NETWORK_ID_LENGTH) {
        throw new UserClientError(
            "INVALID_INPUT",
            `Expected a ${NETWORK_ID_LENGTH}-byte networkId, got ${networkIdWord.length} bytes`
        )
    }
    const metaHash = keccak_256(hexToBytes(metaStealthAddress))
    return bytesToHex(hashEncodedWords(REGISTER_IDENTITY_TYPEHASH, networkIdWord, numberToWord(SCHEME_ID), metaHash))
}

/**
 * The digest the user signs as consent to register this meta-stealth address at this registry on
 * this chain. The member server verifies it before submitting; the contract never reads it.
 */
export function registerIdentityDigest(domain: ChainDomain, networkId: Hex, metaStealthAddress: Hex): Hex {
    const domainSeparator = hexToBytes(identityRegistryDomainSeparator(domain))
    const structHash = hexToBytes(registerIdentityStructHash(networkId, metaStealthAddress))
    return bytesToHex(keccak_256(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash)))
}
