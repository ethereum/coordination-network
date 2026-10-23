use crate::types::Credential;
use poseidon::poseidon::bn254::{hash_3, hash_4, hash_5};

// keccak256(utf8("urn:cn:credential:v1")) >> 8
global CREDENTIAL_DOMAIN: Field =
    363566488821926773809509531830640889725124777157045803797738936823559174026;
// Domain separator for Poseidon5(device public-key limbs).
global DEVICE_KEY_DOMAIN: Field =
    320507632879070882430325612169297945123468706597652794395401074724051126576;

pub(crate) fn commitment(credential: Credential) -> Field {
    let policy = hash_4([
        credential.programme_hash,
        credential.country_code,
        credential.not_before as Field,
        credential.expires_at as Field,
    ]);
    let keys = hash_3([
        credential.device_key_commitment,
        credential.holder_key_commitment,
        credential.revocation_commitment,
    ]);

    hash_3([CREDENTIAL_DOMAIN, policy, keys])
}

pub(crate) fn device_key_commitment(public_key_x: [u8; 32], public_key_y: [u8; 32]) -> Field {
    let x = coordinate_limbs(public_key_x);
    let y = coordinate_limbs(public_key_y);

    hash_5([DEVICE_KEY_DOMAIN, x[0], x[1], y[0], y[1]])
}

fn coordinate_limbs(coordinate: [u8; 32]) -> [Field; 2] {
    let mut high: [u8; 16] = [0; 16];
    let mut low: [u8; 16] = [0; 16];

    for i in 0..16 {
        high[i] = coordinate[i];
        low[i] = coordinate[i + 16];
    }

    [Field::from_be_bytes(high), Field::from_be_bytes(low)]
}
