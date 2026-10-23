export function cleanWalletUrl(href: string): string {
    const url = new URL(href)
    return `${url.origin}${url.pathname}`
}

export async function resetWallet(store: { clear(): Promise<void>; list(): Promise<string[]> }): Promise<void> {
    await store.clear()
    const remaining = await store.list()
    if (remaining.length > 0) throw new Error("Wallet data could not be removed")
}
