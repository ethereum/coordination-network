// Baby Jubjub EdDSA verification, adapted from noir-lang/eddsa at
// 7e206c95f850346a84faf78e3430cd2bc3f6aabf (Apache-2.0), with the challenge
// scalar bound to the hash it represents.
//
// noir-edwards v0.2.5's `ScalarField::<64>::from` takes its WNAF slices from an
// unconstrained hint and, unlike the `N < 64` branch, never checks that they
// reconstruct the input: it only range-checks them below the field modulus. A
// prover could therefore replace the challenge `h` with any scalar (e.g. one),
// and `S = 0, R8 = -8A` would then verify for any key and message. Upstream
// eddsa passes the challenge through that conversion unchanged, so this copy
// adds the missing equality. Drop it once noir-edwards constrains the
// reconstruction itself.

use std::default::Default;
use std::hash::Hasher;

use edwards::{bjj::BabyJubJub, Curve, CurveTrait, ScalarField};

// Baby Jubjub subgroup order
global SUBORDER: Field =
    2736030358979909402780800718157159386076813972158567259200215660948447373041;

// Generator * 8
global BASE8_X: Field =
    5299619240641551281634865583518297030282874472190772894086521144482721001553;
global BASE8_Y: Field =
    16950150798460657717958625567821834550301663161624707787222815936182638968203;

pub fn eddsa_verify<H>(
    pub_key_x: Field,
    pub_key_y: Field,
    signature_s: Field,
    signature_r8_x: Field,
    signature_r8_y: Field,
    message: Field,
) -> bool
where
    H: Hasher + Default,
{
    // Verifies by testing:
    // S * B8 = R8 + H(R8, A, m) * A8

    // BabyJubJub::new asserts the point is on the curve
    let pub_key = BabyJubJub::new(pub_key_x, pub_key_y);
    let signature_r8 = BabyJubJub::new(signature_r8_x, signature_r8_y);
    // Ensure S < Subgroup Order
    assert(signature_s.lt(SUBORDER));
    // Calculate the h = H(R, A, msg)
    let mut hasher = H::default();
    hasher.write(signature_r8_x);
    hasher.write(signature_r8_y);
    hasher.write(pub_key_x);
    hasher.write(pub_key_y);
    hasher.write(message);
    let hash: Field = hasher.finish();
    // Calculate second part of the right side:  right2 = h*8*A
    // Multiply by 8 by doubling 3 times. This also ensures that the result is in the subgroup.
    let pub_key_mul_2 = pub_key.dbl();
    let pub_key_mul_4 = pub_key_mul_2.dbl();
    let pub_key_mul_8 = pub_key_mul_4.dbl();
    // We check that A8 is not zero.
    assert(!pub_key_mul_8.is_zero());

    verify_with_challenge(
        pub_key_mul_8,
        signature_r8,
        signature_s,
        hash,
        ScalarField::<64>::from(hash),
    )
}

// Split from `eddsa_verify` so tests can supply the challenge decomposition a
// hostile prover's hint would, which `ScalarField`'s private fields otherwise prevent.
fn verify_with_challenge(
    pub_key_mul_8: BabyJubJub,
    signature_r8: BabyJubJub,
    signature_s: Field,
    hash: Field,
    hash_scalar: ScalarField<64>,
) -> bool {
    // `from` range-checks the slices below the field modulus; binding their
    // (constrained) reconstruction to `hash` makes the decomposition unique.
    assert(
        Into::<Field>::into(hash_scalar) == hash,
        "eddsa challenge decomposition does not match its hash",
    );
    // Compute the right side: R8 + h * A8
    let right = signature_r8 + pub_key_mul_8.mul(hash_scalar);
    // Calculate left side of equation left = S * B8
    let base8: BabyJubJub = Curve { x: BASE8_X, y: BASE8_Y };
    let left = base8.mul(ScalarField::<63>::from(signature_s));

    left == right
}

mod tests {
    use edwards::{bjj::BabyJubJub, Curve, CurveTrait, ScalarField};
    use poseidon::poseidon::PoseidonHasher;
    use poseidon::poseidon2::Poseidon2Hasher;

    use std::hash::Hasher;

    use super::{BASE8_X, BASE8_Y, eddsa_verify, verify_with_challenge};

    // Upstream noir-lang/eddsa's own test vectors.
    #[test]
    fn upstream_vectors() {
        let msg = 789;
        let pub_key_a = BabyJubJub::one().mul(ScalarField::<63>::from(123));
        let pub_key_b = BabyJubJub::one().mul(ScalarField::<63>::from(456));
        let base8: BabyJubJub = Curve { x: BASE8_X, y: BASE8_Y };
        let r8_a = base8.mul(ScalarField::<63>::from(
            1414770703199880747815475415092878800081323795074043628810774576767372531818,
        ));
        let r8_b = base8.mul(ScalarField::<63>::from(
            571799555715456644614141527517766533395606396271089506978608487688924659618,
        ));
        let s_a = 30333430637424319196043722294837632681219980330991241982145549329256671548;
        let s_b = 1646085314320208098241070054368798527940102577261034947654839408482102287019;

        assert(eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg));
        assert(eddsa_verify::<PoseidonHasher>(pub_key_b.x, pub_key_b.y, s_b, r8_b.x, r8_b.y, msg));
        assert(!eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_b, r8_b.x, r8_b.y, msg));
        assert(
            !eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg + 1),
        );
        assert(
            !eddsa_verify::<Poseidon2Hasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg),
        );
    }

    // The forgery from the unconstrained-challenge finding: S = 0 and R8 = -8A
    // need no secret key, and satisfy the curve equation once the challenge is one.
    fn forgery() -> (BabyJubJub, BabyJubJub, Field) {
        let pub_key = BabyJubJub::one().mul(ScalarField::<63>::from(123));
        let pub_key_mul_8 = pub_key.dbl().dbl().dbl();
        let signature_r8 = -pub_key_mul_8;
        let mut hasher = PoseidonHasher::default();
        hasher.write(signature_r8.x);
        hasher.write(signature_r8.y);
        hasher.write(pub_key.x);
        hasher.write(pub_key.y);
        hasher.write(42);
        (pub_key_mul_8, signature_r8, hasher.finish())
    }

    // Without the binding the forgery verifies, so the test below would fail if
    // it ever accepted another decomposition.
    #[test]
    fn forgery_satisfies_the_equation_under_a_challenge_of_one() {
        let (pub_key_mul_8, signature_r8, _) = forgery();
        let base8: BabyJubJub = Curve { x: BASE8_X, y: BASE8_Y };

        let left = base8.mul(ScalarField::<63>::from(0));
        let right = signature_r8 + pub_key_mul_8.mul(ScalarField::<64>::from(1));
        assert(left == right);
    }

    // The decomposition of one is what a hostile hint returns in place of the real
    // challenge's; the binding has to reject it before the curve equation runs.
    #[test(should_fail_with = "eddsa challenge decomposition does not match its hash")]
    fn rejects_the_decomposition_of_another_challenge() {
        let (pub_key_mul_8, signature_r8, hash) = forgery();
        assert(hash != 1);

        let _ = verify_with_challenge(
            pub_key_mul_8,
            signature_r8,
            0,
            hash,
            ScalarField::<64>::from(1),
        );
    }
}
