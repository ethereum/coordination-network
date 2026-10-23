import { bindingKeystoreCase } from "./cases/binding-keystore"
import { bindingSoftwareCase } from "./cases/binding-software"
import { derivationCase } from "./cases/derivation"
import { eddsaJsCase } from "./cases/eddsa-js"
import { eddsaKeystoreCase } from "./cases/eddsa-keystore"
import { eraseAllCase } from "./cases/erase-all"
import { keyAttestationCase } from "./cases/key-attestation"
import { persistenceCase } from "./cases/persistence"
import { rngCase } from "./cases/rng"
import { signDigestCase } from "./cases/sign-digest"
import { signDigestSoftwareCase } from "./cases/sign-digest-software"
import { vectorsKatCase } from "./cases/vectors-kat"
import type { TestCase } from "./types"

/** The full, ordered test-case registry — single source of truth for both the app UI and the jest `js`-tier spec. */
export const allCases: TestCase[] = [
    rngCase,
    derivationCase,
    vectorsKatCase,
    eddsaJsCase,
    bindingSoftwareCase,
    signDigestSoftwareCase,
    persistenceCase,
    bindingKeystoreCase,
    keyAttestationCase,
    eddsaKeystoreCase,
    signDigestCase,
    eraseAllCase
]

export type { TestCase, TestDetail, Tier } from "./types"
