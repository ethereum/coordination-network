import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { PublicClient } from "viem"
import { mirrorMemberGroup as mirrorRegistrationMemberGroup } from "../src/registration-ports"
import { mirrorMemberGroup as mirrorRevocationMemberGroup } from "../src/revocation"

const ADDRESS = `0x${"44".repeat(20)}` as const
const HEAD = 25n
const FROM_BLOCK = 5

/** A chain that answers the location getters and records every `getLogs` range it is asked for. */
function fakeChain() {
    const ranges: string[] = []
    const publicClient = {
        getBlockNumber: async () => HEAD,
        readContract: async ({ functionName }: { functionName: string }) =>
            functionName === "SEMAPHORE" ? ADDRESS : 1n,
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
            ranges.push(`${fromBlock}-${toBlock}`)
            return []
        }
    } as unknown as PublicClient
    return { publicClient, ranges }
}

// The fake chain holds no membership events, so the mirror rejects once it has read them all.
const readGroup = (group: { currentGroup(): Promise<unknown> }) => group.currentGroup().catch(() => undefined)

const EVENT_TYPES = 4
const WINDOWS = ["5-14", "15-24", "25-25"]

const sites = {
    "registration member group": (client: PublicClient, logWindowBlocks?: number) =>
        mirrorRegistrationMemberGroup(client, ADDRESS, FROM_BLOCK, logWindowBlocks),
    "revocation member group": (client: PublicClient, logWindowBlocks?: number) =>
        mirrorRevocationMemberGroup(
            { publicClient: client, registry: { chainId: 1n, address: ADDRESS } },
            FROM_BLOCK,
            logWindowBlocks
        )
}

for (const [name, build] of Object.entries(sites)) {
    describe(name, () => {
        test("reads each event type in windows when logWindowBlocks is set", async () => {
            const { publicClient, ranges } = fakeChain()

            await readGroup(await build(publicClient, 10))

            assert.deepEqual(
                [...ranges].sort(),
                WINDOWS.flatMap((window) => Array<string>(EVENT_TYPES).fill(window)).sort()
            )
        })

        test("reads each event type in one call when logWindowBlocks is unset", async () => {
            const { publicClient, ranges } = fakeChain()

            await readGroup(await build(publicClient))

            assert.deepEqual(ranges, Array<string>(EVENT_TYPES).fill("5-25"))
        })
    })
}
