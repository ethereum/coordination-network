import { parseAbi } from "viem"

/**
 * The Safe surface the demo drives directly.
 *
 * `@coordination-network/network-member-governance` encodes `approveHash` and `execTransaction`
 * against the Safe's own deployment ABI, so those two are not here. What is here is the state the
 * demo reads to show what governance changed, plus the two setup calls the Safe makes on itself.
 */
export const SAFE_ABI = parseAbi([
    "function nonce() view returns (uint256)",
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function isOwner(address owner) view returns (bool)",
    "function isModuleEnabled(address module) view returns (bool)",
    "function enableModule(address module)",
    "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)"
])

export const SAFE_PROXY_FACTORY_ABI = parseAbi([
    "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
    "event ProxyCreation(address indexed proxy, address singleton)"
])

/** The member registry surface the demo reads and writes, beyond what the governance package encodes. */
export const MEMBER_REGISTRY_ABI = parseAbi([
    "function isApproved(bytes32 memberNetworkId) view returns (bool)",
    "function identity(bytes32 memberNetworkId) view returns (bytes)",
    "function semaphoreCommitmentOf(bytes32 memberNetworkId) view returns (uint256)",
    "function governanceSignerOf(bytes32 memberNetworkId) view returns (address)",
    "function approvedIssuerSet() view returns (address)",
    "function approveNetworkMember(uint256 accountKeyX, uint256 accountKeyY, uint256 semaphoreCommitment, address governanceSigner)",
    "function registerNetworkMemberIdentity(bytes32 memberNetworkId, bytes newMetaStealthAddress)",
    "function setApprovedIssuerSet(address newApprovedIssuerSet)"
])

export const NETWORK_MEMBER_GROUP_ABI = parseAbi([
    "function GROUP_ID() view returns (uint256)",
    "function addNetworkMember(uint256 identityCommitment)",
    "function hasNetworkMember(uint256 identityCommitment) view returns (bool)",
    "function merkleTreeRoot() view returns (uint256)"
])

/**
 * The identity registry's write surface.
 *
 * Reads go through `IdentityRegistryClient` from `@coordination-network/network-member-client`, which
 * is what a member server uses, so the `identity` getter is deliberately absent here.
 */
export const IDENTITY_REGISTRY_ABI = parseAbi([
    "struct NetworkMemberProof { uint256 merkleTreeDepth; uint256 merkleTreeRoot; uint256 nullifier; uint256 scope; uint256[8] points; }",
    "function registerIdentity(bytes32 networkId, bytes metaStealthAddress, NetworkMemberProof proof)",
    "function updateIdentity(bytes32 networkId, bytes newMetaStealthAddress, NetworkMemberProof proof)",
    "function removeIdentity(bytes32 networkId, NetworkMemberProof proof)"
])

/** Semaphore's own surface. `groups` returns the group's recent-root window, in seconds. */
export const SEMAPHORE_ABI = parseAbi(["function groups(uint256 groupId) view returns (uint256 merkleTreeDuration)"])
