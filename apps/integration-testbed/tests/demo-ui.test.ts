import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { test } from "node:test"
import { chromium, type Page } from "playwright-core"

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const base = process.env.DEMO_UI_HOST ?? "http://127.0.0.1"
const artifacts = new URL("../test-results/", import.meta.url).pathname

async function open(page: Page, port: number) {
    const response = await page.goto(`${base}:${port}/`, { waitUntil: "domcontentloaded" })
    assert.equal(response?.ok(), true, `${base}:${port} did not load`)
    await page.locator("main").waitFor()
}

async function approveRegistration(member: Page, wallet: Page) {
    await member.getByRole("button", { name: "Request registration" }).click()
    await wallet.getByRole("heading", { name: "Registration request" }).waitFor()
    await wallet.getByRole("button", { name: "Review request" }).click()
    await wallet.getByRole("heading", { name: "Continue with registration?" }).waitFor()
    await wallet.getByRole("button", { name: "Continue" }).click()
    await wallet.getByRole("heading", { name: "Identity registration" }).waitFor()
    await wallet.getByRole("button", { name: "Review request" }).click()
    await wallet.getByRole("heading", { name: "Register with this member?" }).waitFor()
    await wallet.getByRole("button", { name: "Confirm registration" }).click()
    await member.getByRole("heading", { name: "Issue a participation approval" }).waitFor()
}

async function issueApproval(member: Page, wallet: Page, memberName: string) {
    await member.getByRole("button", { name: "Issue approval" }).click()
    await member.getByRole("heading", { name: "The user is approved to participate" }).waitFor({ timeout: 30_000 })
    await wallet.getByText(`Issued by ${memberName}`).waitFor({ timeout: 30_000 })
}

async function verifyApproval(member: Page, wallet: Page) {
    await member.getByRole("button", { name: "Verify participation" }).click()
    await wallet.getByRole("heading", { name: "Approval verification" }).waitFor()
    await wallet.getByRole("button", { name: "Review request" }).click()
    await wallet.getByRole("heading", { name: "Confirm your participation approval?" }).waitFor()
    await wallet.getByRole("button", { name: "Confirm participation" }).click()
    await member.getByRole("heading", { name: "The approval is valid" }).waitFor({ timeout: 120_000 })
}

test("membership admission, multiple approvals, verification and revocation work across the demo pages", async (t) => {
    await mkdir(artifacts, { recursive: true })
    const browser = await chromium.launch({ executablePath: chrome, headless: true })
    t.after(async () => browser.close())
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const wallet = await context.newPage()
    const alpha = await context.newPage()
    const beta = await context.newPage()
    const eve = await context.newPage()
    for (const [name, page] of Object.entries({ wallet, alpha, beta, eve })) {
        page.on("console", (message) => {
            if (message.type() === "error") console.error(`[${name}] ${message.text()}`)
        })
        page.on("pageerror", (error) => console.error(`[${name}] ${error.stack ?? error.message}`))
    }

    try {
        await Promise.all([open(wallet, 4173), open(alpha, 4174), open(beta, 4175), open(eve, 4176)])
        await wallet.getByRole("heading", { name: "No approvals yet" }).waitFor()

        await eve.getByRole("button", { name: "Network membership" }).click()
        await eve.getByRole("heading", { name: "Join the coordination network" }).waitFor()
        await eve.getByRole("button", { name: "Request membership" }).click()
        await eve.getByRole("heading", { name: "Membership review in progress" }).waitFor({ timeout: 30_000 })

        await alpha.getByRole("button", { name: "Network membership" }).click()
        await alpha.getByRole("heading", { name: "Eve wants to join" }).waitFor()
        await alpha.getByRole("button", { name: "Approve Eve" }).click()
        await alpha.getByText("You approved this membership request.").waitFor({ timeout: 30_000 })

        await beta.getByRole("button", { name: "Network membership" }).click()
        await beta.getByRole("heading", { name: "Eve wants to join" }).waitFor()
        await beta.getByRole("button", { name: "Approve Eve" }).click()
        await beta.getByRole("heading", { name: "Eve joined the network" }).waitFor({ timeout: 30_000 })
        await eve.getByRole("heading", { name: "Eve joined the network" }).waitFor({ timeout: 30_000 })

        await alpha.getByRole("button", { name: "User approvals" }).click()
        await beta.getByRole("button", { name: "User approvals" }).click()
        await eve.getByRole("button", { name: "User approvals" }).click()

        await approveRegistration(alpha, wallet)
        await issueApproval(alpha, wallet, "Alpha")
        await approveRegistration(beta, wallet)
        await issueApproval(beta, wallet, "Beta")
        await approveRegistration(eve, wallet)
        await issueApproval(eve, wallet, "Eve")

        await assert.doesNotReject(() => wallet.getByText("Issued by Alpha").waitFor())
        await assert.doesNotReject(() => wallet.getByText("Issued by Beta").waitFor())
        assert.equal(await wallet.locator("article.pass").count(), 3)
        const alphaCard = wallet.locator("article.pass", { hasText: "Issued by Alpha" })
        const betaCard = wallet.locator("article.pass", { hasText: "Issued by Beta" })
        const eveCard = wallet.locator("article.pass", { hasText: "Issued by Eve" })
        await alphaCard.getByRole("heading", { name: "Standard Access" }).waitFor()
        await alphaCard.getByText("Demo Country", { exact: true }).waitFor()
        await betaCard.getByRole("heading", { name: "Extended Access" }).waitFor()
        await betaCard.getByText("Demo Country A", { exact: true }).waitFor()
        await eveCard.getByRole("heading", { name: "Priority Access" }).waitFor()
        await eveCard.getByText("Demo Country B", { exact: true }).waitFor()

        await verifyApproval(alpha, wallet)
        await verifyApproval(beta, wallet)
        await verifyApproval(eve, wallet)

        await alpha.getByRole("button", { name: "Revoke approval" }).click()
        await alpha.getByRole("heading", { name: "Participation approval withdrawn" }).waitFor({ timeout: 30_000 })
        await alphaCard.getByText("Revoked", { exact: true }).waitFor({ timeout: 30_000 })
        await betaCard.getByText("Active", { exact: true }).waitFor()

        await eve.getByRole("button", { name: "Network membership" }).click()
        await eve.getByRole("button", { name: "Leave network" }).click()
        await eve.getByRole("heading", { name: "Eve left the network" }).waitFor({ timeout: 30_000 })
        await eveCard.getByText("Unavailable", { exact: true }).waitFor({ timeout: 30_000 })
        await eveCard.getByText("This approval is no longer recognised").waitFor()

        await wallet.screenshot({ path: `${artifacts}/multiple-approvals.png`, fullPage: true })
    } catch (error) {
        await Promise.all([
            wallet.screenshot({ path: `${artifacts}/failure-wallet.png`, fullPage: true }),
            alpha.screenshot({ path: `${artifacts}/failure-alpha.png`, fullPage: true }),
            beta.screenshot({ path: `${artifacts}/failure-beta.png`, fullPage: true }),
            eve.screenshot({ path: `${artifacts}/failure-eve.png`, fullPage: true })
        ])
        throw error
    }
})
