import assert from "node:assert/strict"
import { test } from "node:test"
import { lanAddress, validateStackSettings } from "./members"
import { OperatorError } from "./operator-error"

// serve.ts reads the ports when the module loads, so these live in their own file: node's test
// runner gives each test file a fresh module registry, and serve.test.ts imports ./serve with the
// default env.
const VARIABLES = [
    "STACK_PORT",
    "STACK_BUNDLER_PORT",
    "STACK_DASHBOARD_PORT",
    "STACK_MEMBER_PORTS",
    "STACK_HOST"
] as const

async function withSettings(settings: Partial<Record<(typeof VARIABLES)[number], string>>, run: () => void) {
    const saved = VARIABLES.map((name) => [name, process.env[name]] as const)
    for (const name of VARIABLES) delete process.env[name]
    Object.assign(process.env, settings)
    try {
        run()
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

function refuses(variable: string): (error: unknown) => boolean {
    return (error) => error instanceof OperatorError && error.message.includes(variable)
}

test("importing the stack with a bad STACK_MEMBER_PORTS does not throw; the startup check does", async () => {
    process.env.STACK_MEMBER_PORTS = "3001,3002"
    try {
        const { validateStackSettings } = await import("./serve.js")

        assert.throws(() => validateStackSettings(), /STACK_MEMBER_PORTS must be exactly three comma-separated ports/)
    } finally {
        delete process.env.STACK_MEMBER_PORTS
    }
})

test("the startup check accepts the defaults and a full set of valid settings", async () => {
    await withSettings({}, () => validateStackSettings())
    await withSettings(
        {
            STACK_PORT: "8545",
            STACK_BUNDLER_PORT: "4337",
            STACK_DASHBOARD_PORT: "65535",
            STACK_MEMBER_PORTS: "3001, 3002,3003",
            STACK_HOST: "192.168.1.20"
        },
        () => validateStackSettings()
    )
})

test("the startup check names a port that is not an integer from 1 to 65535", async () => {
    for (const variable of ["STACK_PORT", "STACK_BUNDLER_PORT", "STACK_DASHBOARD_PORT"] as const) {
        for (const bad of ["0", "65536", "80.5", "abc", "-1", "1e3"]) {
            await withSettings({ [variable]: bad }, () =>
                assert.throws(() => validateStackSettings(), refuses(variable), `${variable}=${bad}`)
            )
        }
    }
    for (const bad of ["3001,3002,0", "3001,3002,70000", "3001,3002,abc", "3001,3002,"]) {
        await withSettings({ STACK_MEMBER_PORTS: bad }, () =>
            assert.throws(() => validateStackSettings(), refuses("STACK_MEMBER_PORTS"), bad)
        )
    }
})

test("STACK_HOST must be an IPv4 literal other than 0.0.0.0", async () => {
    for (const bad of ["localhost", "stack.example.test", "0.0.0.0", "::1", "192.168.1", "192.168.1.20:8080"]) {
        await withSettings({ STACK_HOST: bad }, () => {
            assert.throws(() => validateStackSettings(), refuses("STACK_HOST"), bad)
            assert.throws(() => lanAddress(), refuses("STACK_HOST"), bad)
        })
    }
    await withSettings({ STACK_HOST: "127.0.0.1" }, () => assert.equal(lanAddress(), "127.0.0.1"))
})

test("STACK_HOST refuses an IPv4 lookalike: an octet out of range, extra octets, or padding", async () => {
    for (const bad of ["256.1.1.1", "1.2.3.4.5", " 127.0.0.1", "127.0.0.1 ", "127.0.0.01x"]) {
        await withSettings({ STACK_HOST: bad }, () =>
            assert.throws(() => validateStackSettings(), refuses("STACK_HOST"), bad)
        )
    }
})

test("a blank port or host setting is the default, and a padded port is read as its number", async () => {
    await withSettings({ STACK_PORT: "  ", STACK_DASHBOARD_PORT: "", STACK_HOST: "  " }, () => validateStackSettings())
    await withSettings({ STACK_PORT: " 8545 ", STACK_MEMBER_PORTS: " 3001 , 3002 , 3003 " }, () =>
        validateStackSettings()
    )
})
