# Network Member Web App

The browser member/operator layer for enrolment, issuance, verification and revocation. The same
build runs for each member; its identity and server URL come from the stack descriptor.

The app contains no user key material and performs no cryptography for the user. It calls the three
operations in `@coordination-network/user-app-link`, while ordinary HTTP requests go only to its
own member server.

## Replacement surface

`src/business/` is the code a deploying network member replaces:

- `policy.ts` decides whether to enrol or issue and supplies the approval scope.
- `hooks.ts` receives completed business events.
- `branding.ts` names and styles the product.

Everything outside that directory is reusable orchestration around the link protocol and member
server API. Start the stack and relay as described in the [relay setup](../integration-testbed/README.md#browser-link-relay-e1--l7),
then run `yarn workspace network-member-web-app dev --port 4174` for the first member (4175 and
4176 for the others). Each tab asks for the private relay key and its own member server key from
`stack.secrets.json`. Keys can also be supplied with `#relayKey=…&memberKey=…`; they are removed
from the address bar and retained in sessionStorage. They are never read from the public descriptor.

Registration forwards the signed request envelope. Issuance hands endpoint URLs to the wallet,
which returns a stored credential id. Verification uses the returned verification id to read the
authenticated server record; it shows success only when that record accepts the proof.
Successful registration stays in the tab's sessionStorage for that member and network, so a refresh
does not require another registration.
Network membership remains available from the member server's status page.

## Event logging

The default business hook logs completed event names only. It deliberately does not log API
responses because issuance responses contain complete credentials and verification responses
contain complete records.

For debugging with disposable local data, a replacement hook can opt in by using
`createLoggingHooks(true)`. Do not enable detailed hooks in a shared or deployed build: browser
console output may be retained by developer tools, monitoring integrations or screenshots.
