// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Revocation } from "../../src/revocation/Revocation.sol";
import { IRevocation } from "../../src/revocation/interfaces/IRevocation.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Semaphore } from "@semaphore-protocol/contracts/Semaphore.sol";
import { SemaphoreVerifier } from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { ISemaphoreVerifier } from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import { CanonicalDependencies } from "./CanonicalDependencies.sol";
import { CredentialRevocationRegistry } from "../../src/CredentialRevocationRegistry.sol";
import { NetworkMemberGate } from "../../src/base/NetworkMemberGate.sol";
import { NetworkMemberGroupFixture } from "./NetworkMemberGroupFixture.sol";

abstract contract CredentialRevocationRegistryTestBase is CanonicalDependencies, NetworkMemberGroupFixture {
    using stdJson for string;

    /// @dev The recent-root window Semaphore's `createGroup(admin)` gives the group.
    uint256 constant MERKLE_TREE_DURATION = 1 hours;

    /// @dev The accepted-root window `createRegistry(admin)` gives the registry.
    uint256 constant ROOT_DURATION = 1 hours;

    CredentialRevocationRegistry public revocationRegistry;
    Revocation public revocation;
    Semaphore public semaphore;

    address governance;
    uint256 networkMemberGroupId;

    /// @dev Every proof in test/fixtures/credential-revocation-proofs.json binds the chain id and the
    /// registry address, so the tests pin both. Regenerate with
    /// `yarn workspace coordination-network/network-member-proof generate:revocation-fixtures` (the
    /// package name is scoped, so prefix it with the usual at sign).
    string fixtures;
    address fixtureRegistry;
    uint256[] memberCommitments;
    uint256 newcomerCommitment;
    uint256 commitmentA;
    uint256 commitmentB;
    uint256 commitmentC;

    function setUp() public {
        fixtures = vm.readFile("./test/fixtures/credential-revocation-proofs.json");
        fixtureRegistry = fixtures.readAddress(".registry");
        memberCommitments = fixtures.readUintArray(".memberCommitments");
        newcomerCommitment = fixtures.readUint(".newcomerCommitment");
        commitmentA = fixtures.readUint(".commitmentA");
        commitmentB = fixtures.readUint(".commitmentB");
        commitmentC = fixtures.readUint(".commitmentC");

        vm.chainId(fixtures.readUint(".chainId"));

        governance = makeAddr("governance");
        semaphore = new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));

        // The group is created and administered outside the registry, which is only pointed at it.
        networkMemberGroupId = semaphore.createGroup(governance);

        // A standalone deployment. The registry creates its own registry on it and admins it.
        revocation = new Revocation();

        deployCodeTo(
            "CredentialRevocationRegistry.sol:CredentialRevocationRegistry",
            abi.encode(ISemaphore(address(semaphore)), networkMemberGroupId, IRevocation(address(revocation))),
            fixtureRegistry
        );
        revocationRegistry = CredentialRevocationRegistry(fixtureRegistry);

        // The documented add path: governance admits the approved members on the Semaphore
        // contract, as the admin of the group.
        vm.prank(governance);
        semaphore.addMembers(networkMemberGroupId, memberCommitments);
    }

    /// @dev Loads a proof fixture by name, for example "revokeA".
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

    /// @dev The registry id the deployment allocated, for reads that go straight to the service.
    function _registryId() internal view returns (uint256) {
        return revocationRegistry.REGISTRY_ID();
    }

    /// @dev The physical index of the leaf that precedes `value` in sorted order. The service
    /// validates a predecessor index but never searches for one, so this stands in for the
    /// revocation-registry package. The naive scan is fine on a tiny test tree.
    function _lowLeafIndex(uint256 value) internal view returns (uint256) {
        uint256 leafCount = revocation.getRevocationTreeLeafCount(_registryId());

        if (leafCount == 0) return 0;

        for (uint256 i = 0; i < leafCount; ++i) {
            (uint256 leafValue, uint256 nextValue) = revocation.getLeaf(_registryId(), i);

            // Tombstones are `{0, 0}` and can never be a low leaf; the sentinel is `{0, > 0}`.
            if (leafValue == 0 && nextValue == 0 && i != 0) continue;

            if (leafValue < value && (nextValue > value || nextValue == 0)) return i;
        }

        revert("no low leaf found");
    }

    /// @dev The physical index of the leaf whose `nextValue` is `value`.
    function _predecessorIndex(uint256 value) internal view returns (uint256) {
        uint256 leafCount = revocation.getRevocationTreeLeafCount(_registryId());

        for (uint256 i = 0; i < leafCount; ++i) {
            (, uint256 nextValue) = revocation.getLeaf(_registryId(), i);

            if (nextValue == value) return i;
        }

        revert("no predecessor found");
    }

    /// @dev A one-element array, for the batch calls.
    function _one(uint256 value) internal pure returns (uint256[] memory array) {
        array = new uint256[](1);
        array[0] = value;
    }

    /// @dev A two-element array, for the batch calls.
    function _two(uint256 first, uint256 second) internal pure returns (uint256[] memory array) {
        array = new uint256[](2);
        array[0] = first;
        array[1] = second;
    }
}
