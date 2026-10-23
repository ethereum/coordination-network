import { describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    decodeFunctionData,
    getAbiItem,
    getAddress,
    keccak256,
    pad,
    toEventSelector,
    type Abi,
    type AbiEvent,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
    NETWORK_MEMBER_GOVERNANCE_ABI,
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    NETWORK_MEMBER_REGISTRY_ABI,
    encodeAdmitMember,
    encodeExitNetwork,
    encodeRequestToJoin,
    memberAccountKey,
    type NetworkMemberJoinRequest
} from "../src"

const ADMISSION: NetworkMemberJoinRequest = {
    memberNetworkId: pad("0xabcd", { size: 32 }),
    accountKeyX: 11n,
    accountKeyY: 22n,
    semaphoreCommitment: 12_345_678_901_234_567_890n,
    governanceSigner: getAddress("0x9999999999999999999999999999999999999999"),
    metadataURI: "<vetting material URL>"
}

const ACCOUNT = privateKeyToAccount("0x1515151515151515151515151515151515151515151515151515151515151515")

/** Five founding members, the set every transaction below is built against. */
const MEMBER_COUNT = 5

describe("network member governance calls", () => {
    describe("encodeAdmitMember", () => {
        it("carries the member's three values plus the member set it was built against", () => {
            const { functionName, args } = decodeFunctionData({
                abi: NETWORK_MEMBER_GOVERNANCE_ABI,
                data: encodeAdmitMember(ADMISSION, MEMBER_COUNT)
            })

            expect(functionName).toBe("admitMember")
            expect(args).toEqual([
                ADMISSION.accountKeyX,
                ADMISSION.accountKeyY,
                ADMISSION.semaphoreCommitment,
                ADMISSION.governanceSigner,
                BigInt(MEMBER_COUNT)
            ])
        })
    })

    describe("encodeExitNetwork", () => {
        it("is the member's own call, taking only its networkId and its membership proof", () => {
            const { functionName, args } = decodeFunctionData({
                abi: NETWORK_MEMBER_GOVERNANCE_ABI,
                data: encodeExitNetwork(ADMISSION.memberNetworkId, [7n])
            })

            expect(functionName).toBe("exitNetwork")
            expect(args).toEqual([ADMISSION.memberNetworkId, [7n]])
        })
    })

    describe("encodeRequestToJoin", () => {
        it("encodes the candidate's own permissionless call", () => {
            const { functionName, args } = decodeFunctionData({
                abi: NETWORK_MEMBER_REGISTRY_ABI,
                data: encodeRequestToJoin(ADMISSION)
            })

            expect(functionName).toBe("requestToJoin")
            expect(args).toEqual([
                ADMISSION.accountKeyX,
                ADMISSION.accountKeyY,
                ADMISSION.semaphoreCommitment,
                ADMISSION.governanceSigner,
                ADMISSION.metadataURI
            ])
        })

        it("defaults an omitted metadata URI to the empty string", () => {
            const { args } = decodeFunctionData({
                abi: NETWORK_MEMBER_REGISTRY_ABI,
                data: encodeRequestToJoin({ ...ADMISSION, metadataURI: undefined })
            })

            expect(args?.[4]).toBe("")
        })
    })

    describe("memberAccountKey", () => {
        // viem's public key is the 65-byte uncompressed form: `0x04`, then X, then Y.
        const uncompressed = ACCOUNT.publicKey
        const raw: Hex = `0x${uncompressed.slice(4)}`

        it.each([
            ["65-byte 0x04-prefixed", uncompressed],
            ["64-byte raw", raw]
        ])("derives the id and coordinates from a %s key", (_form, key) => {
            const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(key)

            expect(memberNetworkId).toBe(keccak256(raw))
            expect(accountKeyX).toBe(BigInt(`0x${raw.slice(2, 66)}`))
            expect(accountKeyY).toBe(BigInt(`0x${raw.slice(66)}`))
        })

        it("gives an id whose low 20 bytes are the key's address", () => {
            const { memberNetworkId } = memberAccountKey(uncompressed)

            expect(getAddress(`0x${memberNetworkId.slice(-40)}`)).toBe(ACCOUNT.address)
        })

        it("gives the same result for upper- and lower-case hex", () => {
            const upper: Hex = `0x04${uncompressed.slice(4).toUpperCase()}`

            expect(memberAccountKey(upper)).toEqual(memberAccountKey(uncompressed))
            expect(memberAccountKey(`0x${raw.slice(2).toUpperCase()}`)).toEqual(memberAccountKey(raw))
        })

        it.each([
            ["a compressed key", `0x02${"11".repeat(32)}` as Hex],
            ["a 63-byte value", `0x${"11".repeat(63)}` as Hex],
            ["a 66-byte value", `0x${"11".repeat(66)}` as Hex],
            ["a 65-byte value without the 0x04 prefix", `0x05${"11".repeat(64)}` as Hex],
            ["a 65-byte key one nibble short", uncompressed.slice(0, -1) as Hex],
            ["a 64-byte key one nibble short", raw.slice(0, -1) as Hex],
            ["a key with a non-hex character", `0x${"g"}${raw.slice(3)}` as Hex]
        ])("rejects %s", (_what, key) => {
            expect(() => memberAccountKey(key)).toThrow("public key")
        })
    })

    describe("calls built from a member account key", () => {
        const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(ACCOUNT.publicKey)
        const request: NetworkMemberJoinRequest = { ...ADMISSION, memberNetworkId, accountKeyX, accountKeyY }

        it("passes the key coordinates, not the id, to requestToJoin and admitMember", () => {
            const join = decodeFunctionData({
                abi: NETWORK_MEMBER_REGISTRY_ABI,
                data: encodeRequestToJoin(request)
            })
            const admit = decodeFunctionData({
                abi: NETWORK_MEMBER_GOVERNANCE_ABI,
                data: encodeAdmitMember(request, MEMBER_COUNT)
            })

            expect(join.args?.slice(0, 2)).toEqual([accountKeyX, accountKeyY])
            expect(admit.args?.slice(0, 2)).toEqual([accountKeyX, accountKeyY])
        })

        it("ignores the id it is given", () => {
            const other = { ...request, memberNetworkId: pad("0xbeef", { size: 32 }) }

            expect(encodeRequestToJoin(other)).toBe(encodeRequestToJoin(request))
            expect(encodeAdmitMember(other, MEMBER_COUNT)).toBe(encodeAdmitMember(request, MEMBER_COUNT))
        })
    })

    describe("ABI surface", () => {
        it("matches the event the compiled registry emits", () => {
            const { abi } = JSON.parse(
                readFileSync(
                    join(__dirname, "../../contracts/out/NetworkMemberRegistry.sol/NetworkMemberRegistry.json"),
                    "utf8"
                )
            ) as { abi: Abi }

            expect(toEventSelector(NETWORK_MEMBER_JOIN_REQUESTED_EVENT)).toBe(
                toEventSelector(getAbiItem({ abi, name: "NetworkMemberJoinRequested" }) as AbiEvent)
            )
        })

        it("exposes the join request event members watch", () => {
            expect(
                NETWORK_MEMBER_REGISTRY_ABI.find(
                    (entry) => entry.type === "event" && entry.name === "NetworkMemberJoinRequested"
                )
            ).toBeDefined()
        })

        it("exposes exactly the governance operations, none of them taking a threshold", () => {
            const operations = NETWORK_MEMBER_GOVERNANCE_ABI.filter(
                (entry) => entry.type === "function" && entry.stateMutability === "nonpayable"
            )

            expect(operations.map((entry) => entry.name)).toEqual(["admitMember", "removeMember", "exitNetwork"])
            expect(operations.flatMap((entry) => entry.inputs.map(({ name }) => name))).not.toContain("threshold")
        })
    })
})
