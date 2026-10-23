const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)

// A wedged watchman daemon blocks Metro's file map forever; the node
// crawler/watcher is fast enough for a workspace this small.
config.resolver.useWatchman = false

module.exports = config
