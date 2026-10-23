import { type ChildProcess } from "node:child_process"
import type { Server } from "node:http"
import { getAddress, type Address, type Hex } from "viem"
import { deriveKeys } from "@coordination-network/identity"
import { config } from "../../src/config.ts"
import { startIndexer } from "../../src/server.ts"
import {
    SCOPED_TOKEN_ARTIFACT_PATH,
    scopedTokenAbi,
    ANNOUNCER_ARTIFACT_PATH,
    announceOnchain,
    announcerAbi,
    buildAnnouncementFor,
    deployContractFromArtifact,
    testClient,
    mineBlocks,
    mintScopedToken,
    publicClient,
    startAnvil
} from "../utils/chain.ts"
import { INTEGRATION_TEST_PORT, startPostgres, type TestDatabase } from "../utils/db.ts"

config.confirmations = 5

// the network member's delegated users, plus a user who joins the member later
const user1Keys = deriveKeys(`0x${"01".repeat(32)}`)
const user2Keys = deriveKeys(`0x${"02".repeat(32)}`)
const lateUserKeys = deriveKeys(`0x${"03".repeat(32)}`)

const user1NetworkId: Hex = `0x${"a1".repeat(32)}`
const user2NetworkId: Hex = `0x${"a2".repeat(32)}`
const lateUserNetworkId: Hex = `0x${"a3".repeat(32)}`

const authorization = { authorization: `Bearer ${process.env.AUTH_TOKEN}` }

// a member issues one token id per scoped token type, so two of them in the same contract
const TOKEN_A_ID = 0n
const TOKEN_B_ID = 1n

const user1Announcement = buildAnnouncementFor({
    spendingPublicKey: user1Keys.spending.publicKey,
    viewingPublicKey: user1Keys.viewing.publicKey
})
const user2Announcement = buildAnnouncementFor({
    spendingPublicKey: user2Keys.spending.publicKey,
    viewingPublicKey: user2Keys.viewing.publicKey
})

// second announcement for user 1
const user1SecondAnnouncement = buildAnnouncementFor({
    spendingPublicKey: user1Keys.spending.publicKey,
    viewingPublicKey: user1Keys.viewing.publicKey
})
// announced up front but only discovered once lateUserKeys is registered
const lateUserAnnouncement = buildAnnouncementFor({
    spendingPublicKey: lateUserKeys.spending.publicKey,
    viewingPublicKey: lateUserKeys.viewing.publicKey
})

let anvil: ChildProcess
let db: TestDatabase
let announcer: Address
let scopedToken: Address
let listener: Server
let stopIndexer: () => Promise<void>
let url: string
let indexerRunning = false

type Health = {
    latestBlock: string
    lowestScannedBlock: string
    lagBlocks: string
    lastScanAt: string | null
    lastError: string | null
}

async function registerKey(networkId: Hex, keys: ReturnType<typeof deriveKeys>, fromBlock: number) {
    const response = await fetch(`${url}/keys`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({
            networkId,
            spendingPublicKey: keys.spending.publicKey,
            viewingPrivateKey: keys.viewing.privateKey,
            fromBlock
        })
    })
    expect(response.status).toBe(201)
}

async function runIndexer() {
    const { app, stop } = await startIndexer()
    listener = app.listen(0)
    stopIndexer = stop
    indexerRunning = true
    const { port } = listener.address() as { port: number }
    url = `http://127.0.0.1:${port}`
}

async function closeIndexer() {
    if (!indexerRunning) return
    indexerRunning = false
    listener.close()
    await stopIndexer()
}

async function getHealth(): Promise<Health> {
    const response = await fetch(`${url}/health`, { headers: authorization })
    expect(response.status).toBe(200)
    return (await response.json()) as Health
}

async function getAccounts(networkId: Hex): Promise<Address[]> {
    const response = await fetch(`${url}/accounts?networkId=${networkId}`, { headers: authorization })
    expect(response.status).toBe(200)
    const { accounts, nextCursor } = (await response.json()) as {
        accounts: Array<{ stealthAddress: Address }>
        nextCursor: string | null
    }
    // these tests never exceed one page
    expect(nextCursor).toBeNull()
    return accounts.map((account) => account.stealthAddress)
}

/** Every account across the entities these tests register, since each query names one entity. */
async function getAllAccounts(): Promise<Address[]> {
    const perEntity = await Promise.all(
        [user1NetworkId, user2NetworkId, lateUserNetworkId].map((networkId) => getAccounts(networkId))
    )
    return perEntity.flat()
}

async function getBalances(
    networkId: Hex,
    tokenIds: Array<bigint>
): Promise<Array<{ stealthAddress: Address; tokenId: string; balance: string }>> {
    const tokenIdParameters = tokenIds.map((tokenId) => `&tokenIds=${tokenId}`).join("")
    const response = await fetch(`${url}/balances?networkId=${networkId}${tokenIdParameters}`, {
        headers: authorization
    })
    expect(response.status).toBe(200)
    const { balances } = (await response.json()) as {
        balances: Array<{ stealthAddress: Address; tokenId: string; balance: string }>
    }
    return balances
}

async function waitForCatchUp(block?: bigint): Promise<Health> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        const health = await getHealth()

        if (block && block > 0) {
            const hasReachedBlock = BigInt(health.lowestScannedBlock) >= block
            if (hasReachedBlock) return health
        } else {
            const hasFullyCaughtUp = health.lastScanAt !== null && health.lagBlocks === "0"
            if (hasFullyCaughtUp) return health
        }

        await new Promise((resolve) => setTimeout(resolve, 100))
    }

    throw new Error("indexer did not catch up within 15s")
}

function sortAddresses(addresses: Address[]): Address[] {
    return addresses.map((address) => getAddress(address)).sort()
}

function assertDeployedAt(deployed: Address, configured: Address, name: string) {
    if (getAddress(deployed) !== getAddress(configured)) {
        throw new Error(`${name} is ${configured}, but the contract deployed at ${deployed}`)
    }
}

beforeAll(async () => {
    anvil = await startAnvil()
    db = await startPostgres(INTEGRATION_TEST_PORT)

    announcer = await deployContractFromArtifact(ANNOUNCER_ARTIFACT_PATH, announcerAbi)
    scopedToken = await deployContractFromArtifact(SCOPED_TOKEN_ARTIFACT_PATH, scopedTokenAbi)

    // anvil hands out deterministic addresses, so a mismatch means .env.test has drifted
    // from the deploy order here and every test would fail for an unrelated-looking reason
    assertDeployedAt(announcer, process.env.ANNOUNCER_ADDRESS as Address, "ANNOUNCER_ADDRESS")
    assertDeployedAt(scopedToken, process.env.TOKEN_ADDRESS as Address, "TOKEN_ADDRESS")

    await announceOnchain(announcer, user1Announcement)
    await mineBlocks(config.confirmations)
    await announceOnchain(announcer, user2Announcement)
    await mineBlocks(config.confirmations)
    await announceOnchain(announcer, lateUserAnnouncement)
    await mineBlocks(config.confirmations)
})

afterAll(async () => {
    await db.pool.end()
    db.stop()
    anvil.kill()
})

afterEach(async () => {
    await closeIndexer()
})

test("discovers user accounts", async () => {
    await runIndexer()
    await registerKey(user1NetworkId, user1Keys, 0)
    await registerKey(user2NetworkId, user2Keys, 0)
    await waitForCatchUp()

    // the late user's key is not registered yet, so their account must be excluded
    expect(sortAddresses(await getAllAccounts())).toEqual(
        sortAddresses([user1Announcement.stealthAddress, user2Announcement.stealthAddress])
    )
})

test("restart resumes from the stored bookmark and catches up on missed announcements", async () => {
    await runIndexer()
    const bookmarkBeforeRestart = (await waitForCatchUp()).lowestScannedBlock
    await closeIndexer()

    // announced while the indexer is down
    await announceOnchain(announcer, user1SecondAnnouncement)
    await mineBlocks(config.confirmations)

    await runIndexer()
    const bootHealth = await getHealth()
    // boot bookmark ${bootHealth.lowestScannedBlock} must resume from ${bookmarkBeforeRestart}, not START_BLOCK
    expect(BigInt(bootHealth.lowestScannedBlock) >= BigInt(bookmarkBeforeRestart)).toBeTruthy()

    await waitForCatchUp()
    // the announcement made during downtime should be caught up, with no duplicates
    expect(sortAddresses(await getAllAccounts())).toEqual(
        sortAddresses([
            user1Announcement.stealthAddress,
            user2Announcement.stealthAddress,
            user1SecondAnnouncement.stealthAddress
        ])
    )

    const { rows } = await db.pool.query("SELECT count(*)::int AS count FROM accounts")
    // each account is stored exactly once
    expect(rows[0].count).toBe(3)
})

test("a key registered against the running service discovers its old announcements", async () => {
    await runIndexer()
    await waitForCatchUp()

    // lateUserAnnouncement has been onchain since beforeAll() and was excluded so far.
    // fromBlock reaches back to it without touching the global START_BLOCK
    await registerKey(lateUserNetworkId, lateUserKeys, 0)
    await waitForCatchUp()

    // the late key's old announcement joins the existing accounts without a restart, none of which duplicate
    expect(sortAddresses(await getAllAccounts())).toEqual(
        sortAddresses([
            user1Announcement.stealthAddress,
            user2Announcement.stealthAddress,
            user1SecondAnnouncement.stealthAddress,
            lateUserAnnouncement.stealthAddress
        ])
    )
})

test("accounts are returned per entity, so one user's are never listed under another", async () => {
    await runIndexer()
    await waitForCatchUp()

    expect(sortAddresses(await getAccounts(user1NetworkId))).toEqual(
        sortAddresses([user1Announcement.stealthAddress, user1SecondAnnouncement.stealthAddress])
    )
})

test("balances report what the entity's stealth accounts hold", async () => {
    await runIndexer()
    await waitForCatchUp()

    await mintScopedToken(scopedToken, user1Announcement.stealthAddress, TOKEN_A_ID, 50n)

    const balances = await getBalances(user1NetworkId, [TOKEN_A_ID])

    const heldByAddress = new Map(balances.map((balance) => [getAddress(balance.stealthAddress), balance.balance]))
    expect(heldByAddress.get(getAddress(user1Announcement.stealthAddress))).toBe("50")
    // an account that has been discovered but never credited holds nothing
    expect(heldByAddress.get(getAddress(user1SecondAnnouncement.stealthAddress))).toBe("0")
})

test("balances report every token type asked about, as the till shows a delegated user", async () => {
    await runIndexer()
    await waitForCatchUp()

    // one account credited with two token types of the same member contract
    await mintScopedToken(scopedToken, user2Announcement.stealthAddress, TOKEN_A_ID, 30n)
    await mintScopedToken(scopedToken, user2Announcement.stealthAddress, TOKEN_B_ID, 70n)

    const balances = await getBalances(user2NetworkId, [TOKEN_A_ID, TOKEN_B_ID])

    const account = getAddress(user2Announcement.stealthAddress)
    const [tokenA, tokenB] = balances

    expect(balances).toHaveLength(2)
    expect(getAddress(tokenA.stealthAddress)).toBe(account)
    expect(tokenA.tokenId).toBe(TOKEN_A_ID.toString())
    expect(tokenA.balance).toBe("30")
    expect(getAddress(tokenB.stealthAddress)).toBe(account)
    expect(tokenB.tokenId).toBe(TOKEN_B_ID.toString())
    expect(tokenB.balance).toBe("70")
})

test("balances exclude the accounts of other entities", async () => {
    await runIndexer()
    await waitForCatchUp()

    const balances = await getBalances(user2NetworkId, [TOKEN_A_ID])

    expect(balances.map((balance) => getAddress(balance.stealthAddress))).toEqual([
        getAddress(user2Announcement.stealthAddress)
    ])
})

test("stop finishes the scan it is part-way through", async () => {
    await mineBlocks(10)

    // slow getLogs ensure the scan is running when we need it to be, so
    // stop() can be called part way through a scan with high confidence.
    const client = config.client
    config.client = {
        ...client,
        getLogs: async (parameters: Parameters<typeof client.getLogs>[0]) => {
            await new Promise((resolve) => setTimeout(resolve, 500))
            return client.getLogs(parameters)
        }
    } as typeof client

    await runIndexer()
    // wait while the first scan is still running, so the loop tries to start another
    const threeScanIntervals = 3 * config.scanIntervalMs
    await new Promise((resolve) => setTimeout(resolve, threeScanIntervals))

    const startedStopping = performance.now()
    await closeIndexer()
    config.client = client

    // a read takes 500ms so returning sooner means that it did not wait
    // for the scan to finish, which should be longer than 100ms
    // stop should wait for the scan it is part-way through
    expect(performance.now() - startedStopping > 100).toBeTruthy()
})

test("a database lost entirely is rebuilt from the chain and the member's own key records", async () => {
    await runIndexer()
    await waitForCatchUp()
    const accountsBeforeLoss = sortAddresses(await getAllAccounts())
    await closeIndexer()

    // delete every db table
    await db.pool.query("DROP TABLE IF EXISTS accounts, keys")

    await runIndexer()
    // the rebuild starts from nothing
    expect(await getAllAccounts()).toEqual([])

    // the member's backend re-registers what it holds
    await registerKey(user1NetworkId, user1Keys, 0)
    await registerKey(user2NetworkId, user2Keys, 0)
    await registerKey(lateUserNetworkId, lateUserKeys, 0)
    await waitForCatchUp()

    // every account is recovered, and none twice
    expect(sortAddresses(await getAllAccounts())).toEqual(accountsBeforeLoss)
})

test("the indexer drops annoucements given a reorg less than 5 confirmations", async () => {
    const reorgUserKeys = deriveKeys(`0x${"04".repeat(32)}`)
    const reorgUserNetworkId: Hex = `0x${"a4".repeat(32)}`
    const reorgAnnouncement = buildAnnouncementFor({
        spendingPublicKey: reorgUserKeys.spending.publicKey,
        viewingPublicKey: reorgUserKeys.viewing.publicKey
    })

    await runIndexer()
    await registerKey(reorgUserNetworkId, reorgUserKeys, 0)
    await waitForCatchUp()

    // take snapshot and announce onchain
    const beforeReorgSnapshot = await testClient.snapshot()
    const announcedAtBlockNumber = await publicClient.getBlockNumber({ cacheTime: 0 })
    await announceOnchain(announcer, reorgAnnouncement)
    await waitForCatchUp()
    expect(await getAccounts(reorgUserNetworkId)).toEqual([])

    // discard block announcement is in to simulate a reorg
    await testClient.revert({ id: beforeReorgSnapshot })
    await mineBlocks(config.confirmations + 1)
    await waitForCatchUp(announcedAtBlockNumber)
    expect(await getAccounts(reorgUserNetworkId)).toEqual([])

    // re-announce
    await announceOnchain(announcer, reorgAnnouncement)
    const reannouncedAtBlockNumber = await publicClient.getBlockNumber({ cacheTime: 0 })
    await mineBlocks(config.confirmations)
    await waitForCatchUp(reannouncedAtBlockNumber)
    expect(sortAddresses(await getAccounts(reorgUserNetworkId))).toEqual(
        sortAddresses([reorgAnnouncement.stealthAddress])
    )
})
