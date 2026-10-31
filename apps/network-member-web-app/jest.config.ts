import type { Config } from "jest"
const config: Config = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/tests"],
    moduleNameMapper: {
        "\\.css$": "<rootDir>/tests/style-mock.ts"
    }
}
export default config
