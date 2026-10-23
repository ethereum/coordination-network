import type { HttpClient, HttpJsonResponse } from "../../src/types"

type Route = (body?: unknown) => HttpJsonResponse | Promise<HttpJsonResponse>

/** A three-line HTTP fake: routes by exact URL, records every request for assertions. */
export class FakeHttpClient implements HttpClient {
    readonly posts: { url: string; body: unknown }[] = []
    readonly gets: string[] = []
    private readonly getRoutes = new Map<string, Route>()
    private readonly postRoutes = new Map<string, Route>()

    onGet(url: string, route: Route): void {
        this.getRoutes.set(url, route)
    }

    onPost(url: string, route: Route): void {
        this.postRoutes.set(url, route)
    }

    async getJson(url: string): Promise<HttpJsonResponse> {
        this.gets.push(url)
        const route = this.getRoutes.get(url)
        if (!route) throw new Error(`FakeHttpClient: no GET route registered for ${url}`)
        return route()
    }

    async postJson(url: string, body: unknown): Promise<HttpJsonResponse> {
        this.posts.push({ url, body })
        const route = this.postRoutes.get(url)
        if (!route) throw new Error(`FakeHttpClient: no POST route registered for ${url}`)
        return route(body)
    }
}
