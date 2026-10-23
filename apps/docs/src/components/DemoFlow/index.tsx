import clsx from "clsx"
import type { ReactNode } from "react"
import styles from "./styles.module.css"

type Tone = "green" | "blue" | "yellow" | "neutral"
type Icon = "key" | "register" | "credential" | "proof" | "revoked"

type Step = {
    title: string
    line: string
    icon: Icon
    badges: { label: string; tone: Tone }[]
}

const steps: Step[] = [
    {
        title: "Create keys and a network ID",
        line: "Made on the phone. The keys never leave it.",
        icon: "key",
        badges: [{ label: "User wallet", tone: "green" }]
    },
    {
        title: "Register through a member",
        line: "Member A puts the ID on chain. The paymaster pays the gas.",
        icon: "register",
        badges: [{ label: "Member A", tone: "blue" }]
    },
    {
        title: "Issue a credential",
        line: "Member A signs the credential. The User wallet keeps it.",
        icon: "credential",
        badges: [{ label: "Member A", tone: "blue" }]
    },
    {
        title: "Check eligibility",
        line: "Member B learns you qualify, not who you are.",
        icon: "proof",
        badges: [{ label: "Member B", tone: "yellow" }]
    },
    {
        title: "Revoke a credential, then reuse the ID",
        line: "The dashboard revokes it and the next check fails. Member B finds the ID: you count once.",
        icon: "revoked",
        badges: [
            { label: "Dashboard", tone: "neutral" },
            { label: "Member B", tone: "yellow" }
        ]
    }
]

function Document(): ReactNode {
    return (
        <>
            <path d="M27 40H9V5h24l6 6v14M33 5v8h6M15 18h16m-16 7h11m-11 7h7" />
            <circle cx="35" cy="34" r="8" />
        </>
    )
}

function StepIcon({ kind }: { kind: Icon }): ReactNode {
    return (
        <svg className={styles.icon} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            {kind === "key" && (
                <>
                    <circle cx="14" cy="34" r="7" />
                    <path d="m19 29 21-21m-5 5 4 4m-9 1 4 4" />
                </>
            )}
            {kind === "register" && (
                <>
                    <circle cx="19" cy="15" r="7" />
                    <path d="M6 42c0-8 6-14 13-14s13 6 13 14M38 10v12M32 16h12" />
                </>
            )}
            {kind === "credential" && (
                <>
                    <Document />
                    <path d="m31 34 3 3 5-6" />
                </>
            )}
            {kind === "proof" && (
                <>
                    <path d="m24 4 16 6v13c0 9-7 16-16 21C15 39 8 32 8 23V10l16-6Z" />
                    <path d="m16 23 6 6 11-12" />
                </>
            )}
            {kind === "revoked" && (
                <>
                    <Document />
                    <path d="m32 31 6 6m0-6-6 6" />
                </>
            )}
        </svg>
    )
}

export default function DemoFlow(): ReactNode {
    return (
        <div className={styles.flow}>
            <ol className={styles.steps} role="list" aria-label="What the demo shows">
                {steps.map((step) => (
                    <li className={clsx(styles.step, styles[step.badges[0].tone])} key={step.title}>
                        <span className={styles.illustration}>
                            <StepIcon kind={step.icon} />
                        </span>
                        <div className={styles.text}>
                            <strong>{step.title}</strong>
                            <span className={styles.line}>{step.line}</span>
                            <div className={styles.badges}>
                                <span className={styles.visuallyHidden}>Where: </span>
                                {step.badges.map((badge) => (
                                    <span className={clsx(styles.badge, styles[badge.tone])} key={badge.label}>
                                        {badge.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    )
}
