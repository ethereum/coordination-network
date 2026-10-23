import CodeBlock from "@theme/CodeBlock"
import TabItem from "@theme/TabItem"
import Tabs from "@theme/Tabs"

const managers = [
    { label: "npm", value: "npm", command: "npm install" },
    { label: "Yarn", value: "yarn", command: "yarn add" },
    { label: "pnpm", value: "pnpm", command: "pnpm add" }
]

// The shared groupId keeps the chosen package manager in sync across every install block
export default function InstallPackages({ packages }: { packages: string[] }) {
    const names = packages.map((name) => `@coordination-network/${name}`).join(" ")

    return (
        <Tabs groupId="package-manager">
            {managers.map(({ label, value, command }) => (
                <TabItem key={value} value={value} label={label}>
                    <CodeBlock language="bash">{`${command} ${names}`}</CodeBlock>
                </TabItem>
            ))}
        </Tabs>
    )
}
