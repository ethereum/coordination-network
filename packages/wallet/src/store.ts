/** Device secrets and credentials. String values, so SecureStore fits it as-is. */
export interface Store {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    /** SecureStore cannot enumerate itself, so that adapter keeps its own index. */
    list(): Promise<string[]>
}

/** Nothing survives a restart, so device builds pass their own. */
export class MemoryStore implements Store {
    private readonly entries = new Map<string, string>()

    async get(key: string): Promise<string | null> {
        return this.entries.get(key) ?? null
    }

    async set(key: string, value: string): Promise<void> {
        this.entries.set(key, value)
    }

    async delete(key: string): Promise<void> {
        this.entries.delete(key)
    }

    async list(): Promise<string[]> {
        return [...this.entries.keys()]
    }
}
