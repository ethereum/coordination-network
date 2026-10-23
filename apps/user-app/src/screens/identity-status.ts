import type { BadgeTone } from "@coordination-network/app-ui"

export interface RegistrationInput {
    hasStack: boolean
    /** `null` while the chain read is in flight. */
    registered: boolean | null
    chainUnreachable: boolean
}

export interface RegistrationStatus {
    label: string
    tone: BadgeTone
}

export function registrationStatus({ hasStack, registered, chainUnreachable }: RegistrationInput): RegistrationStatus {
    if (!hasStack) return { label: "Configure the stack", tone: "neutral" }
    if (chainUnreachable) return { label: "Chain unreachable", tone: "warning" }
    if (registered === null) return { label: "Checking…", tone: "neutral" }
    return registered ? { label: "Registered", tone: "accent" } : { label: "Not registered", tone: "warning" }
}
