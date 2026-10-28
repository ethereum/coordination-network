import { createPublicClient, http } from "viem"
import { NetworkMemberRegistryClient } from "../src/registry-client"
import { ISSUER_ID } from "./fixtures"

jest.mock("viem", () => {
    const actual = jest.requireActual<typeof import("viem")>("viem")
    return { ...actual, createPublicClient: jest.fn(), http: jest.fn(actual.http) }
})

const REGISTRY = "0x0000000000000000000000000000000000000001"

describe("NetworkMemberRegistryClient", () => {
    it.each([true, false])("returns the registry's approval result (%s) for the requested member", async (approved) => {
        const readContract = jest.fn().mockResolvedValue(approved)
        jest.mocked(createPublicClient).mockReturnValue({ readContract } as unknown as ReturnType<
            typeof createPublicClient
        >)
        const client = new NetworkMemberRegistryClient(REGISTRY, "https://rpc.example")

        await expect(client.isApprovedNetworkMember(ISSUER_ID)).resolves.toBe(approved)
        expect(readContract).toHaveBeenCalledWith({
            address: REGISTRY,
            abi: [
                {
                    type: "function",
                    name: "isApproved",
                    stateMutability: "view",
                    inputs: [{ name: "memberNetworkId", type: "bytes32" }],
                    outputs: [{ type: "bool" }]
                }
            ],
            functionName: "isApproved",
            args: [ISSUER_ID]
        })
        expect(createPublicClient).toHaveBeenLastCalledWith({ transport: expect.any(Function) })
        expect(http).toHaveBeenLastCalledWith("https://rpc.example")
    })

    it("propagates RPC failures instead of treating an unavailable registry as an unapproved member", async () => {
        const failure = new Error("RPC unavailable")
        const readContract = jest.fn().mockRejectedValue(failure)
        jest.mocked(createPublicClient).mockReturnValue({ readContract } as unknown as ReturnType<
            typeof createPublicClient
        >)
        const client = new NetworkMemberRegistryClient(REGISTRY, "https://rpc.example")

        await expect(client.isApprovedNetworkMember(ISSUER_ID)).rejects.toBe(failure)
    })
})
