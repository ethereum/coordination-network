import "reflect-metadata"
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    AuthorizationList,
    IntegerSet,
    KeyMintKeyDescription,
    RootOfTrust,
    SecurityLevel,
    VerifiedBootState,
    id_ce_keyDescription
} from "@peculiar/asn1-android"
import { AsnConvert, OctetString } from "@peculiar/asn1-schema"
import { AlgorithmIdentifier, Certificate, SubjectPublicKeyInfo } from "@peculiar/asn1-x509"
import { Extension, X509CertificateGenerator } from "@peculiar/x509"
import type { X509Certificate as MintedCertificate } from "@peculiar/x509"
import { DEVICE_ATTESTATION_CHALLENGE } from "@coordination-network/credential"
import { createAttestationVerifier, type AttestationVerifier, type PinnedRoot } from "../src/attestation"

const FIXTURES = join(__dirname, "fixtures", "android-key-attestation")

export const CHALLENGE = new TextEncoder().encode(DEVICE_ATTESTATION_CHALLENGE)

/** The fields of Google's decoding these tests compare against. */
export interface FixtureJson {
    attestationVersion: string
    attestationSecurityLevel: string
    keyMintVersion: string
    keyMintSecurityLevel: string
    attestationChallenge: string
    softwareEnforced: { creationDateTime: string }
    hardwareEnforced: {
        purposes: string[]
        algorithms: string
        keySize: string
        digests?: string[]
        ecCurve: string
        noAuthRequired?: boolean
        origin: string
        rootOfTrust?: { deviceLocked: boolean; verifiedBootState: string }
    }
}

export interface Fixture {
    /** Base64 DER, leaf first, as a wallet sends it. */
    chain: string[]
    /** The leaf's creation time, so short-lived RKP intermediates still validate. */
    createdAt: number
    challenge: Uint8Array
    /** X‖Y of the attested key itself. */
    leafKeyXY: Uint8Array
    json: FixtureJson
}

/** The vendored chains that end in a pinned root and carry a well-formed key description. */
export const TRUSTED_FIXTURES = [
    "walleye/sdk27/TEE_EC_NONE",
    "blueline/sdk28/TEE_EC_NONE",
    "sony-xperia10-iii/sdk33/TEE_EC",
    "akita/sdk34/TEE_EC_NONE",
    "caiman/sdk36/TEE_EC_RKP",
    "caiman/sdk36/SB_EC_RKP",
    "tegu/sdk36/SB_EC_2026_ROOT",
    "tegu/sdk36/TEE_EC_2026_ROOT",
    "frankel/sdk37/TEE_EC_2026"
]

/** One of Google's test chains, by its path under `testdata/` without the extension. */
export function loadFixture(name: string): Fixture {
    const chain = pemChain(readFileSync(join(FIXTURES, `${name}.pem`), "utf8"))
    // Google's JSON carries `//` comment lines.
    const json = JSON.parse(
        readFileSync(join(FIXTURES, `${name}.json`), "utf8").replace(/^\s*\/\/.*$/gm, "")
    ) as FixtureJson
    return {
        chain,
        createdAt: Number(json.softwareEnforced.creationDateTime),
        challenge: Buffer.from(json.attestationChallenge, "base64"),
        leafKeyXY: leafKeyXY(chain[0]),
        json
    }
}

export function loadPem(name: string): string[] {
    return pemChain(readFileSync(join(FIXTURES, name), "utf8"))
}

function pemChain(pem: string): string[] {
    return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((match) =>
        match[1].replace(/\s+/g, "")
    )
}

function leafKeyXY(certB64: string): Uint8Array {
    const jwk = new X509Certificate(Buffer.from(certB64, "base64")).publicKey.export({ format: "jwk" })
    return Buffer.concat([Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")])
}

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" }
const EC_P384 = { name: "ECDSA", namedCurve: "P-384" }
export const DAY = 86_400_000

// No key algorithm OpenSSL can load: Node decodes the certificate, then throws on reading its key.
const UNLOADABLE_KEY_ALGORITHM = new AlgorithmIdentifier({ algorithm: "1.3.6.1.4.1.55555.1" })

function withUnloadableAlgorithm(spki: SubjectPublicKeyInfo): SubjectPublicKeyInfo {
    return new SubjectPublicKeyInfo({ algorithm: UNLOADABLE_KEY_ALGORITHM, subjectPublicKey: spki.subjectPublicKey })
}

/** Re-encodes a certificate under an unloadable key algorithm. Its signature no longer verifies,
 *  which nothing checks on a root. */
export function withUnloadableKey(certB64: string): string {
    const cert = AsnConvert.parse(Buffer.from(certB64, "base64"), Certificate)
    cert.tbsCertificate.subjectPublicKeyInfo = withUnloadableAlgorithm(cert.tbsCertificate.subjectPublicKeyInfo)
    return Buffer.from(AsnConvert.serialize(cert)).toString("base64")
}

function generate(algorithm: EcKeyGenParams): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])
}

/** One fake root for the whole test process, standing in for Google's P-384 root. */
const rootKeys = generate(EC_P384)

export async function testRoot(factory = false): Promise<PinnedRoot> {
    return { spki: Buffer.from(await crypto.subtle.exportKey("spki", (await rootKeys).publicKey)), factory }
}

/** A per-use, user-authenticated EC P-256 signing key on a locked, verified device: what the
 *  issuer accepts. Tests override single tags. */
function perUseHardwareList(overrides: Partial<AuthorizationList> = {}): AuthorizationList {
    return new AuthorizationList({
        purpose: new IntegerSet([2]),
        algorithm: 3,
        keySize: 256,
        digest: new IntegerSet([4]),
        ecCurve: 1,
        userAuthType: 3,
        origin: 0,
        rootOfTrust: new RootOfTrust({
            verifiedBootKey: new OctetString(new Uint8Array(32).fill(7)),
            deviceLocked: true,
            verifiedBootState: VerifiedBootState.verified,
            verifiedBootHash: new OctetString(new Uint8Array(32).fill(9))
        }),
        osVersion: 160000,
        osPatchLevel: 202509,
        ...overrides
    })
}

export interface MintOptions {
    confirmationKeyXY: Uint8Array
    challenge?: Uint8Array
    securityLevel?: SecurityLevel
    hardware?: Partial<AuthorizationList>
    /** The attestation cert's O, where an RKP chain states its security level. */
    attestationOrganization?: string
    /** Subject of the cert below the root, which names the provisioning type. */
    intermediateName?: string
    /** A 4-cert factory-shaped chain instead of the 5-cert RKP one. */
    factory?: boolean
    /** Certifies the confirmation key with a leaf signed by an attested key's own leaf. */
    hangBelowAttestedKey?: boolean
    omitKeyDescription?: boolean
    /** The leaf's attested creation time; null leaves the tag out. Defaults to minting time. */
    createdAt?: number | null
    /** Validity of the attestation cert, the one that signs the leaf. */
    attestationValidity?: { notBefore: Date; notAfter: Date }
    /** Certifies the confirmation key under an algorithm OpenSSL cannot load. */
    unloadableLeafKey?: boolean
    /** Rewrites the encoded key description, to get past the library's own serializer. */
    mangleKeyDescription?: (der: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

export interface MintedChain {
    chain: string[]
    /** Each cert's status-list key, by chain index. */
    serials: string[]
}

let serialCounter = 0x10

/** Leading zeros on purpose: the status list's keys have none. */
function nextSerial(): string {
    serialCounter += 1
    return `00${serialCounter.toString(16).padStart(4, "0")}`
}

/** Mints a chain shaped like a real one under {@link testRoot}: leaf, attestation cert,
 *  `Droid CA3`, `Droid CA2`, root; or leaf, attestation cert, factory intermediate, root. */
export async function mintChain(options: MintOptions): Promise<MintedChain> {
    const now = Date.now()
    const rootName = "CN=Test Key Attestation Root"
    const rootCert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: nextSerial(),
        name: rootName,
        keys: await rootKeys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
        notBefore: new Date(now - 365 * DAY),
        notAfter: new Date(now + 365 * DAY)
    })

    // A hung leaf takes Droid CA3's place, keeping the chain at the five certs an RKP chain has.
    const names = options.factory
        ? [options.intermediateName ?? "2.5.4.5=f00dfeedc0ffee01, T=TEE", "2.5.4.5=f00dfeedc0ffee02, T=TEE"]
        : [
              options.intermediateName ?? "CN=Droid CA2, O=Google LLC",
              ...(options.hangBelowAttestedKey ? [] : ["CN=Droid CA3, O=Google LLC"]),
              `CN=0123456789abcdef0123456789abcdef, O=${options.attestationOrganization ?? "TEE"}`
          ]
    let issuer = { keys: await rootKeys, name: rootName, hash: "SHA-384" }
    const above: MintedCertificate[] = [rootCert]
    for (const [index, name] of names.entries()) {
        const keys = await generate(EC_P256)
        above.unshift(
            await X509CertificateGenerator.create({
                serialNumber: nextSerial(),
                subject: name,
                issuer: issuer.name,
                publicKey: keys.publicKey,
                signingKey: issuer.keys.privateKey,
                signingAlgorithm: { name: "ECDSA", hash: issuer.hash },
                notBefore: new Date(now - 365 * DAY),
                notAfter: new Date(now + 365 * DAY),
                ...(index === names.length - 1 ? options.attestationValidity : {})
            })
        )
        issuer = { keys, name, hash: "SHA-256" }
    }

    const description = new KeyMintKeyDescription({
        attestationVersion: 300,
        attestationSecurityLevel: options.securityLevel ?? SecurityLevel.trustedEnvironment,
        keyMintVersion: 300,
        keyMintSecurityLevel: options.securityLevel ?? SecurityLevel.trustedEnvironment,
        attestationChallenge: new OctetString(options.challenge ?? CHALLENGE),
        softwareEnforced: new AuthorizationList(
            options.createdAt === null ? {} : { creationDateTime: options.createdAt ?? now }
        ),
        hardwareEnforced: perUseHardwareList(options.hardware)
    })
    const encoded = new Uint8Array(AsnConvert.serialize(description))
    const extensions = options.omitKeyDescription
        ? []
        : [new Extension(id_ce_keyDescription, false, options.mangleKeyDescription?.(encoded) ?? encoded)]
    // Real leaves carry these fixed dates; nothing checks them.
    const leafValidity = { notBefore: new Date(0), notAfter: new Date("2048-01-01T00:00:00Z") }

    const mintLeaf = (publicKey: CryptoKey | ArrayBuffer) =>
        X509CertificateGenerator.create({
            serialNumber: "01",
            subject: "CN=Android Keystore Key",
            issuer: issuer.name,
            publicKey,
            signingKey: issuer.keys.privateKey,
            extensions,
            ...leafValidity
        })
    const leaves: MintedCertificate[] = []
    if (options.hangBelowAttestedKey) {
        const attested = await generate(EC_P256)
        leaves.unshift(await mintLeaf(attested.publicKey))
        issuer = { keys: attested, name: "CN=Android Keystore Key", hash: "SHA-256" }
    }
    const confirmationKey = await crypto.subtle.importKey(
        "raw",
        Buffer.concat([Buffer.from([4]), options.confirmationKeyXY]),
        EC_P256,
        true,
        ["verify"]
    )
    const confirmationSpki = AsnConvert.parse(
        await crypto.subtle.exportKey("spki", confirmationKey),
        SubjectPublicKeyInfo
    )
    leaves.unshift(
        await mintLeaf(
            options.unloadableLeafKey
                ? AsnConvert.serialize(withUnloadableAlgorithm(confirmationSpki))
                : confirmationKey
        )
    )

    const certs = [...leaves, ...above]
    return {
        chain: certs.map((cert) => Buffer.from(cert.rawData).toString("base64")),
        serials: certs.map((cert) => BigInt(`0x${cert.serialNumber}`).toString(16))
    }
}

interface TestVerifierOptions {
    roots?: PinnedRoot[]
    revoked?: string[]
    unavailable?: "never-fetched" | "stale"
    now?: () => number
}

/** A verifier anchored at {@link testRoot} with a fresh status list. */
export async function testVerifier({
    roots,
    revoked = [],
    unavailable,
    now
}: TestVerifierOptions = {}): Promise<AttestationVerifier> {
    const serials = new Set(revoked)
    return createAttestationVerifier({
        roots: roots ?? [await testRoot()],
        statusList: { snapshot: () => (unavailable ? { unavailable } : { serials, fetchedAt: Date.now() }) },
        now
    })
}
