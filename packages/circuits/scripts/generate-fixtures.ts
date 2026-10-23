import { p256 } from "@noble/curves/nist.js"
import { hexToBytes } from "@noble/hashes/utils"
import { Identity } from "@semaphore-protocol/identity"
import { poseidon3 } from "poseidon-lite/poseidon3"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { poseidon5 } from "poseidon-lite/poseidon5"
import { keccak256, stringToHex } from "viem"
import { ApprovedIssuerSet, ISSUER_SET_MAX_DEPTH } from "../../issuer-set/src"
import { RevocationRegistry } from "../../revocation-registry/src"
import { writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const REVOCATION_MAX_DEPTH = 20
const CREDENTIAL_DOMAIN = 363566488821926773809509531830640889725124777157045803797738936823559174026n
const PRESENTATION_DOMAIN = 47717037732995119958831198142288202228464361330145547649000821135537239485n
const DEVICE_KEY_DOMAIN = 320507632879070882430325612169297945123468706597652794395401074724051126576n

const DEVICE_PRIVATE_KEY = hexToBytes("09".repeat(32))
const HOLDER_SECRET = hexToBytes("0d".repeat(32))
const REVOCATION_SECRET = hexToBytes("0a".repeat(32))
const CHALLENGE = hexToBytes("0c".repeat(31))
const VALID_AT = 1_760_000_000

const stringToField = (value: string): bigint => BigInt(keccak256(stringToHex(value))) >> 8n
const bytesToBigint = (value: Uint8Array): bigint => BigInt(`0x${Buffer.from(value).toString("hex")}`)
const fieldToBytes = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, "0"))
const countryCode = (country: string): bigint =>
    BigInt([...country].reduce((value, character) => (value << 8) | character.charCodeAt(0), 0))

const coordinateLimbs = (coordinate: Uint8Array): [bigint, bigint] => [
    bytesToBigint(coordinate.slice(0, 16)),
    bytesToBigint(coordinate.slice(16, 32))
]

const toToml = (value: string | string[] | boolean[]) =>
    Array.isArray(value)
        ? `[${value.map((item) => (typeof item === "boolean" ? item : `"${item}"`)).join(", ")}]`
        : `"${value}"`

function padPath(leafIndex: number, siblings: bigint[], maxDepth: number) {
    const depth = siblings.length
    return {
        depth: depth.toString(),
        indices: [
            ...Array.from({ length: depth }, (_, i) => ((leafIndex >> i) & 1) === 1),
            ...Array(maxDepth - depth).fill(false)
        ] as boolean[],
        siblings: [...siblings, ...Array(maxDepth - depth).fill(0n)].map(String)
    }
}

async function main() {
    const issuer = new Identity("cn-fixture-issuer")
    const otherIssuer = new Identity("cn-fixture-other-issuer")
    const holder = new Identity(HOLDER_SECRET)
    const revocation = new Identity(REVOCATION_SECRET)

    const devicePublicKey = p256.getPublicKey(DEVICE_PRIVATE_KEY, false)
    const devicePubX = devicePublicKey.slice(1, 33)
    const devicePubY = devicePublicKey.slice(33, 65)
    const [deviceXHigh, deviceXLow] = coordinateLimbs(devicePubX)
    const [deviceYHigh, deviceYLow] = coordinateLimbs(devicePubY)
    const deviceKeyCommitment = poseidon5([DEVICE_KEY_DOMAIN, deviceXHigh, deviceXLow, deviceYHigh, deviceYLow])

    const programmeHash = stringToField("urn:cn:programme:test:v1")
    const credential = {
        programme_hash: programmeHash,
        country_code: countryCode("ZZZ"),
        not_before: BigInt(VALID_AT - 3600),
        expires_at: BigInt(VALID_AT + 3600),
        device_key_commitment: deviceKeyCommitment,
        holder_key_commitment: holder.commitment,
        revocation_commitment: revocation.commitment
    }
    const policy = poseidon4([
        credential.programme_hash,
        credential.country_code,
        credential.not_before,
        credential.expires_at
    ])
    const keys = poseidon3([
        credential.device_key_commitment,
        credential.holder_key_commitment,
        credential.revocation_commitment
    ])
    const credentialMessage = poseidon3([CREDENTIAL_DOMAIN, policy, keys])
    const issuerSignature = issuer.signMessage(credentialMessage)

    const challenge = bytesToBigint(CHALLENGE)
    const audience = stringToField(`urn:cn:network:${"dd".repeat(32)}`)
    const sessionMessage = poseidon4([PRESENTATION_DOMAIN, challenge, audience, credentialMessage])
    const deviceSignature = p256
        .sign(fieldToBytes(sessionMessage), DEVICE_PRIVATE_KEY, { lowS: true })
        .toCompactRawBytes()
    const holderSignature = holder.signMessage(sessionMessage)
    const revocationSignature = revocation.signMessage(sessionMessage)

    const issuerKey: [bigint, bigint] = [issuer.publicKey[0], issuer.publicKey[1]]
    const otherIssuerKey: [bigint, bigint] = [otherIssuer.publicKey[0], otherIssuer.publicKey[1]]
    const issuerSet = new ApprovedIssuerSet([otherIssuerKey, issuerKey])
    const issuerProof = issuerSet.generateProof(issuerKey)
    const issuerPath = padPath(issuerProof.pathIndex, issuerProof.siblings, ISSUER_SET_MAX_DEPTH)

    const revocations = new RevocationRegistry([
        new Identity(hexToBytes("11".repeat(32))).commitment,
        new Identity(hexToBytes("12".repeat(32))).commitment
    ])
    const revocationProof = revocations.generateProof(credential.revocation_commitment)
    if (revocationProof.proofType !== 1) throw new Error("fixture credential must not be revoked")
    const revocationPath = padPath(revocationProof.leafIndex, revocationProof.siblings, REVOCATION_MAX_DEPTH)

    const inputs: Record<string, string | string[] | boolean[]> = {
        current_time: String(VALID_AT),
        challenge: String(challenge),
        audience: String(audience),
        required_programme_hash: String(programmeHash),
        required_country_code: String(credential.country_code),
        issuer_pub_x: String(issuer.publicKey[0]),
        issuer_pub_y: String(issuer.publicKey[1]),
        issuer_sig_r8_x: String(issuerSignature.R8[0]),
        issuer_sig_r8_y: String(issuerSignature.R8[1]),
        issuer_sig_s: String(issuerSignature.S),
        issuer_depth: issuerPath.depth,
        issuer_indices: issuerPath.indices,
        issuer_siblings: issuerPath.siblings,
        device_pub_x: Array.from(devicePubX, String),
        device_pub_y: Array.from(devicePubY, String),
        device_signature: Array.from(deviceSignature, String),
        identity_pub_x: String(holder.publicKey[0]),
        identity_pub_y: String(holder.publicKey[1]),
        identity_sig_r8_x: String(holderSignature.R8[0]),
        identity_sig_r8_y: String(holderSignature.R8[1]),
        identity_sig_s: String(holderSignature.S),
        revocation_pub_x: String(revocation.publicKey[0]),
        revocation_pub_y: String(revocation.publicKey[1]),
        revocation_sig_r8_x: String(revocationSignature.R8[0]),
        revocation_sig_r8_y: String(revocationSignature.R8[1]),
        revocation_sig_s: String(revocationSignature.S),
        revocation_low_leaf_value: String(revocationProof.leaf.value),
        revocation_low_leaf_next: String(revocationProof.leaf.nextValue),
        revocation_depth: revocationPath.depth,
        revocation_indices: revocationPath.indices,
        revocation_siblings: revocationPath.siblings
    }

    const lines = Object.entries(inputs).map(([name, value]) => `${name} = ${toToml(value)}`)
    const credentialLines = Object.entries(credential).map(([name, value]) => `${name} = "${value}"`)

    const toml = `# Generated by scripts/generate-fixtures.ts. Do not edit.
${lines.join("\n")}

[credential]
${credentialLines.join("\n")}
`

    const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "Prover.toml")
    writeFileSync(out, toml)

    console.info(toml)
    console.info(`# approved_issuer_root = ${issuerSet.root}`)
    console.info(`# credential_message = ${credentialMessage}`)
    console.info(`# wrote ${out}`)
}

main()
