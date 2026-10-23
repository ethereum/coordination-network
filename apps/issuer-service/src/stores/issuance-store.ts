import { IssuanceRecord } from "../types"

export interface IssuanceStore {
    save(record: IssuanceRecord): Promise<void>
    get(jti: string): Promise<IssuanceRecord | undefined>
    list(): Promise<IssuanceRecord[]>
    delete(jti: string): Promise<boolean>
}

export class InMemoryIssuanceStore implements IssuanceStore {
    private readonly records = new Map<string, IssuanceRecord>()

    constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

    private prune(): void {
        const now = this.now()
        for (const [jti, record] of this.records) {
            if (record.exp <= now) this.records.delete(jti)
        }
    }

    async save(record: IssuanceRecord): Promise<void> {
        this.prune()
        this.records.set(record.jti, record)
    }

    async get(jti: string): Promise<IssuanceRecord | undefined> {
        this.prune()
        return this.records.get(jti)
    }

    async list(): Promise<IssuanceRecord[]> {
        this.prune()
        return [...this.records.values()]
    }

    async delete(jti: string): Promise<boolean> {
        return this.records.delete(jti)
    }
}
