import { describe, expect, it } from "@jest/globals"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    encodeAbiParameters,
    encodeEventTopics,
    encodePacked,
    getAbiItem,
    getAddress,
    keccak256,
    pad,
    parseAbiParameters,
    type Abi,
    type AbiEvent,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
    NETWORK_MEMBER_REGISTRY_ABI,
    decodeJoinRequestLog,
    encodeRequestToJoin,
    memberAccountKey,
    type NetworkMemberJoinRequest
} from "../src"

const REGISTRY = getAddress("0x3333333333333333333333333333333333333333")

const REQUEST: NetworkMemberJoinRequest = {
    memberNetworkId: keccak256(encodePacked(["uint256", "uint256"], [11n, 22n])),
    accountKeyX: 11n,
    accountKeyY: 22n,
    semaphoreCommitment: 12_345_678_901_234_567_890n,
    governanceSigner: getAddress("0x9999999999999999999999999999999999999999"),
    metadataURI: "<vetting material URL>"
}

/** A `NetworkMemberJoinRequested` log, encoded the way a node would return one. */
function encodeJoinRequestLog(request: NetworkMemberJoinRequest, address = REGISTRY) {
    return {
        address,
        // `encodeEventTopics` types its result for filters, which allow nulls and arrays; a log as a
        // node returns it is a plain list of topics.
        topics: encodeEventTopics({
            abi: NETWORK_MEMBER_REGISTRY_ABI,
            eventName: "NetworkMemberJoinRequested",
            args: { memberNetworkId: request.memberNetworkId }
        }) as Hex[],
        data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, address, string"), [
            request.accountKeyX,
            request.accountKeyY,
            request.semaphoreCommitment,
            request.governanceSigner,
            request.metadataURI ?? ""
        ])
    }
}

describe("decodeJoinRequestLog", () => {
    it("recovers exactly what the candidate published", () => {
        expect(decodeJoinRequestLog(encodeJoinRequestLog(REQUEST), REGISTRY)).toEqual(REQUEST)
    })

    /**
     * The point of the decoder: the request an approver verifies against comes from the chain, and the
     * fields land where the ABI says rather than where a hand-written mapping guessed.
     */
    it("round-trips against the calldata the candidate itself sent", () => {
        const decoded = decodeJoinRequestLog(encodeJoinRequestLog(REQUEST), REGISTRY)

        expect(encodeRequestToJoin(decoded)).toBe(encodeRequestToJoin(REQUEST))
    })

    it("refuses a log from a contract other than the registry", () => {
        const impostor = getAddress("0xdddddddddddddddddddddddddddddddddddddddd")

        expect(() => decodeJoinRequestLog(encodeJoinRequestLog(REQUEST, impostor), REGISTRY)).toThrow(
            "not from the registry"
        )
    })

    it("refuses a log for a different event", () => {
        const wrongEvent = {
            ...encodeJoinRequestLog(REQUEST),
            topics: [pad("0xdead", { size: 32 }) as Hex]
        }

        expect(() => decodeJoinRequestLog(wrongEvent, REGISTRY)).toThrow()
    })

    it("refuses a log whose id is not the hash of the key in its data", () => {
        const forged = encodeJoinRequestLog({ ...REQUEST, memberNetworkId: pad("0xabcd", { size: 32 }) })

        expect(() => decodeJoinRequestLog(forged, REGISTRY)).toThrow("memberNetworkId")
    })

    it("decodes without a registry to compare against, when the caller filtered by address already", () => {
        const { topics, data } = encodeJoinRequestLog(REQUEST)

        expect(decodeJoinRequestLog({ topics, data })).toEqual(REQUEST)
    })

    /**
     * Encoded from the compiled registry's own event definition rather than this package's, so a
     * reordered or retyped field in either one fails here instead of decoding into the wrong slots.
     */
    it("decodes a log encoded from the compiled registry's event, with the id derived from the key", () => {
        const { abi } = JSON.parse(
            readFileSync(
                join(__dirname, "../../contracts/out/NetworkMemberRegistry.sol/NetworkMemberRegistry.json"),
                "utf8"
            )
        ) as { abi: Abi }
        const event = getAbiItem({ abi, name: "NetworkMemberJoinRequested" }) as AbiEvent
        const account = privateKeyToAccount(`0x${"15".repeat(32)}`)
        const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(account.publicKey)
        const request: NetworkMemberJoinRequest = { ...REQUEST, memberNetworkId, accountKeyX, accountKeyY }

        const log = {
            address: REGISTRY,
            topics: encodeEventTopics({
                abi,
                eventName: "NetworkMemberJoinRequested",
                args: { memberNetworkId }
            }) as Hex[],
            data: encodeAbiParameters(
                event.inputs.filter((input) => !input.indexed),
                [
                    request.accountKeyX,
                    request.accountKeyY,
                    request.semaphoreCommitment,
                    request.governanceSigner,
                    request.metadataURI ?? ""
                ]
            )
        }

        expect(decodeJoinRequestLog(log, REGISTRY)).toEqual(request)
    })
})
