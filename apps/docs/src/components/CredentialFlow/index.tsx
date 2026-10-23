import type { ReactNode } from "react"
import styles from "./styles.module.css"

const steps = [
    { label: "Member issues a credential", icon: "credential" },
    { label: "Wallet holds the credential", icon: "wallet" },
    { label: "Holder proves eligibility", icon: "proof" }
] as const

function StepIcon({ kind }: { kind: (typeof steps)[number]["icon"] }): ReactNode {
    return (
        <svg className={styles.icon} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            {kind === "credential" && (
                <>
                    <path d="M27 40H9V5h24l6 6v14M33 5v8h6M15 18h16m-16 7h11m-11 7h7" />
                    <circle cx="35" cy="34" r="8" />
                    <path d="m31 34 3 3 5-6" />
                </>
            )}
            {kind === "wallet" && (
                <>
                    <path d="M8 16V9h27v8M14 9V5h15v4" />
                    <rect x="5" y="17" width="38" height="25" rx="4" />
                    <path d="M43 25H32v9h11" />
                    <circle cx="36" cy="29.5" r="1" />
                </>
            )}
            {kind === "proof" && (
                <>
                    <path d="m24 4 16 6v13c0 9-7 16-16 21C15 39 8 32 8 23V10l16-6Z" />
                    <path d="m16 23 6 6 11-12" />
                </>
            )}
        </svg>
    )
}

export default function CredentialFlow(): ReactNode {
    return (
        <div className={styles.flow}>
            <ol className={styles.steps} aria-label="Credential flow" role="list">
                {steps.map((step, index) => (
                    <li className={styles.step} key={step.label}>
                        <span className={styles.illustration}>
                            <StepIcon kind={step.icon} />
                        </span>
                        <strong>{step.label}</strong>
                        {index < steps.length - 1 && (
                            <svg className={styles.arrow} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
                                <path d="M8 20h24m-7-7 7 7-7 7" />
                            </svg>
                        )}
                    </li>
                ))}
            </ol>
        </div>
    )
}
