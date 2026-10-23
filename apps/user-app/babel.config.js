module.exports = function (api) {
    api.cache(true)

    return {
        presets: ["babel-preset-expo"],
        // React Native's preset applies flow-strip-types to every file, `.ts` included, before its
        // own TypeScript override runs. Without this option that plugin rejects a `declare` class
        // field, which `@coordination-network/user-client` uses. Listed here so it runs first.
        plugins: [["@babel/plugin-transform-flow-strip-types", { allowDeclareFields: true }]]
    }
}
