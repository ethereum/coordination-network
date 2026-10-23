# @coordination-network/credential

The zero-knowledge credential SDK for the Coordination Network. It issues signed credentials and builds or verifies presentations that prove approval and non-revocation without revealing the credential, its holder, or its issuer.

## Install

```bash
yarn add @coordination-network/credential
```

## Supported credential flow

- `issueZkCredential` validates the holder bindings and signs the credential commitments.
- `issuanceRequestCommitment` hashes the issuer and the approval scope into the value the wallet's device signature covers; `issueZkCredential` recomputes it from its own id and the scope it signs.
- `buildZkPresentationInputs` constructs private circuit inputs on the holder device.
- `ZkCredentialProofSystem` creates and verifies the zero-knowledge presentation.
- `ApprovedIssuerSet` and the revocation helpers provide the membership witnesses used by the circuit.

The previous SD-JWT prototype is intentionally not part of this package. It exposed stable subject, issuer, device-key, and revocation identifiers and did not provide the privacy properties of the supported ZK flow.

## Verifying a presentation

```ts
import { verifyZkPresentationProof } from "@coordination-network/credential"

const result = await verifyZkPresentationProof(circuit, proof, expected)
```

On success the result carries `approvedIssuerRoot` and `revocationRoot`, the proof's public outputs. The function does not check them, so check them against the registries before accepting the presentation: the issuer root against the approved-issuer set, and the revocation root with the revocation registry's `isValidRoot`.

## Revocation

The holder generates a secret with `generateRevocationSecret` and sends only its commitment to the issuer. `signCommitmentOwnership` and `verifyCommitmentOwnership` prove control of the commitment during issuance. A presentation later proves that commitment is absent from the revocation registry without disclosing it.

## Notes

- Device signer interfaces are structural, so keys can remain in a hardware-backed keystore.
- Noir and Barretenberg are loaded lazily by the proof-system helpers.
- This package ships a CommonJS build; both `import` and `require` are supported.
