// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";
import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { IssuerRegistryService } from "../../src/issuer-registry/base/IssuerRegistryService.sol";
import { IssuerRegistry } from "../../src/issuer-registry/poseidon/IssuerRegistry.sol";
import { CanonicalDependencies } from "./CanonicalDependencies.sol";

/// @dev Shared fixture. Also stands in for the off-chain half of the protocol: the contract checks
/// Merkle siblings but never computes them, so tests rebuild the tree from {getLeaf} the same way the
/// issuer-registry package does. The rebuild is deliberately naive and only acceptable because tests
/// keep registries tiny.
abstract contract IssuerRegistryTestBase is CanonicalDependencies {
    IssuerRegistryService internal issuerRegistry;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    uint256 internal registryId;

    function setUp() public virtual {
        issuerRegistry = deployIssuerRegistry();

        vm.prank(admin);
        registryId = issuerRegistry.createRegistry();
    }

    /// @dev The deployable under test. Each hash's suite overrides it with its own deployable.
    function deployIssuerRegistry() internal virtual returns (IssuerRegistryService) {
        return new IssuerRegistry();
    }

    /// @dev The largest commitment the deployable's tree accepts.
    function maxCommitment() internal pure virtual returns (uint256) {
        return SNARK_SCALAR_FIELD - 1;
    }

    /// @dev The deployable's internal node hash.
    function hashNodes(uint256 left, uint256 right) internal view virtual returns (uint256) {
        return PoseidonT3.hash([left, right]);
    }

    /// @dev Every level of the tree, rebuilt from the contract's leaves. LeanIMT promotes an unpaired
    /// node unchanged.
    function levels(uint256 id) internal view returns (uint256[][] memory nodes) {
        uint256 size = issuerRegistry.getIssuerTreeSize(id);
        uint256 depth = issuerRegistry.getIssuerTreeDepth(id);

        nodes = new uint256[][](depth + 1);
        nodes[0] = new uint256[](size);

        for (uint256 i = 0; i < size; ++i) {
            nodes[0][i] = issuerRegistry.getLeaf(id, i);
        }

        for (uint256 level = 0; level < depth; ++level) {
            uint256[] memory children = nodes[level];
            uint256[] memory parents = new uint256[]((children.length + 1) / 2);

            for (uint256 i = 0; i < parents.length; ++i) {
                parents[i] =
                    2 * i + 1 < children.length ? hashNodes(children[2 * i], children[2 * i + 1]) : children[2 * i];
            }

            nodes[level + 1] = parents;
        }
    }

    /// @dev The root rebuilt from the contract's leaves alone.
    function rebuiltRoot(uint256 id) internal view returns (uint256) {
        if (issuerRegistry.getIssuerTreeSize(id) == 0) return 0;

        uint256[][] memory nodes = levels(id);

        return nodes[nodes.length - 1][0];
    }

    /// @dev The siblings `removeIssuer` and `updateIssuerCommitment` take: one per level where the
    /// commitment's node has a sibling, bottom up.
    function siblingNodes(uint256 id, uint256 commitment) internal view returns (uint256[] memory siblings) {
        uint256[][] memory nodes = levels(id);
        uint256 index = issuerRegistry.indexOf(id, commitment);
        uint256[] memory buffer = new uint256[](nodes.length);
        uint256 count;

        for (uint256 level = 0; level + 1 < nodes.length; ++level) {
            uint256 sibling = index ^ 1;

            if (sibling < nodes[level].length) buffer[count++] = nodes[level][sibling];

            index >>= 1;
        }

        siblings = new uint256[](count);

        for (uint256 i = 0; i < count; ++i) {
            siblings[i] = buffer[i];
        }
    }

    /// @dev Adds as the registry admin.
    function add(uint256 id, uint256 commitment) internal {
        vm.prank(issuerRegistry.getRegistryAdmin(id));
        issuerRegistry.addIssuer(id, commitment);
    }

    /// @dev Removes as the registry admin, computing the siblings first.
    function remove(uint256 id, uint256 commitment) internal {
        uint256[] memory siblings = siblingNodes(id, commitment);

        vm.prank(issuerRegistry.getRegistryAdmin(id));
        issuerRegistry.removeIssuer(id, commitment, siblings);
    }

    /// @dev Replaces a commitment in place as the registry admin, computing the siblings first.
    function update(uint256 id, uint256 oldCommitment, uint256 newCommitment) internal {
        uint256[] memory siblings = siblingNodes(id, oldCommitment);

        vm.prank(issuerRegistry.getRegistryAdmin(id));
        issuerRegistry.updateIssuerCommitment(id, oldCommitment, newCommitment, siblings);
    }
}
