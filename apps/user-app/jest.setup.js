/* global jest */
// Swaps in the library's own mock, which reports fixed insets instead of throwing outside a
// SafeAreaProvider - components under test don't all wrap themselves in one.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)

// Reanimated's own jest setup: without it, an `entering` animation never resolves and the
// component under test renders at its initial opacity of 0.
require("react-native-reanimated").setUpTests()
