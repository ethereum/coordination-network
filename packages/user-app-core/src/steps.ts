/**
 * The steps `credential.issue` reports, in the order it reports them. Named here rather than
 * spelled out twice, so the screen that groups the six into the three a person approved cannot
 * drift from the handler reporting them.
 */
export const CREDENTIAL_ISSUE_STEPS = {
    held: "Checking what you hold",
    lists: "Checking the lists",
    challenge: "Getting a challenge",
    binding: "Binding to this phone",
    signing: "Asking the issuer to sign",
    storing: "Saving to your wallet"
} as const
