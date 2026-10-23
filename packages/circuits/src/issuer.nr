use binary_merkle_root::binary_merkle_root;
use poseidon::poseidon::bn254::{hash_2, hash_3};

pub(crate) global MAX_DEPTH: u32 = 20;

// Domain separator for Poseidon3(issuer public key).
global LEAF_DOMAIN: Field =
    185404551131306766954100762329350135288498146007932686448214248919067924295;

pub(crate) fn root(
    public_key_x: Field,
    public_key_y: Field,
    depth: u32,
    indices: [bool; MAX_DEPTH],
    siblings: [Field; MAX_DEPTH],
) -> Field {
    assert(depth <= MAX_DEPTH, "issuer path depth exceeds the circuit maximum");
    let leaf = hash_3([LEAF_DOMAIN, public_key_x, public_key_y]);
    binary_merkle_root(hash_2, leaf, depth, indices, siblings)
}

// Pinned cross-language: the same leaves, roots and witnesses `packages/issuer-set/tests/cross-language.test.ts`
// and `packages/contracts/test/integration/IssuerSetCrossLanguageRoot.t.sol` pin, computed three
// independent ways before being copied here.
mod tests {
    use super::{root, MAX_DEPTH};
    use poseidon::poseidon::bn254::hash_2;

    // `k * Base8` on Baby Jubjub, for k = 1, 2, 5.
    global KEY_1_X: Field =
        5299619240641551281634865583518297030282874472190772894086521144482721001553;
    global KEY_1_Y: Field =
        16950150798460657717958625567821834550301663161624707787222815936182638968203;
    global KEY_2_X: Field =
        10031262171927540148667355526369034398030886437092045105752248699557385197826;
    global KEY_2_Y: Field =
        633281375905621697187330766174974863687049529291089048651929454608812697683;
    global KEY_5_X: Field =
        11480966271046430430613841218147196773252373073876138147006741179837832100836;
    global KEY_5_Y: Field =
        15148236048131954717802795400425086368006776860859772698778589175317365693546;

    global LEAF_OF_KEY_1: Field =
        2493720610778676091149258492386261697559719708118160248500693563612404203088;
    global LEAF_OF_KEY_2: Field =
        15278273562238927018842798161288898682472598529198791544673021966310311323458;
    global LEAF_OF_KEY_3: Field =
        20980331097734099105425623618460522669974741732319895218846623662978431137317;

    global ROOT_OF_KEYS_1_TO_2: Field =
        15680708859485847685012924683010191875504585065894243099617821723863156328943;
    global ROOT_OF_KEYS_1_2_3: Field =
        11334223563046274794300795549267186709638286758254539923752495560734019145426;
    global ROOT_OF_KEYS_1_TO_4: Field =
        1012468898015973113393162930052218519362020364191895474978289263522471748684;
    global ROOT_OF_KEYS_1_TO_5: Field =
        1509212439766155221370997401451147889947558708210956682611194460683115030117;

    #[test]
    fn one_key_root_is_the_leaf() {
        let indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];

        assert(root(KEY_1_X, KEY_1_Y, 0, indices, siblings) == LEAF_OF_KEY_1);
    }

    #[test]
    fn two_keys_hash_once() {
        let indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        siblings[0] = LEAF_OF_KEY_2;

        assert(root(KEY_1_X, KEY_1_Y, 1, indices, siblings) == ROOT_OF_KEYS_1_TO_2);
    }

    #[test]
    fn key_2_opens_root_of_keys_1_2_3() {
        let mut indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        indices[0] = true;
        siblings[0] = LEAF_OF_KEY_1;
        siblings[1] = LEAF_OF_KEY_3;

        assert(root(KEY_2_X, KEY_2_Y, 2, indices, siblings) == ROOT_OF_KEYS_1_2_3);
    }

    // Slot 4 of a five-slot set: levels 0 and 1 are promoted (no sibling), so the witness holds
    // only the one sibling at the level that does have one.
    #[test]
    fn promoted_levels_are_absent_from_the_witness() {
        let mut indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        indices[0] = true;
        siblings[0] = ROOT_OF_KEYS_1_TO_4;

        assert(root(KEY_5_X, KEY_5_Y, 1, indices, siblings) == ROOT_OF_KEYS_1_TO_5);
    }

    #[test]
    fn padding_tail_is_ignored() {
        let mut indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        siblings[0] = LEAF_OF_KEY_2;
        // Garbage past `depth`: binary_merkle_root only folds the first `depth` levels.
        indices[7] = true;
        siblings[3] = 999;

        assert(root(KEY_1_X, KEY_1_Y, 1, indices, siblings) == ROOT_OF_KEYS_1_TO_2);
    }

    #[test]
    fn depth_off_by_one_changes_root() {
        let mut indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        indices[0] = true;
        siblings[0] = LEAF_OF_KEY_1;
        siblings[1] = LEAF_OF_KEY_3;

        // The true witness needs depth 2; stopping one level short must not silently agree.
        assert(root(KEY_2_X, KEY_2_Y, 1, indices, siblings) != ROOT_OF_KEYS_1_2_3);
    }

    #[test(should_fail_with = "issuer path depth exceeds the circuit maximum")]
    fn rejects_depth_above_max() {
        let indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];

        let _ = root(KEY_1_X, KEY_1_Y, MAX_DEPTH + 1, indices, siblings);
    }

    #[test]
    fn accepts_depth_at_max() {
        let indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];

        let mut expected = LEAF_OF_KEY_1;
        for _ in 0..MAX_DEPTH {
            expected = hash_2([expected, 0]);
        }

        assert(root(KEY_1_X, KEY_1_Y, MAX_DEPTH, indices, siblings) == expected);
    }

    // key_2_opens_root_of_keys_1_2_3's own witness is only valid at depth 2; running it one level
    // too deep must not silently still agree with ROOT_OF_KEYS_1_2_3.
    #[test]
    fn depth_above_the_true_one_changes_root() {
        let mut indices: [bool; MAX_DEPTH] = [false; MAX_DEPTH];
        let mut siblings: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
        indices[0] = true;
        siblings[0] = LEAF_OF_KEY_1;
        siblings[1] = LEAF_OF_KEY_3;

        assert(root(KEY_2_X, KEY_2_Y, 3, indices, siblings) != ROOT_OF_KEYS_1_2_3);
    }
}
