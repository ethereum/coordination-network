import type { Server } from "node:http"
import express from "express"
import { requireAuthToken } from "../../src/auth.ts"

const authToken = process.env.AUTH_TOKEN as string

let listener: Server
let url: string

beforeAll(() => {
    const app = express()
    app.use(requireAuthToken)
    app.get("/protected", (_request, response) => {
        response.json({ reached: true })
    })
    listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    url = `http://127.0.0.1:${port}`
})

afterAll(() => {
    listener.close()
})

test("requireAuthToken rejects a request with no authorization header", async () => {
    const response = await fetch(`${url}/protected`)

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects an empty authorization header", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: "" } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects a bare token with no scheme", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: authToken } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects another authorization scheme", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: `Basic ${authToken}` } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects a lowercase bearer scheme", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: `bearer ${authToken}` } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects a token that is a prefix of the real one", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${authToken.slice(0, -1)}` } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects a token with the real one as a prefix", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${authToken}x` } })

    expect(response.status).toBe(401)
})

test("requireAuthToken rejects a token of the right length that differs", async () => {
    const wrongToken = `${authToken.slice(0, -1)}${authToken.endsWith("x") ? "y" : "x"}`

    const response = await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${wrongToken}` } })

    expect(response.status).toBe(401)
})

test("requireAuthToken answers a rejection in the API's JSON error shape", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: "Bearer wrong-token" } })

    expect(await response.json()).toEqual({ error: "invalid auth token" })
})

test("requireAuthToken passes a request carrying the configured token", async () => {
    const response = await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${authToken}` } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reached: true })
})
