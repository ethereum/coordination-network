import { requiresUserReview } from "../src/request-policy"

describe("wallet request policy", () => {
    it.each(["registration.sign", "credential.issue", "presentation.create", "future.operation"])(
        "asks the user to review %s",
        (operation) => expect(requiresUserReview(operation)).toBe(true)
    )
})
