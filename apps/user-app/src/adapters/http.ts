import type { HttpClient } from "@coordination-network/user-app-core"

/** `HttpClient` over Hermes' global fetch. A non-JSON body surfaces as a null body, not a throw. */
export const httpClient: HttpClient = {
    async getJson(url) {
        return read(await fetch(url))
    },
    async postJson(url, body) {
        return read(
            await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            })
        )
    }
}

async function read(response: Response) {
    const text = await response.text()
    try {
        return { status: response.status, body: JSON.parse(text) as unknown }
    } catch {
        return { status: response.status, body: null }
    }
}
