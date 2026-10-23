import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { deriveAccountKeypair, generateDeviceSecret } from "@coordination-network/identity"
import { Identity } from "@semaphore-protocol/identity"
import { hexToBytes, isHex, size } from "viem"

const NETWORK_MEMBER_ENV_FILE = "network-member.env"
const MEMBER_IDENTITY_SECRET_BYTES = 32
const UNCOMPRESSED_PUBLIC_KEY_PREFIX = "0x04"

if (!existsSync(NETWORK_MEMBER_ENV_FILE)) {
    writeFileSync(NETWORK_MEMBER_ENV_FILE, `MEMBER_IDENTITY_SECRET=${generateDeviceSecret()}\n`)
}

const networkMemberEnvFile = readFileSync(NETWORK_MEMBER_ENV_FILE, "utf8")
const memberIdentitySecret = parseEnv(networkMemberEnvFile).MEMBER_IDENTITY_SECRET
if (!isHex(memberIdentitySecret) || size(memberIdentitySecret) !== MEMBER_IDENTITY_SECRET_BYTES) {
    throw new Error(`MEMBER_IDENTITY_SECRET must be ${MEMBER_IDENTITY_SECRET_BYTES} bytes of 0x-prefixed hex`)
}

const uncompressedAccountPublicKey = deriveAccountKeypair(memberIdentitySecret).uncompressedPublicKey
const memberAccountPublicKey = `0x${uncompressedAccountPublicKey.slice(UNCOMPRESSED_PUBLIC_KEY_PREFIX.length)}`
const networkMemberCommitment = new Identity(hexToBytes(memberIdentitySecret)).commitment

process.stdout.write(`MEMBER_ACCOUNT_PUBLIC_KEY=${memberAccountPublicKey}\n`)
process.stdout.write(`NETWORK_MEMBER_COMMITMENT=${networkMemberCommitment}\n`)
