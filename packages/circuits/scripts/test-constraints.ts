import { spawnSync } from "child_process"
import { readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { RevocationRegistry } from "../../revocation-registry/src"

const circuitDir = dirname(dirname(fileURLToPath(import.meta.url)))
const valid = readFileSync(join(circuitDir, "Prover.toml"), "utf8")
const proverName = "ConstraintTest"
const proverPath = join(circuitDir, `${proverName}.toml`)
const REVOCATION_DEPTH = 20

const replaceLine = (source: string, name: string, encodedValue: string): string => {
    const pattern = new RegExp(`^${name} = .*$`, "m")
    if (!pattern.test(source)) throw new Error(`fixture has no ${name} input`)
    return source.replace(pattern, `${name} = ${encodedValue}`)
}

const replace = (source: string, name: string, value: string): string => replaceLine(source, name, `"${value}"`)

const cases: Array<[string, string, string]> = [
    ["not-yet-valid", "current_time", "1759996399"],
    ["expired", "current_time", "1760003601"],
    ["wrong-programme", "required_programme_hash", "0"],
    ["wrong-country", "required_country_code", "0"],
    ["tampered-credential", "device_key_commitment", "0"],
    ["wrong-issuer-key", "issuer_pub_x", "0"],
    ["invalid-issuer-signature", "issuer_sig_s", "0"],
    ["issuer-depth-above-max", "issuer_depth", "21"],
    ["wrong-challenge", "challenge", "0"],
    ["wrong-audience", "audience", "0"],
    ["wrong-holder-key", "identity_pub_x", "0"],
    ["invalid-holder-signature", "identity_sig_s", "0"],
    ["wrong-revocation-key", "revocation_pub_x", "0"],
    ["invalid-revocation-key-signature", "revocation_sig_s", "0"]
]

try {
    const zeroSiblings = `[${Array(REVOCATION_DEPTH).fill('"0"').join(", ")}]`
    const emptyRegistry = [
        ["revocation_low_leaf_value", '"0"'],
        ["revocation_low_leaf_next", '"0"'],
        ["revocation_depth", '"0"'],
        ["revocation_siblings", zeroSiblings]
    ].reduce((fixture, [input, value]) => replaceLine(fixture, input, value), valid)
    writeFileSync(proverPath, emptyRegistry)
    const emptyResult = spawnSync("nargo", ["execute", "--prover-name", proverName, "empty-registry"], {
        cwd: circuitDir,
        encoding: "utf8"
    })
    if (emptyResult.status !== 0) throw new Error("empty registry: circuit rejected the canonical empty witness")
    console.info("ok empty-registry")

    const zeroDeviceSignature = `[${Array(64).fill('"0"').join(", ")}]`
    writeFileSync(proverPath, replaceLine(valid, "device_signature", zeroDeviceSignature))
    const deviceResult = spawnSync("nargo", ["execute", "--prover-name", proverName, "negative-device-signature"], {
        cwd: circuitDir,
        encoding: "utf8"
    })
    if (deviceResult.status === 0) throw new Error("device-signature: circuit accepted an invalid P-256 signature")
    console.info("ok device-signature")

    const commitmentMatch = valid.match(/^revocation_commitment = "([0-9]+)"$/m)
    if (!commitmentMatch) throw new Error("fixture has no revocation commitment")
    const commitment = BigInt(commitmentMatch[1])
    const revoked = new RevocationRegistry([commitment])
    const revokedProof = revoked.generateProof(commitment)
    if (revokedProof.proofType !== 0) throw new Error("expected a membership proof for the revoked fixture")
    const revokedDepth = revokedProof.siblings.length
    const revokedIndices = [
        ...Array.from({ length: revokedDepth }, (_, i) => ((revokedProof.leafIndex >> i) & 1) === 1),
        ...Array(REVOCATION_DEPTH - revokedDepth).fill(false)
    ]
    const revokedSiblings = [...revokedProof.siblings.map(String), ...Array(REVOCATION_DEPTH - revokedDepth).fill("0")]
    const revokedFixture = [
        ["revocation_low_leaf_value", `"${revokedProof.leaf.value}"`],
        ["revocation_low_leaf_next", `"${revokedProof.leaf.nextValue}"`],
        ["revocation_depth", `"${revokedDepth}"`],
        ["revocation_indices", `[${revokedIndices.join(", ")}]`],
        ["revocation_siblings", `[${revokedSiblings.map((value) => `"${value}"`).join(", ")}]`]
    ].reduce((fixture, [input, value]) => replaceLine(fixture, input, value), valid)
    writeFileSync(proverPath, revokedFixture)
    const revokedResult = spawnSync("nargo", ["execute", "--prover-name", proverName, "negative-revoked"], {
        cwd: circuitDir,
        encoding: "utf8"
    })
    if (revokedResult.status === 0) throw new Error("revoked: circuit accepted a revoked credential")
    console.info("ok revoked")

    for (const [label, input, value] of cases) {
        writeFileSync(proverPath, replace(valid, input, value))
        const result = spawnSync("nargo", ["execute", "--prover-name", proverName, `negative-${label}`], {
            cwd: circuitDir,
            encoding: "utf8"
        })
        if (result.status === 0) throw new Error(`${label}: circuit accepted an invalid witness`)
        console.info(`ok ${label}`)
    }
} finally {
    rmSync(proverPath, { force: true })
}
