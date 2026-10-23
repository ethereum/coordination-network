/**
 * Regenerates the real proofs the CredentialRevocationRegistry Solidity tests verify against, into
 * `packages/contracts/test/fixtures/credential-revocation-proofs.json`.
 *
 * Run with `yarn workspace @coordination-network/network-member-proof generate:revocation-fixtures`.
 * Every message binds the chain id and the registry address, so the Solidity side pins both. Scopes
 * are fixed rather than random to keep the fixtures reproducible; a real client leaves `scope` alone
 * and gets a fresh random one per proof.
 */
import { writeFileSync } from "fs"
import { join } from "path"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateRevocationProof } from "../src/generate-revocation-proof"
import { revocationDomainSeparator } from "../src/revocation-message"
import { NetworkMemberProof, RegistryLocation, RevocationAction, RevocationUpdate } from "../src/types"

/** Forge's default chain id and the address the Solidity tests deploy the registry to. */
const REGISTRY: RegistryLocation = {
    chainId: 31337n,
    address: "0x0000000000000000000000000000000000feed01"
}

const MEMBER_SECRETS = ["member-one", "member-two", "member-three"] as const
const NEWCOMER_SECRET = "member-four"
const OUTSIDER_SECRET = "not-a-member"

/**
 * Stand-in revocation commitments. A real one is a Poseidon hash of a Baby Jubjub public key; these
 * only need to be distinct and in a known order, since the tests assert on predecessor indices.
 */
const COMMITMENT_A = 111n
const COMMITMENT_B = 222n
const COMMITMENT_C = 333n

const identities = MEMBER_SECRETS.map((secret) => new Identity(secret))
const newcomer = new Identity(NEWCOMER_SECRET)
const outsider = new Identity(OUTSIDER_SECRET)

const commitments = identities.map((identity) => identity.commitment)
const initialGroup = new Group(commitments)
const outsiderGroup = new Group([...commitments, outsider.commitment])

const revokeA: RevocationUpdate = { action: RevocationAction.Revoke, revocationCommitment: COMMITMENT_A }
const revokeB: RevocationUpdate = { action: RevocationAction.Revoke, revocationCommitment: COMMITMENT_B }
const unrevokeA: RevocationUpdate = { action: RevocationAction.Unrevoke, revocationCommitment: COMMITMENT_A }
const revokeManyAB: RevocationUpdate = {
    action: RevocationAction.RevokeMany,
    revocationCommitments: [COMMITMENT_A, COMMITMENT_B]
}
const replaceAWithC: RevocationUpdate = {
    action: RevocationAction.UpdateCommitment,
    oldRevocationCommitment: COMMITMENT_A,
    newRevocationCommitment: COMMITMENT_C
}

async function proofFor(
    identityIndex: number | "outsider",
    group: Group,
    update: RevocationUpdate,
    scope: bigint
): Promise<NetworkMemberProof> {
    const identity = identityIndex === "outsider" ? outsider : identities[identityIndex]

    return generateRevocationProof({ identity, group, registry: REGISTRY, update, scope })
}

async function main() {
    const fixtures = {
        registry: REGISTRY.address,
        chainId: Number(REGISTRY.chainId),
        revocationDomainSeparator: revocationDomainSeparator(REGISTRY.address),
        memberCommitments: commitments,
        newcomerCommitment: newcomer.commitment,
        commitmentA: COMMITMENT_A,
        commitmentB: COMMITMENT_B,
        commitmentC: COMMITMENT_C,
        proofs: {
            // Member 0 revokes commitment A. The workhorse fixture.
            revokeA: await proofFor(0, initialGroup, revokeA, 1n),
            // Member 1 revokes commitment A too: same payload, different member. The cross-issuer
            // write the threat model accepts.
            revokeAByMemberOne: await proofFor(1, initialGroup, revokeA, 2n),
            // Member 0 again, on a fresh scope: an unlinkable second revocation by the same member.
            revokeB: await proofFor(0, initialGroup, revokeB, 3n),
            // Member 2 un-revokes commitment A, the repair path for an anonymous mistake.
            unrevokeA: await proofFor(2, initialGroup, unrevokeA, 4n),
            // Member 1 revokes A and B in one batch.
            revokeManyAB: await proofFor(1, initialGroup, revokeManyAB, 5n),
            // Member 2 replaces A with C in place.
            replaceAWithC: await proofFor(2, initialGroup, replaceAWithC, 6n),
            // Member 2, still in the group at proof time, is removed from it before submitting.
            removedMemberRevokeB: await proofFor(2, initialGroup, revokeB, 7n),
            // A well-formed proof against a group this registry never had.
            foreignGroupRevokeA: await proofFor("outsider", outsiderGroup, revokeA, 8n)
        }
    }

    const path = join(__dirname, "../../contracts/test/fixtures/credential-revocation-proofs.json")
    const json = JSON.stringify(
        fixtures,
        (_key, value) => (typeof value === "bigint" ? `0x${value.toString(16)}` : value),
        4
    )

    writeFileSync(path, `${json}\n`)

    // eslint-disable-next-line no-console
    console.log(`wrote ${path}`)
    process.exit(0)
}

main()
