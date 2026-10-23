import { address, authToken, databaseUrl, rpcUrl, symmetricKey, trustedProxyAddress } from "../../src/config.ts"

test("hex rejects a value without the 0x prefix", () => {
    const result = address.safeParse("11".repeat(20))

    expect(result.success).toBe(false)
})

test("hex rejects a value with non-hex characters", () => {
    const result = address.safeParse(`0x${"zz".repeat(20)}`)

    expect(result.success).toBe(false)
})

test("hex rejects a value that is too short", () => {
    const result = address.safeParse(`0x${"11".repeat(19)}`)

    expect(result.success).toBe(false)
})

test("hex rejects a value that is too long", () => {
    const result = address.safeParse(`0x${"11".repeat(21)}`)

    expect(result.success).toBe(false)
})

test("hex accepts a value of exactly the given byte length", () => {
    const result = address.safeParse(`0x${"11".repeat(20)}`)

    expect(result.success).toBe(true)
})

test("authToken rejects a non hex token", () => {
    const result = authToken.safeParse("local-development-token")

    expect(result.success).toBe(false)
})

test("authToken accepts 32 bytes of hex", () => {
    const result = authToken.safeParse(`0x${"11".repeat(32)}`)

    expect(result.success).toBe(true)
})

test("symmetricKey rejects a non hex key", () => {
    const result = symmetricKey.safeParse("local-development-key")

    expect(result.success).toBe(false)
})

test("symmetricKey accepts 32 bytes of hex", () => {
    const result = symmetricKey.safeParse(`0x${"11".repeat(32)}`)

    expect(result.success).toBe(true)
})

test("rpcUrl rejects an unencrypted remote endpoint", () => {
    const result = rpcUrl.safeParse("http://eth-mainnet.g.alchemy.com/v2/secret")

    expect(result.success).toBe(false)
})

test("rpcUrl accepts a plaintext endpoint on local machine", () => {
    const result = rpcUrl.safeParse("http://127.0.0.1:8545")

    expect(result.success).toBe(true)
})

test("rpcUrl accepts a https remote endpoint", () => {
    const result = rpcUrl.safeParse("https://eth-mainnet.g.alchemy.com/v2/secret")

    expect(result.success).toBe(true)
})

test("databaseUrl rejects a remote database with no sslmode", () => {
    const result = databaseUrl.safeParse("postgres://user:pass@db.example.com:5432/indexer")

    expect(result.success).toBe(false)
})

test("databaseUrl rejects sslmode=require", () => {
    const result = databaseUrl.safeParse("postgres://user:pass@db.example.com:5432/indexer?sslmode=require")

    expect(result.success).toBe(false)
})

test("databaseUrl accepts sslmode=verify-full", () => {
    const result = databaseUrl.safeParse("postgres://user:pass@db.example.com:5432/indexer?sslmode=verify-full")

    expect(result.success).toBe(true)
})

test("databaseUrl accepts a database on this machine with no sslmode", () => {
    const result = databaseUrl.safeParse("postgres://postgres:postgres@127.0.0.1:5433/indexer")

    expect(result.success).toBe(true)
})

test("trustedProxyAddress accepts an IPv4 subnet", () => {
    const result = trustedProxyAddress.safeParse("10.0.1.0/24")

    expect(result.success).toBe(true)
})

test("trustedProxyAddress accepts an IPv4 address", () => {
    const result = trustedProxyAddress.safeParse("10.0.0.5")

    expect(result.success).toBe(true)
})

test("trustedProxyAddress accepts an IPv6 subnet", () => {
    const result = trustedProxyAddress.safeParse("fd00::/8")

    expect(result.success).toBe(true)
})

test("trustedProxyAddress accepts an IPv6 address", () => {
    const result = trustedProxyAddress.safeParse("::1")

    expect(result.success).toBe(true)
})

test("trustedProxyAddress rejects a hostname", () => {
    const result = trustedProxyAddress.safeParse("proxy.internal")

    expect(result.success).toBe(false)
})
