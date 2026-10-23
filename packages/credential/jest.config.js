/** @type {import("jest").Config} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/tests"],
    moduleNameMapper: {
        "^@coordination-network/credential$": "<rootDir>/src/index.ts",
        "^@coordination-network/identity$": "<rootDir>/../identity/src/index.ts"
    }
}
