mod credential;
mod eddsa;
mod issuer;
mod types;

use eddsa::eddsa_verify;
use issuer::MAX_DEPTH as ISSUER_SET_MAX_DEPTH;
use lean_imt_plus::lean_imt_plus_root;
use poseidon::poseidon::bn254::{hash_2, hash_3, hash_4};
use poseidon::poseidon::PoseidonHasher;
use types::Credential;

global REVOCATION_MAX_DEPTH: u32 = 20;
// keccak256(utf8("urn:cn:presentation:v1")) >> 8
global PRESENTATION_DOMAIN: Field =
    47717037732995119958831198142288202228464361330145547649000821135537239485;

fn main(
    current_time: pub u64,
    challenge: pub Field,
    audience: pub Field,
    required_programme_hash: pub Field,
    required_country_code: pub Field,
    credential: Credential,
    issuer_pub_x: Field,
    issuer_pub_y: Field,
    issuer_sig_r8_x: Field,
    issuer_sig_r8_y: Field,
    issuer_sig_s: Field,
    issuer_depth: u32,
    issuer_indices: [bool; ISSUER_SET_MAX_DEPTH],
    issuer_siblings: [Field; ISSUER_SET_MAX_DEPTH],
    device_pub_x: [u8; 32],
    device_pub_y: [u8; 32],
    device_signature: [u8; 64],
    identity_pub_x: Field,
    identity_pub_y: Field,
    identity_sig_r8_x: Field,
    identity_sig_r8_y: Field,
    identity_sig_s: Field,
    revocation_pub_x: Field,
    revocation_pub_y: Field,
    revocation_sig_r8_x: Field,
    revocation_sig_r8_y: Field,
    revocation_sig_s: Field,
    revocation_low_leaf_value: Field,
    revocation_low_leaf_next: Field,
    revocation_depth: u32,
    revocation_indices: [bool; REVOCATION_MAX_DEPTH],
    revocation_siblings: [Field; REVOCATION_MAX_DEPTH],
) -> pub (Field, Field) {
    let credential_message = credential::commitment(credential);

    assert(
        eddsa_verify::<PoseidonHasher>(
            issuer_pub_x,
            issuer_pub_y,
            issuer_sig_s,
            issuer_sig_r8_x,
            issuer_sig_r8_y,
            credential_message,
        ),
        "invalid issuer signature",
    );
    let approved_issuer_root =
        issuer::root(issuer_pub_x, issuer_pub_y, issuer_depth, issuer_indices, issuer_siblings);

    assert(credential.not_before <= current_time, "credential is not yet valid");
    assert(current_time <= credential.expires_at, "credential has expired");
    assert_eq(credential.programme_hash, required_programme_hash, "programme does not match");
    assert_eq(credential.country_code, required_country_code, "country does not match");

    let session_message = hash_4(
        [PRESENTATION_DOMAIN, challenge, audience, credential_message],
    );
    let session_message_bytes: [u8; 32] = session_message.to_be_bytes();
    assert_eq(
        credential::device_key_commitment(device_pub_x, device_pub_y),
        credential.device_key_commitment,
        "device key does not open the credential commitment",
    );
    assert(
        std::ecdsa_secp256r1::verify_signature(
            device_pub_x,
            device_pub_y,
            device_signature,
            session_message_bytes,
        ),
        "invalid device signature",
    );

    assert_eq(
        hash_2([identity_pub_x, identity_pub_y]),
        credential.holder_key_commitment,
        "identity key does not open the credential commitment",
    );
    assert(
        eddsa_verify::<PoseidonHasher>(
            identity_pub_x,
            identity_pub_y,
            identity_sig_s,
            identity_sig_r8_x,
            identity_sig_r8_y,
            session_message,
        ),
        "invalid identity signature",
    );

    assert_eq(
        hash_2([revocation_pub_x, revocation_pub_y]),
        credential.revocation_commitment,
        "revocation key does not open the credential commitment",
    );
    assert(
        eddsa_verify::<PoseidonHasher>(
            revocation_pub_x,
            revocation_pub_y,
            revocation_sig_s,
            revocation_sig_r8_x,
            revocation_sig_r8_y,
            session_message,
        ),
        "invalid revocation-key signature",
    );

    let revocation_root = lean_imt_plus_root(
        hash_3,
        hash_2,
        true,
        credential.revocation_commitment,
        revocation_low_leaf_value,
        revocation_low_leaf_next,
        revocation_depth,
        revocation_indices,
        revocation_siblings,
    );
    let empty_registry = revocation_depth == 0;
    assert(!empty_registry | (revocation_low_leaf_value == 0), "invalid empty revocation witness");
    assert(!empty_registry | (revocation_low_leaf_next == 0), "invalid empty revocation witness");
    for i in 0..REVOCATION_MAX_DEPTH {
        assert(!empty_registry | !revocation_indices[i], "invalid empty revocation witness");
        assert(!empty_registry | (revocation_siblings[i] == 0), "invalid empty revocation witness");
    }

    let canonical_revocation_root = if empty_registry { 0 } else { revocation_root };

    (approved_issuer_root, canonical_revocation_root)
}

#[test]
fn accepts_zk_kit_vector() {
    let pub_x = 17145850796026918084964381264224969058280635207741849259441085610619323268793;
    let pub_y = 12739136082614649000971099828843750903333050161922102230327542411762042864532;
    let r8_x = 15524625270731079305966391574257085402945890677596245735016312557711871251745;
    let r8_y = 21851585646035144628054782655502377976073920894610191532514047740161645049816;
    let s = 546000471566828313746526008704952611728577210855060032957183501675256683918;

    assert(eddsa_verify::<PoseidonHasher>(pub_x, pub_y, s, r8_x, r8_y, 42));
    assert(!eddsa_verify::<PoseidonHasher>(pub_x, pub_y, s, r8_x, r8_y, 43));
}
