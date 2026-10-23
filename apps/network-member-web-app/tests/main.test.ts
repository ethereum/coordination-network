/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"http://localhost:4174"}
 */

const enrol = jest.fn(async () => ({ status: "submitted" }))
const issue = jest.fn(async () => ({ status: "issued" }))
const verify = jest.fn(async () => ({ status: "verified" }))
const revoke = jest.fn(async () => ({ status: "revoked" }))

jest.mock("@coordination-network/user-app-link", () => ({
    createLinkClient: jest.fn(() => ({}))
}))
jest.mock("@coordination-network/user-app-link/web", () => ({
    createRelayWebLinkTransport: jest.fn(() => ({ openUrl: jest.fn(), onUrl: jest.fn() })),
    browserSessionKey: jest.fn(() => "a".repeat(64))
}))
jest.mock("../src/flows", () => ({
    createMemberFlows: jest.fn(() => ({
        state: {},
        enrol,
        issue,
        status: jest.fn(),
        verify,
        revoke
    }))
}))
jest.mock("../src/business/branding", () => ({
    branding: { productName: "Demo", accentColor: "#245b3b" }
}))
jest.mock("../src/business/hooks", () => ({ loggingHooks: {} }))
jest.mock("../src/business/policy", () => ({
    programmeForMember: jest.fn(() => ({
        programme: "standard-access",
        programmeName: "Standard Access",
        country: "ZZZ",
        countryName: "Demo Country"
    })),
    policyForMember: jest.fn(() => ({}))
}))

describe("member journey actions", () => {
    beforeEach(async () => {
        document.body.innerHTML = '<div id="root"></div>'
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith("/v1/admission")) {
                return {
                    ok: true,
                    json: async () => ({
                        candidateName: "eve",
                        profileUrl: "https://example.invalid/eve/membership.json",
                        state: "pending",
                        approvals: [],
                        threshold: 2,
                        canRequest: false,
                        canApprove: true,
                        canLeave: false,
                        hasApproved: false,
                        issuerRoot: "1",
                        earlyCompletionBlocked: false,
                        outdatedDecisionBlocked: true
                    })
                }
            }
            if (url.endsWith("/v1/admission/approve")) {
                return {
                    ok: true,
                    json: async () => ({
                        candidateName: "eve",
                        profileUrl: "https://example.invalid/eve/membership.json",
                        state: "pending",
                        approvals: ["alpha"],
                        threshold: 2,
                        canRequest: false,
                        canApprove: false,
                        canLeave: false,
                        hasApproved: true,
                        issuerRoot: "1",
                        earlyCompletionBlocked: true,
                        outdatedDecisionBlocked: true
                    })
                }
            }
            return {
                ok: true,
                json: async () => ({
                    apps: { user: { origin: "http://localhost:4173" }, relay: { url: "http://localhost:4177" } },
                    members: [
                        {
                            name: "alpha",
                            appOrigin: "http://localhost:4174",
                            serverUrl: "http://localhost:3001",
                            approved: true,
                            memberServerToken: "member-server-token"
                        }
                    ]
                })
            }
        }) as jest.Mock
        jest.resetModules()
        await import("../src/main")
        await new Promise((resolve) => setTimeout(resolve, 25))
    })

    it("uses the private member key rather than the descriptor's legacy token", () => {
        const requests = (global.fetch as jest.Mock).mock.calls
        const admission = requests.find(([url]) => String(url).endsWith("/v1/admission"))
        expect(admission?.[1].headers.authorization).toBe(`Bearer ${"a".repeat(64)}`)
    })

    it("requests registration only when the operator asks", async () => {
        expect(enrol).not.toHaveBeenCalled()
        expect(document.querySelector("h1")?.textContent).toBe("Register a user")
        expect(document.querySelector("iframe")).toBeNull()

        document.querySelector<HTMLButtonElement>('[data-action="enrol"]')!.click()
        await new Promise((resolve) => setTimeout(resolve, 25))
        expect(enrol).toHaveBeenCalledTimes(1)
        expect(document.querySelector("h1")?.textContent).toBe("Issue a participation approval")

        document.querySelector<HTMLButtonElement>('[data-action="issue"]')!.click()
        await new Promise((resolve) => setTimeout(resolve, 25))
        expect(issue).toHaveBeenCalledTimes(1)
        expect(document.querySelector("h1")?.textContent).toBe("The user is approved to participate")
    })

    it("lets an existing member approve a membership request", async () => {
        const membershipButton = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
            (button) => button.textContent === "Network membership"
        )!
        membershipButton.click()
        await new Promise((resolve) => setTimeout(resolve, 25))

        expect(document.querySelector("h1")?.textContent).toBe("Eve wants to join")
        const approve = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent === "Approve Eve"
        )!
        approve.click()
        await new Promise((resolve) => setTimeout(resolve, 25))

        expect(global.fetch).toHaveBeenCalledWith("http://localhost:3001/v1/admission/approve", {
            method: "POST",
            headers: { authorization: `Bearer ${"a".repeat(64)}` }
        })
        expect(document.body.textContent).toContain("You approved this membership request.")
    })
})

it("starts with the public descriptor and links to the member status page when admission is unavailable", async () => {
    document.body.innerHTML = '<div id="root"></div>'
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/v1/admission")
            ? { ok: false, status: 404 }
            : {
                  ok: true,
                  json: async () => ({
                      chainId: 31337,
                      identityRegistry: `0x${"22".repeat(20)}`,
                      members: [
                          {
                              name: "Member A",
                              networkId: `0x${"11".repeat(32)}`,
                              serverUrl: "http://localhost:3001",
                              role: "founder",
                              scheme: "membera"
                          }
                      ]
                  })
              }
    ) as jest.Mock
    jest.resetModules()
    await import("../src/main")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(document.title).toBe("Member A · Demo")
    expect(document.body.textContent).not.toContain("We couldn’t open this service")
    const membership = [...document.querySelectorAll<HTMLButtonElement>("header button")].find(
        (button) => button.textContent === "Network membership"
    )!
    membership.click()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(document.querySelector<HTMLAnchorElement>('a[href="http://localhost:3001"]')?.textContent).toContain(
        "Open member status"
    )
})
