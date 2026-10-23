import { BRANDS } from "@coordination-network/app-ui"
import type { StackDescriptor, StackMember } from "./config"

/**
 * Stack fixtures for the screen tests: the real shape, obviously fake addresses. Lives outside
 * `__tests__` because jest treats every file under that directory as a suite of its own.
 */
export function testMember(overrides: Partial<StackMember> = {}): StackMember {
    return {
        name: "Member A",
        networkId: `0x${"11".repeat(32)}`,
        serverUrl: "http://192.168.1.10:3001",
        authAddress: `0x${"dd".repeat(20)}`,
        governanceSigner: `0x${"ee".repeat(20)}`,
        role: "founder",
        brand: BRANDS.blue,
        scheme: "memberapp",
        ...overrides
    }
}

export function testStack(members: StackMember[] = []): StackDescriptor {
    return {
        rpcUrl: "http://192.168.1.10:8545",
        chainId: 31337,
        identityRegistry: `0x${"11".repeat(20)}`,
        announcer: `0x${"22".repeat(20)}`,
        revocation: { address: `0x${"33".repeat(20)}`, registry: `0x${"3a".repeat(20)}`, registryId: "1" },
        semaphore: `0x${"44".repeat(20)}`,
        networkMemberRegistry: `0x${"55".repeat(20)}`,
        networkMemberGroup: `0x${"66".repeat(20)}`,
        networkMemberGovernance: `0x${"77".repeat(20)}`,
        approvedIssuerSet: `0x${"88".repeat(20)}`,
        governanceSafe: `0x${"99".repeat(20)}`,
        entryPoint: `0x${"aa".repeat(20)}`,
        paymaster: `0x${"bb".repeat(20)}`,
        accountImplementation: `0x${"cc".repeat(20)}`,
        bundlerUrl: "http://192.168.1.10:4337",
        dashboardUrl: "http://192.168.1.10:8080",
        members
    }
}
