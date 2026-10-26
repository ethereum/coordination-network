// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { ISafeGovernance } from "../../src/interfaces/ISafeGovernance.sol";
import { TestBase } from "../utils/TestBase.sol";

contract NetworkMemberGovernanceFuzzTest is TestBase {
    function testFuzz_governanceThreshold_IsAMajorityOfTheMemberCount(uint128 fuzzedMemberCount) public {
        uint256 memberCount = bound(fuzzedMemberCount, 1, type(uint128).max);
        NetworkMemberGovernance governance = new NetworkMemberGovernance(
            ISafeGovernance(makeAddr("safe")),
            NetworkMemberRegistry(makeAddr("registry")),
            NetworkMemberGroup(makeAddr("group"))
        );

        uint256 threshold = governance.governanceThreshold(memberCount);

        // threshold = memberCount / 2 + 1;
        assertEq(threshold, memberCount / 2 + 1);
    }
}
