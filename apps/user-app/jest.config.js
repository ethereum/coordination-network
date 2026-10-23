module.exports = {
    preset: "jest-expo",
    setupFiles: ["<rootDir>/jest.setup.js"],
    testEnvironmentOptions: {
        customExportConditions: ["node"]
    }
}
