# User Web App

The browser device layer for flows 1, 2, 4 and 5. It owns the user's identity, credentials,
revocation secrets and proof generation. Member apps interact with it only through the three
operations in `@coordination-network/user-app-link`.

Start the local stack with `STACK_MIN_DEVICE_SECURITY_LEVEL=SOFTWARE yarn demo`, then run
`yarn workspace integration-testbed relay` and `yarn workspace user-web-app dev` in separate
terminals. The wallet uses port 4173 and the public stack descriptor. Enter the relay session key
from the private file printed by the relay; it is kept only in this tab's sessionStorage.
See the [relay setup](../integration-testbed/README.md#browser-link-relay-e1--l7) for pairing links
and explicit LAN settings.

## Browser security model

This demo deliberately uses one software P-256 key for both possession signatures and the ECDH
derivation that roots the Baby Jubjub identity key. Browsers cannot create one non-extractable
WebCrypto P-256 key with both ECDSA and ECDH usages. Consequently the UI reports
`securityLevel: SOFTWARE`; this is not the hardware trust root used by the mobile application.

Identity and credential values are encrypted with AES-256-GCM before being saved in IndexedDB.
The browser generates a non-extractable WebCrypto key and persists it in a separate object store.
Each write uses a fresh IV and binds the ciphertext to its storage key, including the member prefix.
This requires HTTPS or localhost; there is no plaintext fallback.

On first use, all existing plaintext records are encrypted, including records the wallet does not
read. Migration only replaces unchanged records, so it cannot overwrite a newer write or restore a
deleted record. Unreadable records and missing keys cause an error and leave the saved data intact.
Clear wallet removes the records and encryption key in one transaction. Older builds cannot open
the upgraded database.

Do not use real credentials or production keys in this demo. Storage key names remain readable,
and the encryption key stays in the same browser profile. This does not protect against scripts
running on the wallet's origin or someone with access to the unlocked profile. The browser still
reports software security and provides no hardware-backed key custody.

Presentation proving runs single-threaded inside a Web Worker, keeping the page responsive and
preserving the popup `window.opener` channel. The Settings screen can erase all locally held state.

## Chain roots

This demo has no RPC client, so the roots it checks served lists against still come from the member
server. That check cannot catch a server serving a mismatched list. The mobile user app reads both
roots from chain instead.

## Error messages

Responses to the member app carry the protocol's error code and one fixed sentence per code
(`LINK_ERROR_MESSAGES`). The wallet keeps the details on the device, since detailed messages can
reveal the holder's status to the verifier ([wallet spec](../../specs/02-wallet.md)).

## Current link protocol

The wallet serves `registration.sign`, `credential.issue` and `presentation.create`, each after
consent. It performs challenge, issuance, validation and storage locally within `credential.issue`;
credentials and revocation secrets do not travel through the relay. Presentations post directly to
the verifier, and the relay returns only the verification id. The verifier reads its own recorded
verdict. The wallet's "Proof sent" message does not claim acceptance.
