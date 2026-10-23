import type { Config } from "jest"
const config: Config = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/tests"],
    moduleNameMapper: {
        "\\.css$": "<rootDir>/tests/style-mock.ts",
        "@coordination-network/(.*)/(.*)": "<rootDir>/../../packages/$1/src/$2",
        "@coordination-network/(.*)": "<rootDir>/../../packages/$1/src"
    }
}
export default config
