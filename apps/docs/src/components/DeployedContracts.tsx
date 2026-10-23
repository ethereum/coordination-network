import Heading from "@theme/Heading"

type Deployment = Record<string, unknown> & {
    chainId: number
    blockNumber: number
    thirdParty?: Record<string, string>
}

type RequireContext = { keys(): string[]; (key: string): Deployment }

// Only these chains are listed, so local deployment files such as 31337.json stay out of the docs
const networks: Record<number, { name: string; explorer: string }> = {
    11155111: { name: "Sepolia", explorer: "https://sepolia.etherscan.io" }
}

// Bundles every packages/contracts/deployments/<chainId>.json at build time
const deploymentFiles = (require as unknown as { context: (...args: unknown[]) => RequireContext }).context(
    "../../../../packages/contracts/deployments",
    false,
    /^\.\/\d+\.json$/
)

const deployments = deploymentFiles
    .keys()
    .map((key) => deploymentFiles(key))
    .filter(({ chainId }) => chainId in networks)

const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)

const contractName = (key: string) => key.charAt(0).toUpperCase() + key.slice(1)

function ContractList({ entries, deployment }: { entries: [string, string][]; deployment: Deployment }) {
    const { explorer } = networks[deployment.chainId]

    return (
        <ul>
            {entries.map(([key, address]) => {
                const id = deployment[`${key}Id`]

                return (
                    <li key={key}>
                        {contractName(key)}
                        {id !== undefined && ` (id ${id})`}:{" "}
                        <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
                            {address}
                        </a>
                    </li>
                )
            })}
        </ul>
    )
}

export default function DeployedContracts() {
    return (
        <div>
            {deployments.map((deployment) => {
                const { name, explorer } = networks[deployment.chainId]
                const contracts = Object.entries(deployment).filter((entry): entry is [string, string] =>
                    isAddress(entry[1])
                )
                const thirdParty = Object.entries(deployment.thirdParty ?? {}).filter(
                    (entry): entry is [string, string] => isAddress(entry[1])
                )

                return (
                    <div key={deployment.chainId}>
                        <Heading as="h2">{name}</Heading>
                        <p>
                            Chain ID <code>{deployment.chainId}</code>, deployed at block{" "}
                            <a href={`${explorer}/block/${deployment.blockNumber}`} target="_blank" rel="noreferrer">
                                {deployment.blockNumber}
                            </a>
                            .
                        </p>
                        <ContractList entries={contracts} deployment={deployment} />
                        {thirdParty.length > 0 && (
                            <>
                                <Heading as="h3">Third-party contracts</Heading>
                                <ContractList entries={thirdParty} deployment={deployment} />
                            </>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
