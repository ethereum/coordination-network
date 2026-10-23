const { jest } = require("@jest/globals")

// `src/config.ts` refuses to load without this, the way a build does; the suites that care about
// the other member set it themselves.
process.env.EXPO_PUBLIC_MEMBER_ID ??= "member-a"

// Reanimated's own jest setup: without it, an `entering` animation never resolves and the
// component under test renders at its initial opacity of 0.
require("react-native-reanimated").setUpTests()

jest.mock("@react-native-async-storage/async-storage", () =>
    require("@react-native-async-storage/async-storage/jest/async-storage-mock")
)
// Swaps in the library's own mock, which reports fixed insets instead of throwing outside a
// SafeAreaProvider - components under test don't all wrap themselves in one.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)
