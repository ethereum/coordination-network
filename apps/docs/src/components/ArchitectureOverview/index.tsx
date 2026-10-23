import type { ReactNode } from "react"
import styles from "./styles.module.css"

function WalletIcon({ x, y }: { x: number; y: number }): ReactNode {
    return (
        <g className={styles.icon} transform={`translate(${x} ${y})`}>
            <path d="M4 10V5h20v5" />
            <rect x="2" y="10" width="26" height="18" rx="3" />
            <path d="M28 16h-9v7h9m-5-3.5h.1" />
        </g>
    )
}

function MemberIcon({ x, y }: { x: number; y: number }): ReactNode {
    return (
        <g className={styles.icon} transform={`translate(${x} ${y})`}>
            <path d="m2 10 13-7 13 7H2Zm4 4v11m9-11v11m9-11v11M2 29h26" />
        </g>
    )
}

export default function ArchitectureOverview(): ReactNode {
    return (
        <figure
            className={styles.figure}
            role="img"
            aria-label="Architecture overview. Wallets hold keys and credentials. Member apps and servers issue approvals and verify eligibility proofs. Credentials and proofs are exchanged off chain. Wallets read shared state; members register wallets and record revocation. Shared contracts on Ethereum record membership, registrations, approved issuers, and revocation state."
        >
            <figcaption>The parts of the network</figcaption>
            <svg className={styles.wide} viewBox="0 0 760 226" aria-hidden="true" focusable="false">
                <rect className={styles.node} x="1" y="24" width="235" height="82" rx="12" />
                <rect className={styles.node} x="524" y="24" width="235" height="82" rx="12" />
                <WalletIcon x={18} y={43} />
                <MemberIcon x={540} y={43} />
                <g className={styles.title}>
                    <text x="60" y="51">
                        Wallets
                    </text>
                    <text x="582" y="51">
                        Member apps
                    </text>
                </g>
                <g className={styles.detail}>
                    <text x="60" y="75">
                        Keys and credentials
                    </text>
                    <text x="582" y="72">
                        and servers
                    </text>
                    <text x="542" y="92">
                        Issue approvals · verify proofs
                    </text>
                </g>
                <g className={styles.arrow}>
                    <path d="M510 53H250m6-5-6 5 6 5M250 94h260m-6-5 6 5-6 5" />
                    <path d="M230 158v-30H118v-16m-5 6 5-6 5 6" />
                    <path d="M642 112v16H530v30m-5-6 5 6 5-6" />
                </g>
                <g className={styles.edgeLabel} textAnchor="middle">
                    <text x="380" y="13">
                        Off chain
                    </text>
                    <text x="380" y="43">
                        Credentials
                    </text>
                    <text x="380" y="84">
                        Proofs
                    </text>
                    <text x="118" y="151">
                        Read shared state
                    </text>
                    <text x="642" y="151">
                        Register · revoke
                    </text>
                </g>
                <rect className={styles.contracts} x="160" y="159" width="440" height="66" rx="12" />
                <text className={styles.title} x="380" y="185" textAnchor="middle">
                    Shared contracts · Ethereum
                </text>
                <text className={styles.detail} x="380" y="207" textAnchor="middle">
                    Membership · registrations · approved issuers · revocation
                </text>
            </svg>
            <svg className={styles.narrow} viewBox="0 0 320 314" aria-hidden="true" focusable="false">
                <g className={styles.arrow}>
                    <path d="M250 48V26H70v22m-5-6 5 6 5-6" />
                    <path d="M70 142v20h180v-20m-5 6 5-6 5 6" />
                    <path d="M35 243V142m-5 6 5-6 5 6M285 142v101m-5-6 5 6 5-6" />
                </g>
                <rect className={styles.node} x="1" y="49" width="139" height="92" rx="12" />
                <rect className={styles.node} x="180" y="49" width="139" height="92" rx="12" />
                <WalletIcon x={55} y={58} />
                <MemberIcon x={235} y={58} />
                <g className={styles.title} textAnchor="middle">
                    <text x="70" y="108">
                        Wallets
                    </text>
                    <text x="250" y="104">
                        Member apps
                    </text>
                </g>
                <g className={styles.detail} textAnchor="middle">
                    <text x="70" y="128">
                        Keys · credentials
                    </text>
                    <text x="250" y="119">
                        and servers
                    </text>
                    <text x="250" y="135">
                        Issue · verify
                    </text>
                </g>
                <g className={styles.edgeLabel} textAnchor="middle">
                    <text x="160" y="16">
                        Credentials · off chain
                    </text>
                    <text x="160" y="183">
                        Proofs · off chain
                    </text>
                </g>
                <g className={styles.edgeLabel}>
                    <text x="48" y="222">
                        Read state
                    </text>
                    <text x="272" y="222" textAnchor="end">
                        Register · revoke
                    </text>
                </g>
                <rect className={styles.contracts} x="1" y="244" width="318" height="69" rx="12" />
                <text className={styles.title} x="160" y="267" textAnchor="middle">
                    Shared contracts · Ethereum
                </text>
                <g className={styles.detail} textAnchor="middle">
                    <text x="160" y="287">
                        Membership · registrations
                    </text>
                    <text x="160" y="304">
                        Approved issuers · revocation
                    </text>
                </g>
            </svg>
        </figure>
    )
}
