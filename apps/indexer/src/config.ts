import { existsSync } from "node:fs"
import { createPublicClient, hexToBytes, http } from "viem"
import { z } from "zod"

// the environment is parsed the moment this module loads, so .env must load first
if (existsSync(".env")) process.loadEnvFile()

export const hex = (bytesLength: number) =>
    z.templateLiteral(["0x", z.string().regex(new RegExp(`^[0-9a-fA-F]{${bytesLength * 2}}$`))])

export const address = hex(20)
export const symmetricKey = hex(32)
export const authToken = hex(32)

const SAME_MACHINE_HOSTNAMES = ["localhost", "127.0.0.1"]

// only allow https or http on local machine
export const rpcUrl = z.url().refine(
    (value) => {
        const url = new URL(value)
        return SAME_MACHINE_HOSTNAMES.includes(url.hostname) || url.protocol === "https:"
    },
    { error: "RPC_URL must be https except on local machine" }
)

// sslmode: verify-full checks certificate is signed correctly AND that the hostname
// matches it. require only encrypts, so a substituted server still gets accepted
export const databaseUrl = z.url().refine(
    (value) => {
        const url = new URL(value)
        return SAME_MACHINE_HOSTNAMES.includes(url.hostname) || url.searchParams.get("sslmode") === "verify-full"
    },
    { error: "DATABASE_URL must set sslmode=verify-full outside of local development" }
)

export const trustedProxyAddress = z.union([z.ipv4(), z.cidrv4(), z.ipv6(), z.cidrv6()])

const envSchema = z.object({
    PORT: z.coerce.number().int().positive(),
    TRUSTED_PROXY_ADDRESS: trustedProxyAddress,
    RPC_URL: rpcUrl,
    ANNOUNCER_ADDRESS: address,
    TOKEN_ADDRESS: address,
    START_BLOCK: z.coerce.bigint().nonnegative(),
    SCAN_INTERVAL_MS: z.coerce.number().int().positive(),
    AUTH_TOKEN: authToken,
    ENCRYPTION_KEY: symmetricKey,
    LOOKUP_HASH_KEY: symmetricKey,
    DATABASE_URL: databaseUrl,
    MAX_BLOCK_SCAN_WINDOW_SIZE: z.coerce.number().int().positive(),
    CONFIRMATIONS: z.coerce.number().int().nonnegative(),
    LOG_LEVEL: z.enum(["trace", "debug", "info"]),
    LOG_FORMAT: z.enum(["json", "pretty"])
})

const env = envSchema.parse(process.env)

export const config = {
    port: env.PORT,
    trustedProxyAddress: env.TRUSTED_PROXY_ADDRESS,
    rpcUrl: env.RPC_URL,
    client: createPublicClient({
        transport: http(env.RPC_URL)
    }),
    announcer: env.ANNOUNCER_ADDRESS,
    // the member's scoped token contract.
    token: env.TOKEN_ADDRESS,
    startBlock: env.START_BLOCK,
    scanIntervalMs: env.SCAN_INTERVAL_MS,
    authToken: env.AUTH_TOKEN,
    // the AES key stored values are encrypted with, kept out of the database it protects
    encryptionKey: hexToBytes(env.ENCRYPTION_KEY),
    lookupHashKey: hexToBytes(env.LOOKUP_HASH_KEY),
    databaseUrl: env.DATABASE_URL,
    maxBlockScanWindowSize: env.MAX_BLOCK_SCAN_WINDOW_SIZE,
    confirmations: env.CONFIRMATIONS,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT
}
