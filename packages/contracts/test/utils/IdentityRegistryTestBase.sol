// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { stdJson } from "forge-std/StdJson.sol";
import { Semaphore } from "@semaphore-protocol/contracts/Semaphore.sol";
import { SemaphoreVerifier } from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { ISemaphoreVerifier } from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import { CanonicalDependencies } from "./CanonicalDependencies.sol";
import { IdentityRegistry } from "../../src/IdentityRegistry.sol";
import { NetworkMemberGate } from "../../src/base/NetworkMemberGate.sol";
import { NetworkMemberGroupFixture } from "./NetworkMemberGroupFixture.sol";

abstract contract IdentityRegistryTestBase is CanonicalDependencies, NetworkMemberGroupFixture {
    using stdJson for string;

    /// @dev The recent-root window Semaphore's `createGroup(admin)` gives the group.
    uint256 constant MERKLE_TREE_DURATION = 1 hours;

    IdentityRegistry public identityRegistry;
    Semaphore public semaphore;

    address governance;
    uint256 networkMemberGroupId;

    /// @dev The proofs in test/fixtures/network-member-proofs.json bind the chain id and the
    /// registry address, so the tests run on that chain id and deploy the registry to that address.
    /// Regenerate them with
    /// `yarn workspace coordination-network/network-member-proof generate:fixtures` (the package name
    /// is scoped, so prefix it with the usual at sign).
    string fixtures;
    address fixtureRegistry;
    uint256[] memberCommitments;
    uint256 newcomerCommitment;
    bytes32 networkIdA;
    bytes32 networkIdB;
    bytes metaA;
    bytes metaB;

    function setUp() public {
        fixtures = vm.readFile("./test/fixtures/network-member-proofs.json");
        fixtureRegistry = fixtures.readAddress(".registry");
        memberCommitments = fixtures.readUintArray(".memberCommitments");
        newcomerCommitment = fixtures.readUint(".newcomerCommitment");
        networkIdA = fixtures.readBytes32(".networkIdA");
        networkIdB = fixtures.readBytes32(".networkIdB");
        metaA = fixtures.readBytes(".metaA");
        metaB = fixtures.readBytes(".metaB");

        vm.chainId(fixtures.readUint(".chainId"));

        governance = makeAddr("governance");
        semaphore = new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));

        // The group is created and administered outside the registry, which is only pointed at it.
        networkMemberGroupId = semaphore.createGroup(governance);

        deployCodeTo(
            "IdentityRegistry.sol:IdentityRegistry",
            abi.encode(ISemaphore(address(semaphore)), networkMemberGroupId),
            fixtureRegistry
        );
        identityRegistry = IdentityRegistry(fixtureRegistry);

        // The documented add path: governance admits the approved members on the Semaphore
        // contract, as the admin of the group.
        vm.prank(governance);
        semaphore.addMembers(networkMemberGroupId, memberCommitments);
    }

    /// @dev Loads a proof fixture by name, for example "registerA".
    function _proof(string memory name) internal view returns (NetworkMemberGate.NetworkMemberProof memory proof) {
        string memory key = string.concat(".proofs.", name);

        proof.merkleTreeDepth = fixtures.readUint(string.concat(key, ".merkleTreeDepth"));
        proof.merkleTreeRoot = fixtures.readUint(string.concat(key, ".merkleTreeRoot"));
        proof.nullifier = fixtures.readUint(string.concat(key, ".nullifier"));
        proof.scope = fixtures.readUint(string.concat(key, ".scope"));

        uint256[] memory points = fixtures.readUintArray(string.concat(key, ".points"));
        for (uint256 i = 0; i < 8; ++i) {
            proof.points[i] = points[i];
        }
    }

    /// @dev Governance removes the member at `index` from the group, the documented remove path.
    function _removeNetworkMemberCommitment(uint256 index) internal {
        uint256[] memory siblings = _memberProofSiblings(memberCommitments, index);

        vm.prank(governance);
        semaphore.removeMember(networkMemberGroupId, memberCommitments[index], siblings);
    }
}
