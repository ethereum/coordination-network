// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";
import { IssuerSetHashes } from "./libraries/IssuerSetHashes.sol";
import { IApprovedIssuerSet } from "./interfaces/IApprovedIssuerSet.sol";
import { NetworkMemberRegistry } from "./NetworkMemberRegistry.sol";

/// @title ApprovedIssuerSet
/// @notice Accumulator over approved network members' credential signing keys.
/// @dev A verifier reads only the root, and the circuit proves in zero knowledge that the key which
/// signed a credential is in the set. That is what lets a verifier learn an approved member issued a
/// credential without learning which one, so this contract deliberately offers no way to answer
/// "whose key signed this" as part of a verification.
///
/// The tree is a LeanIMT: `nodes[level][index]` holds every node this contract has ever written,
/// level 0 the leaves and level `depth()` the current root. Pairing is keyed on level width, never on
/// zero-ness — the last node of an odd-width level promotes to its parent unchanged instead of hashing
/// against a zero pad. {MAX_DEPTH} only bounds capacity; the live root's level tracks
/// `ceil(log2(leafCount))`.
///
/// `leafCount` never decreases, so a pairing never reverts to a promotion, and every node a write
/// changes is an ancestor of a leaf slot the write touched. That is what keeps writes witness-free:
/// {_recomputePaths} only ever walks up the dirty leaves' own ancestors, never a full tree or a zero
/// cascade.
contract ApprovedIssuerSet is IApprovedIssuerSet {
    /// @notice The tree's maximum depth. A capacity bound only — the live root's actual depth is
    /// {depth}.
    uint256 public constant MAX_DEPTH = 20;

    /// @notice The tree's leaf capacity, `2^MAX_DEPTH`.
    uint256 public constant MAX_LEAVES = 2 ** MAX_DEPTH;

    /// @notice The accepted-root window the set gets unless governance changes it.
    uint256 public constant DEFAULT_ROOT_DURATION = 1 hours;

    /// @notice How many live signing keys one member may hold.
    /// @dev Bounds how many retirements {retireAllIssuerKeys} performs in one call, so a member
    /// cannot make its own removal unaffordable by publishing without limit. Removal cost here is
    /// `MAX_ISSUER_KEYS_PER_MEMBER` batched tree writes, not a function of the set's total size —
    /// unlike the predecessor-scanning tree this contract replaced, this cap is the whole removal-cost
    /// story.
    uint256 public constant MAX_ISSUER_KEYS_PER_MEMBER = 8;

    /// @dev Baby Jubjub in twisted Edwards form: `a·x² + y² = 1 + d·x²·y²` over the BN254 scalar field.
    uint256 private constant CURVE_A = 168_700;
    uint256 private constant CURVE_D = 168_696;

    /// @dev The x coordinates of Baby Jubjub's eight low-order points. The curve has cofactor 8, and
    /// for each x below every y satisfying the curve equation gives a low-order point: two for x = 0,
    /// two each for the order-8 pair, and the single y = 0 for the other two. So rejecting these five
    /// x coordinates rejects exactly those eight points and no key of full order.
    uint256 private constant LOW_ORDER_X_0 = 0;
    uint256 private constant LOW_ORDER_X_1 =
        2_957_874_849_018_779_266_517_920_829_765_869_116_077_630_550_401_372_566_248_359_756_137_677_864_698;
    uint256 private constant LOW_ORDER_X_2 =
        4_342_719_913_949_491_028_786_768_530_115_087_822_524_712_248_835_451_589_697_801_404_893_164_183_326;
    uint256 private constant LOW_ORDER_X_3 =
        17_545_522_957_889_784_193_459_637_215_142_187_266_023_652_151_580_582_754_000_402_781_682_644_312_291;
    uint256 private constant LOW_ORDER_X_4 =
        18_930_368_022_820_495_955_728_484_915_491_405_972_470_733_850_014_661_777_449_844_430_438_130_630_919;

    /// @inheritdoc IApprovedIssuerSet
    address public immutable override memberRegistry;

    /// @dev The accumulator. `nodes[0]` are leaves, `nodes[depth()][0]` is the root. A leaf slot with
    /// no entry reads 0, meaning "never written" or "retired". Above level 0, 0 means "never written"
    /// or a promoted tombstone: retiring a promoted leaf zeros every promoted copy above it, and the
    /// copy where that chain pairs is a live zero sibling. Pairing is keyed on level width, never on a
    /// node being zero.
    mapping(uint256 level => mapping(uint256 index => uint256 node)) internal nodes;

    /// @notice The number of leaf slots ever written, including retired ones. Never decreases.
    /// @dev A retirement zeros a leaf's tree slot but leaves its index allocated, so a physical index
    /// is never reused. `leafCount` is therefore both the next free index and the upper bound for
    /// {getLeaves}.
    uint256 public leafCount;

    /// @notice The number of currently live (non-retired) keys in the set.
    uint256 public liveCount;

    /// @notice A leaf's physical slot, plus one so that 0 means "not currently live". Cleared on
    /// retirement, which is what lets a retirement find its slot and reject a double-retire without a
    /// witness.
    mapping(uint256 leaf => uint256 indexPlusOne) internal leafSlot;

    /// @dev The live keys of each member, so a removal can find them without an off-chain index. Order
    /// is not preserved: retirement removes an entry by swap-pop.
    mapping(bytes32 memberNetworkId => uint256[] leaves) internal issuerKeys;

    /// @notice When a root stopped being current. Zero for a root that never was, or for the current
    /// root — see {_claimRoot}.
    mapping(uint256 issuerSetRoot => uint256 supersededAt) public rootSupersededAt;

    /// @notice How long a superseded root stays acceptable, in seconds.
    uint256 public rootDuration;

    /// @notice The instant at or before which no superseded root is ever acceptable again.
    /// @dev Bumped by {retireIssuerKeyImmediately}, and by {retireAllIssuerKeys} on every removal of a
    /// member that ever held a key, so either closes off every root superseded in the window before it,
    /// not just the one root it directly replaces.
    uint256 public rootsInvalidatedAt;

    /// @dev Whether a member has ever published a live key. Set once, never cleared, so
    /// {retireAllIssuerKeys} can tell a member that genuinely never held signing power from one whose
    /// keys were all retired before removal — only the latter's removal needs to invalidate history.
    mapping(bytes32 memberNetworkId => bool) internal hasEverPublished;

    event IssuerKeyPublished(bytes32 indexed memberNetworkId, uint256 leaf, uint256 index, uint256 issuerSetRoot);
    event IssuerKeyRetired(bytes32 indexed memberNetworkId, uint256 leaf, uint256 issuerSetRoot);
    event RootDurationUpdated(uint256 oldRootDuration, uint256 newRootDuration);

    error UnauthorizedCaller();
    error NotApproved(bytes32 memberNetworkId);
    error CallerIsNotTheMemberRegistry();
    error ZeroMemberRegistry();
    error TooManyIssuerKeys(bytes32 memberNetworkId);
    error IssuerSetFull();
    error LeafCannotBeZero();
    error IssuerKeyAlreadyPublished(uint256 leaf);
    error IssuerKeyNotPublishedByMember(bytes32 memberNetworkId, uint256 leaf);
    error PublicKeyNotInField();
    error PublicKeyNotOnCurve();
    error PublicKeyHasLowOrder();
    error LeafIndexOutOfRange(uint256 index);

    /// @dev Restricts a write to the member's current auth address for rotation, or governance for
    /// recovery, mirroring how the registry gates a member's own record.
    /// @param memberNetworkId The member whose keys are being written.
    modifier onlyAuthAddressOrGovernance(bytes32 memberNetworkId) {
        _onlyAuthAddressOrGovernance(memberNetworkId);
        _;
    }

    function _onlyAuthAddressOrGovernance(bytes32 memberNetworkId) internal view {
        NetworkMemberRegistry registry = NetworkMemberRegistry(memberRegistry);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        if (msg.sender != authAddress && msg.sender != registry.owner()) revert UnauthorizedCaller();
        if (authAddress == address(0)) revert NotApproved(memberNetworkId);
    }

    /// @param memberRegistry_ The NetworkMemberRegistry this set resolves authorization against.
    constructor(address memberRegistry_) {
        if (memberRegistry_ == address(0)) revert ZeroMemberRegistry();

        memberRegistry = memberRegistry_;
        rootDuration = DEFAULT_ROOT_DURATION;
    }

    /// @notice Publishes a member's signing key into the set.
    /// @dev Superseded keys stay in the set, so a rotation does not invalidate credentials the old key
    /// already signed. Retire the old key explicitly to end its life.
    ///
    /// Nothing proves the caller holds the key, so one member can publish another's first.
    /// @param memberNetworkId The publishing member.
    /// @param publicKeyX The Baby Jubjub public key's x coordinate.
    /// @param publicKeyY The Baby Jubjub public key's y coordinate.
    /// @return leaf The commitment inserted into the set.
    function publishIssuerKey(bytes32 memberNetworkId, uint256 publicKeyX, uint256 publicKeyY)
        external
        onlyAuthAddressOrGovernance(memberNetworkId)
        returns (uint256 leaf)
    {
        uint256[] storage memberKeys = issuerKeys[memberNetworkId];
        if (memberKeys.length >= MAX_ISSUER_KEYS_PER_MEMBER) revert TooManyIssuerKeys(memberNetworkId);

        _assertOnCurve(publicKeyX, publicKeyY);

        leaf = IssuerSetHashes.issuerKeyLeaf(publicKeyX, publicKeyY);
        // Unreachable for a genuine Poseidon output; guards the invariant that 0 means "empty or
        // retired" everywhere else in this contract.
        if (leaf == 0) revert LeafCannotBeZero();
        if (leafSlot[leaf] != 0) revert IssuerKeyAlreadyPublished(leaf);
        if (leafCount == MAX_LEAVES) revert IssuerSetFull();

        uint256 index = leafCount;
        uint256 oldRoot = nodes[_depthFor(leafCount)][0];

        nodes[0][index] = leaf;
        leafCount = index + 1;
        ++liveCount;
        leafSlot[leaf] = index + 1;
        memberKeys.push(leaf);
        hasEverPublished[memberNetworkId] = true;

        _recomputePath(index);

        uint256 newRoot = nodes[_depthFor(leafCount)][0];
        _supersedeRoot(oldRoot);
        _claimRoot(newRoot);

        emit IssuerKeyPublished(memberNetworkId, leaf, index, newRoot);
    }

    /// @notice Publishes several of a member's signing keys in one call.
    /// @dev All keys are validated before any tree write, and they share one {_recomputePaths} pass
    /// instead of one per key. Reverts on the first invalid or duplicate key, so a batch either
    /// publishes in full or not at all.
    /// @param memberNetworkId The publishing member.
    /// @param publicKeys The Baby Jubjub public keys to publish, each `[x, y]`.
    /// @return leaves The commitments inserted into the set, in the same order as `publicKeys`.
    function publishIssuerKeys(bytes32 memberNetworkId, uint256[2][] calldata publicKeys)
        external
        onlyAuthAddressOrGovernance(memberNetworkId)
        returns (uint256[] memory leaves)
    {
        uint256 count = publicKeys.length;
        uint256[] storage memberKeys = issuerKeys[memberNetworkId];
        if (memberKeys.length + count > MAX_ISSUER_KEYS_PER_MEMBER) revert TooManyIssuerKeys(memberNetworkId);

        uint256 startIndex = leafCount;
        if (startIndex + count > MAX_LEAVES) revert IssuerSetFull();

        // Read before the loop below writes nodes[0][startIndex]: on an empty set the depth-0 root
        // slot is that first leaf, so reading after the loop would stamp the leaf as a bogus old root.
        uint256 oldRoot = nodes[_depthFor(leafCount)][0];

        leaves = new uint256[](count);
        uint256[] memory dirty = new uint256[](count);

        for (uint256 i; i < count; ++i) {
            uint256 publicKeyX = publicKeys[i][0];
            uint256 publicKeyY = publicKeys[i][1];
            _assertOnCurve(publicKeyX, publicKeyY);

            uint256 leaf = IssuerSetHashes.issuerKeyLeaf(publicKeyX, publicKeyY);
            if (leaf == 0) revert LeafCannotBeZero();
            if (leafSlot[leaf] != 0) revert IssuerKeyAlreadyPublished(leaf);

            uint256 index = startIndex + i;
            nodes[0][index] = leaf;
            leafSlot[leaf] = index + 1;
            memberKeys.push(leaf);

            leaves[i] = leaf;
            // startIndex + i is already ascending and duplicate-free, exactly what
            // {_recomputePaths} requires.
            dirty[i] = index;
        }

        leafCount = startIndex + count;
        liveCount += count;
        // Guarded: an empty batch published nothing, so it must not count as publishing history.
        if (count != 0) hasEverPublished[memberNetworkId] = true;

        _recomputePaths(dirty, count);

        uint256 newRoot = nodes[_depthFor(leafCount)][0];
        _supersedeRoot(oldRoot);
        _claimRoot(newRoot);

        for (uint256 i; i < count; ++i) {
            emit IssuerKeyPublished(memberNetworkId, leaves[i], startIndex + i, newRoot);
        }
    }

    /// @notice Retires one of a member's signing keys, ending its ability to verify.
    /// @param memberNetworkId The member the key belongs to.
    /// @param leaf The commitment to retire.
    function retireIssuerKey(bytes32 memberNetworkId, uint256 leaf)
        public
        onlyAuthAddressOrGovernance(memberNetworkId)
    {
        _detachFromMember(memberNetworkId, leaf);

        // `_detachFromMember` already proved this leaf was live and this member's, so its slot exists.
        uint256 index = leafSlot[leaf] - 1;
        uint256 oldRoot = nodes[_depthFor(leafCount)][0];

        nodes[0][index] = 0;
        delete leafSlot[leaf];
        --liveCount;

        _recomputePath(index);

        uint256 newRoot = nodes[_depthFor(leafCount)][0];
        _supersedeRoot(oldRoot);
        _claimRoot(newRoot);

        emit IssuerKeyRetired(memberNetworkId, leaf, newRoot);
    }

    /// @notice Retires a signing key immediately and stops every superseded root being accepted at once.
    /// @dev Useful in cases of key theft so prevents attack using key during grace window. In-flight
    /// proofs against old root must be rebuilt.
    /// @param memberNetworkId The network member the key belongs to.
    /// @param leaf The commitment to retire.
    function retireIssuerKeyImmediately(bytes32 memberNetworkId, uint256 leaf) external {
        rootsInvalidatedAt = block.timestamp;
        retireIssuerKey(memberNetworkId, leaf);
    }

    /// @inheritdoc IApprovedIssuerSet
    /// @dev Callable only by the registry, which invokes it while removing a member so that removal
    /// and the loss of signing power are one transaction. Two transactions would leave a window in
    /// which a removed member's key still signs credentials that verify.
    ///
    /// Superseding only the directly-replaced root is not enough: the removed member still holds the
    /// key and the path behind every root superseded in the `rootDuration` window before this call, so
    /// each of those would otherwise keep validating for up to a full window too, unattributably.
    /// {rootsInvalidatedAt} closes every one of them in a single write instead of walking history: once
    /// bumped to `block.timestamp`, {isValidIssuerSetRoot} refuses any non-current root superseded at
    /// or before this instant — the current root's own fast path returns first and is never subject to
    /// the watermark. Gated on {hasEverPublished} so a member that never held a key
    /// bumps nothing — its removal stays a true no-op, and every other member's still-live grace
    /// window survives it. The directly-replaced root's stamp is also deleted outright rather than
    /// left to outlive the watermark, on the same belt-and-suspenders basis as {_claimRoot}.
    /// The cost is that proofs other members had in flight against an invalidated root fail and have to
    /// be rebuilt, which is the side of the trade a kill switch belongs on.
    ///
    /// Leaves the tree untouched for a member with no live keys, but still bumps the watermark if that
    /// member ever published: the registry calls this on every removal, key-bearing history or not.
    function retireAllIssuerKeys(bytes32 memberNetworkId) external {
        if (msg.sender != memberRegistry) revert CallerIsNotTheMemberRegistry();

        if (hasEverPublished[memberNetworkId]) rootsInvalidatedAt = block.timestamp;

        uint256[] storage memberKeys = issuerKeys[memberNetworkId];
        uint256 count = memberKeys.length;
        if (count == 0) return;

        uint256 oldRoot = nodes[_depthFor(leafCount)][0];

        uint256[] memory leaves = new uint256[](count);
        uint256[] memory dirty = new uint256[](count);

        for (uint256 i; i < count; ++i) {
            uint256 leaf = memberKeys[i];
            uint256 index = leafSlot[leaf] - 1;

            leaves[i] = leaf;

            // The member's key list is not index-ordered (retirement swap-pops it), so insertion-sort
            // each index into `dirty` as it is found — cheap at up to MAX_ISSUER_KEYS_PER_MEMBER
            // entries, and it is what lets {_recomputePaths} receive the sorted, deduplicated input it
            // requires.
            uint256 j = i;
            while (j > 0 && dirty[j - 1] > index) {
                dirty[j] = dirty[j - 1];
                --j;
            }
            dirty[j] = index;

            nodes[0][index] = 0;
            delete leafSlot[leaf];
        }

        liveCount -= count;
        delete issuerKeys[memberNetworkId];

        _recomputePaths(dirty, count);

        uint256 newRoot = nodes[_depthFor(leafCount)][0];
        delete rootSupersededAt[oldRoot];
        _claimRoot(newRoot);

        // One event per retired key, all carrying the same final root: batching means no intermediate
        // root ever existed for a key retired mid-batch to carry instead.
        for (uint256 i; i < count; ++i) {
            emit IssuerKeyRetired(memberNetworkId, leaves[i], newRoot);
        }
    }

    /// @notice Sets how long a superseded root stays acceptable.
    /// @dev The new duration applies to every past root, not only to roots superseded after this
    /// call, so raising it makes older roots valid again and lowering it invalidates proofs that are
    /// already in flight. Roots closed by {rootsInvalidatedAt} or whose stamp was deleted stay
    /// rejected either way. It is also how long a retired key can keep backing proofs with an older
    /// root, so it should be kept as short as verifiers can tolerate.
    /// @param newRootDuration The new window, in seconds.
    function updateRootDuration(uint256 newRootDuration) external {
        if (msg.sender != NetworkMemberRegistry(memberRegistry).owner()) revert UnauthorizedCaller();

        uint256 oldRootDuration = rootDuration;

        rootDuration = newRootDuration;
        emit RootDurationUpdated(oldRootDuration, newRootDuration);
    }

    /// @notice The current root of the set. Zero while the set has never been written, or after a
    /// one-slot set's only key is retired — there is no sibling to hash the tombstone against.
    function issuerSetRoot() public view returns (uint256) {
        return nodes[_depthFor(leafCount)][0];
    }

    /// @notice Whether a verifier should accept a proof built against a root.
    /// @param root The root the proof output.
    function isValidIssuerSetRoot(uint256 root) external view returns (bool) {
        if (root == 0) return false;
        if (root == nodes[_depthFor(leafCount)][0]) return true;

        uint256 supersededAt = rootSupersededAt[root];

        if (supersededAt == 0) return false;
        // A watermark bumped on a later removal outranks any stamp from before it, so a root that
        // would otherwise still be inside its window stops validating the instant that removal lands.
        if (supersededAt <= rootsInvalidatedAt) return false;

        // Strict, so a `rootDuration` of zero means no grace at all rather than a one-timestamp
        // window. The window runs from the moment the root stopped being current, so every root gets
        // the same full window however long it was current. `supersededAt` is never in the future,
        // so the subtraction cannot underflow, and unlike `supersededAt + rootDuration` it cannot
        // overflow for any `rootDuration`.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp - supersededAt < rootDuration;
    }

    /// @notice The live signing keys of a member.
    /// @dev Public because publication is already a public transaction and a holder has to enumerate
    /// leaves to rebuild the tree anyway. What the design hides is which key signed a given
    /// credential, which no read here reveals.
    /// @param memberNetworkId The member to look up.
    function issuerKeysOf(bytes32 memberNetworkId) external view returns (uint256[] memory) {
        return issuerKeys[memberNetworkId];
    }

    /// @notice Whether a commitment is currently in the set.
    /// @param leaf The commitment to check.
    function isApprovedIssuerKey(uint256 leaf) external view returns (bool) {
        return leafSlot[leaf] != 0;
    }

    /// @notice The leaf value at a physical index. Zero for a retired leaf or an index never written.
    /// @param index The physical slot, in `[0, getLeafCount())`.
    function getLeaf(uint256 index) external view returns (uint256) {
        return nodes[0][index];
    }

    /// @notice The leaf values in `[start, end)`.
    /// @dev The private rebuild path for a holder: reading `[0, getLeafCount())` this way and
    /// replaying the same level loop this contract uses reconstructs the whole tree off chain, so a
    /// holder never has to call {siblingsOf} and reveal to its RPC provider which leaf it holds a
    /// witness for.
    /// @param start The inclusive start index.
    /// @param end The exclusive end index.
    function getLeaves(uint256 start, uint256 end) external view returns (uint256[] memory leaves) {
        leaves = new uint256[](end - start);

        for (uint256 i = start; i < end; ++i) {
            leaves[i - start] = nodes[0][i];
        }
    }

    /// @notice A node at an arbitrary level and index.
    /// @param level The level, 0 for leaves up to `depth()` for the current root; {MAX_DEPTH} bounds
    /// it.
    /// @param index The index within that level.
    function getNode(uint256 level, uint256 index) external view returns (uint256) {
        return nodes[level][index];
    }

    /// @notice The path from `index` to the root: siblings at levels where one exists, and the packed
    /// direction bits for exactly those levels, in the order the circuit's `binary_merkle_root`
    /// consumes them.
    /// @dev A convenience fast path, not the path a holder's normal traffic should use: calling this
    /// per presentation tells the RPC provider, request after request, which physical leaf that holder
    /// holds a witness for. {getLeaves} avoids that by letting a holder rebuild the tree, and every
    /// sibling with it, without ever asking the chain "what is index's path".
    ///
    /// A promoted level has no sibling and is skipped, so `siblings.length` can be less than `depth()`
    /// and `pathIndex` is not `index` itself — it packs only the included levels' direction bits, bit
    /// `i` set when `index` is the right child at the `i`th included level.
    /// @param index The physical leaf index to build a path for.
    function siblingsOf(uint256 index) external view returns (uint256[] memory siblings, uint256 pathIndex) {
        if (index >= leafCount) revert LeafIndexOutOfRange(index);

        uint256 width = leafCount;
        uint256 pathDepth = _depthFor(width);
        uint256[MAX_DEPTH] memory buffer;
        uint256 count;

        for (uint256 level; level < pathDepth; ++level) {
            if ((index ^ 1) < width) {
                buffer[count] = nodes[level][index ^ 1];
                if (index & 1 == 1) pathIndex |= 2 ** count;
                ++count;
            }

            index >>= 1;
            width = (width + 1) >> 1;
        }

        siblings = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            siblings[i] = buffer[i];
        }
    }

    /// @notice The number of physical leaf slots, including retired ones.
    function getLeafCount() external view returns (uint256) {
        return leafCount;
    }

    /// @notice The current depth of the tree: `ceil(log2(leafCount))`, 0 for 0 or 1 slots.
    function depth() external view returns (uint256) {
        return _depthFor(leafCount);
    }

    /// @notice The number of live keys in the set.
    function getSize() external view returns (uint256) {
        return liveCount;
    }

    /// @dev Removes one leaf from a member's key list by swap-pop. Reverts if the leaf is not that
    /// member's. Leaves the tree and {leafSlot} untouched — the caller does that once it knows the
    /// leaf really is the member's.
    /// @param memberNetworkId The member the key should belong to.
    /// @param leaf The commitment to detach.
    function _detachFromMember(bytes32 memberNetworkId, uint256 leaf) private {
        uint256[] storage memberKeys = issuerKeys[memberNetworkId];
        uint256 keyCount = memberKeys.length;
        uint256 position = keyCount;

        for (uint256 i; i < keyCount; ++i) {
            if (memberKeys[i] != leaf) continue;

            position = i;
            break;
        }

        if (position == keyCount) revert IssuerKeyNotPublishedByMember(memberNetworkId, leaf);

        memberKeys[position] = memberKeys[keyCount - 1];
        memberKeys.pop();
    }

    /// @dev Starts the expiry clock of the root a write just replaced. The empty-tree root is skipped
    /// because no proof can be built against it.
    /// @param oldRoot The root the write replaced.
    function _supersedeRoot(uint256 oldRoot) private {
        if (oldRoot == 0) return;

        rootSupersededAt[oldRoot] = block.timestamp;
    }

    /// @dev Clears any supersession stamp on a root the instant it becomes current. With LeanIMT
    /// promotion, a root can no longer recur the way a zero-padded root once could — every slot is
    /// written at most once and never reused — so this is now a safety net against a hash collision
    /// rather than a fix for a known revival case. Call this on every write that moves the root.
    /// @param newRoot The root that just became current.
    function _claimRoot(uint256 newRoot) private {
        delete rootSupersededAt[newRoot];
    }

    /// @dev Recomputes every node from `dirty`'s leaf indices up to the root, given that each entry's
    /// new leaf value is already written into `nodes[0]` and `leafCount` already reflects the write.
    ///
    /// `dirty[0..length)` must arrive sorted ascending and free of duplicates. Two dirty entries that
    /// share a parent collapse to one recompute of it: sorted order turns that collapse into a single
    /// compare against the previous parent instead of a set lookup. The same array carries each
    /// level's deduplicated parent indices up to the next level, so no level allocates memory of its
    /// own. `width` halves with each level, same as {_recomputeNode} needs to decide whether a
    /// parent's right child exists.
    /// @param dirty The leaf indices to recompute from. Overwritten level by level with that level's
    /// deduplicated parent indices.
    /// @param length The number of valid entries in `dirty`.
    function _recomputePaths(uint256[] memory dirty, uint256 length) private {
        uint256 width = leafCount;
        uint256 pathDepth = _depthFor(width);

        for (uint256 level; level < pathDepth; ++level) {
            uint256 nextLength;
            uint256 previousParent = type(uint256).max;

            for (uint256 i; i < length; ++i) {
                uint256 parent = dirty[i] >> 1;
                if (parent == previousParent) continue;

                _recomputeNode(level, parent, width);

                dirty[nextLength] = parent;
                ++nextLength;
                previousParent = parent;
            }

            length = nextLength;
            width = (width + 1) >> 1;
        }
    }

    /// @dev {_recomputePaths} for the single-leaf case.
    /// @param leafIndex The touched leaf index.
    function _recomputePath(uint256 leafIndex) private {
        uint256[] memory dirty = new uint256[](1);
        dirty[0] = leafIndex;
        _recomputePaths(dirty, 1);
    }

    /// @dev Recomputes one parent from its children, promoting the left child unchanged when the
    /// level's width leaves it unpaired — the LeanIMT rule in place of a zero-padded hash. Reads the
    /// left child once since both branches need it, and split out of {_recomputePaths} to keep that
    /// loop's stack frame small.
    /// @param level The children's level.
    /// @param parent The parent index to write, at `level + 1`.
    /// @param width The live width of `level`, deciding whether `parent`'s right child exists.
    function _recomputeNode(uint256 level, uint256 parent, uint256 width) private {
        uint256 leftIndex = parent << 1;
        uint256 rightIndex = leftIndex | 1;
        uint256 left = nodes[level][leftIndex];

        nodes[level + 1][parent] =
            rightIndex < width ? IssuerSetHashes.internalNode(left, nodes[level][rightIndex]) : left;
    }

    /// @dev The smallest `d` with `2^d >= n`; 0 for `n` of 0 or 1.
    /// @param n The width to size a depth for.
    function _depthFor(uint256 n) private pure returns (uint256 d) {
        uint256 capacity = 1;
        while (capacity < n) {
            capacity <<= 1;
            ++d;
        }
    }

    /// @dev Rejects a public key that is outside the field, off the curve, or of low order.
    ///
    /// The tree would accept any field element as a leaf, so without the curve check the set could
    /// hold a commitment to a point that does not exist.
    ///
    /// The order check is what stops a member handing everyone else its issuing power. Under a
    /// low-order public key `A`, the term `h·A` in EdDSA verification takes at most eight values
    /// whatever the message, so anyone can solve `S·B = R + h·A` for a signature that verifies over a
    /// claim tree they chose. At the identity it is immediate: `h·A` vanishes, so any `S` with
    /// `R = S·B` passes. A member publishing such a key would let any stranger mint credentials that
    /// verify as issued by an approved member, and issuer anonymity means no verifier could say whose
    /// key to retire.
    ///
    /// It does not reject a mixed-order key, a prime-order point plus a nonzero torsion point. The
    /// circuit's EdDSA (noir-lang/eddsa 7e206c95) multiplies the key by 8 before verifying, so only the
    /// holder of its prime-order part's secret can sign under such a key. The only effect is that one
    /// secret can take several leaves, at most eight live ones, one per torsion point, possibly under
    /// different members. The TypeScript `issuer-set` refuses to publish them.
    ///
    /// @param publicKeyX The x coordinate.
    /// @param publicKeyY The y coordinate.
    function _assertOnCurve(uint256 publicKeyX, uint256 publicKeyY) private pure {
        if (publicKeyX >= SNARK_SCALAR_FIELD || publicKeyY >= SNARK_SCALAR_FIELD) revert PublicKeyNotInField();

        if (
            publicKeyX == LOW_ORDER_X_0 || publicKeyX == LOW_ORDER_X_1 || publicKeyX == LOW_ORDER_X_2
                || publicKeyX == LOW_ORDER_X_3 || publicKeyX == LOW_ORDER_X_4
        ) revert PublicKeyHasLowOrder();

        uint256 xSquared = mulmod(publicKeyX, publicKeyX, SNARK_SCALAR_FIELD);
        uint256 ySquared = mulmod(publicKeyY, publicKeyY, SNARK_SCALAR_FIELD);

        uint256 left = addmod(mulmod(CURVE_A, xSquared, SNARK_SCALAR_FIELD), ySquared, SNARK_SCALAR_FIELD);
        uint256 right = addmod(
            1, mulmod(CURVE_D, mulmod(xSquared, ySquared, SNARK_SCALAR_FIELD), SNARK_SCALAR_FIELD), SNARK_SCALAR_FIELD
        );

        if (left != right) revert PublicKeyNotOnCurve();
    }
}
