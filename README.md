<p align="center">
    <h1 align="center">
        Coordination Network
    </h1>
    <p align="center">A multi-organization coordination network monorepo.</p>
</p>

<p align="center">
    <a href="https://github.com/ethereum" target="_blank">
        <img src="https://img.shields.io/badge/project-ethereum-blue.svg?style=flat-square">
    </a>
    <!-- Shields.io cannot read a private repo, so it renders "repo not found".
         Swap back to the commented badge below once the repository is public.
    <a href="https://github.com/ethereum/coordination-network/blob/main/LICENSE">
        <img alt="Github license" src="https://img.shields.io/github/license/ethereum/coordination-network">
    </a>
    -->
    <a href="https://github.com/ethereum/coordination-network/blob/main/LICENSE">
        <img alt="Github license" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square">
    </a>
    <!-- Shields.io cannot read a private repo, so it renders "repo or workflow not found".
         Swap back to the commented badge below once the repository is public.
    <a href="https://github.com/ethereum/coordination-network/actions?query=workflow%3Aproduction">
        <img alt="GitHub Workflow test" src="https://img.shields.io/github/actions/workflow/status/ethereum/coordination-network/production.yml?branch=main&style=flat-square&logo=github&label=test">
    </a>
    -->
    <a href="https://github.com/ethereum/coordination-network/actions/workflows/production.yml">
        <img alt="GitHub Workflow test" src="https://github.com/ethereum/coordination-network/actions/workflows/production.yml/badge.svg?branch=main">
    </a>
    <!-- Coveralls uploads are disabled while the repository is private.
         Uncomment together with the Coveralls step in the workflows once it is public.
    <a href="https://coveralls.io/github/ethereum/coordination-network">
        <img alt="Coveralls" src="https://img.shields.io/coverallsCoverage/github/ethereum/coordination-network?style=flat-square&logo=coveralls&label=coverage%20(ts)">
    </a>
    -->
    <a href="https://eslint.org/">
        <img alt="Linter eslint" src="https://img.shields.io/badge/linter-eslint-8080f2?style=flat-square&logo=eslint">
    </a>
    <a href="https://prettier.io/">
        <img alt="Code style prettier" src="https://img.shields.io/badge/code%20style-prettier-f8bc45?style=flat-square&logo=prettier">
    </a>
    <a href="http://commitizen.github.io/cz-cli/">
        <img alt="Commitizen friendly" src="https://img.shields.io/badge/commitizen-friendly-586D76?style=flat-square">
    </a>
</p>

<div align="center">
    <h4>
        <a href="/CONTRIBUTING.md">
            👥 Contributing
        </a>
        <span>&nbsp;&nbsp;|&nbsp;&nbsp;</span>
        <a href="/CODE_OF_CONDUCT.md">
            🤝 Code of conduct
        </a>
        <span>&nbsp;&nbsp;|&nbsp;&nbsp;</span>
        <a href="https://github.com/ethereum/coordination-network/issues/new/choose">
            🔎 Issues
        </a>
    </h4>
</div>

| Coordination Network is a monorepo of applications, tools and libraries for multi-organization coordination. |
| ------------------------------------------------------------------------------------------------------------ |

♚ [Yarn workspaces](https://yarnpkg.com/features/workspaces): minimal monorepo package management (`yarn`, `yarn build`)\
♛ [Conventional Commits](https://www.conventionalcommits.org): human and machine readable meaning to commit messages (`czg` + `commitlint`)\
♜ [Jest](https://jestjs.io/): tests and test coverage for all libraries (`yarn test:libraries`)\
♞ [ESLint](https://eslint.org/), [Prettier](https://prettier.io/): code quality and formatting (`yarn lint` & `yarn format`)\
♟ [Github actions](https://github.com/features/actions): software workflows for automatic testing and code quality checks

## 📦 Packages

<table>
    <th>Package</th>
    <th>Version</th>
    <th>Downloads</th>
    <tbody>
        <tr>
            <td>
                <a href="/packages/account">
                    @coordination-network/account
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/account">
                    <img src="https://img.shields.io/npm/v/@coordination-network/account.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/account">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/account.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/circuits">
                    @coordination-network/circuits
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/circuits">
                    <img src="https://img.shields.io/npm/v/@coordination-network/circuits.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/circuits">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/circuits.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/contracts">
                    @coordination-network/contracts
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/contracts">
                    <img src="https://img.shields.io/npm/v/@coordination-network/contracts.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/contracts">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/contracts.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/credential">
                    @coordination-network/credential
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/credential">
                    <img src="https://img.shields.io/npm/v/@coordination-network/credential.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/credential">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/credential.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/expo-identity-keystore">
                    @coordination-network/expo-identity-keystore
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/expo-identity-keystore">
                    <img src="https://img.shields.io/npm/v/@coordination-network/expo-identity-keystore.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/expo-identity-keystore">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/expo-identity-keystore.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/identity">
                    @coordination-network/identity
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/identity">
                    <img src="https://img.shields.io/npm/v/@coordination-network/identity.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/identity">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/identity.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/issuer-set">
                    @coordination-network/issuer-set
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/issuer-set">
                    <img src="https://img.shields.io/npm/v/@coordination-network/issuer-set.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/issuer-set">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/issuer-set.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/network-member-app-core">
                    @coordination-network/network-member-app-core
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-app-core">
                    <img src="https://img.shields.io/npm/v/@coordination-network/network-member-app-core.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-app-core">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/network-member-app-core.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/network-member-client">
                    @coordination-network/network-member-client
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-client">
                    <img src="https://img.shields.io/npm/v/@coordination-network/network-member-client.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-client">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/network-member-client.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/network-member-governance">
                    @coordination-network/network-member-governance
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-governance">
                    <img src="https://img.shields.io/npm/v/@coordination-network/network-member-governance.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-governance">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/network-member-governance.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/network-member-proof">
                    @coordination-network/network-member-proof
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-proof">
                    <img src="https://img.shields.io/npm/v/@coordination-network/network-member-proof.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/network-member-proof">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/network-member-proof.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/noir-prover-native/rust/MoproReactNativeBindings">
                    @coordination-network/noir-prover-ffi
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/noir-prover-ffi">
                    <img src="https://img.shields.io/npm/v/@coordination-network/noir-prover-ffi.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/noir-prover-ffi">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/noir-prover-ffi.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/noir-prover-native">
                    @coordination-network/noir-prover-native
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/noir-prover-native">
                    <img src="https://img.shields.io/npm/v/@coordination-network/noir-prover-native.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/noir-prover-native">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/noir-prover-native.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/revocation-registry">
                    @coordination-network/revocation-registry
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/revocation-registry">
                    <img src="https://img.shields.io/npm/v/@coordination-network/revocation-registry.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/revocation-registry">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/revocation-registry.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/user-app-core">
                    @coordination-network/user-app-core
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/user-app-core">
                    <img src="https://img.shields.io/npm/v/@coordination-network/user-app-core.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/user-app-core">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/user-app-core.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/user-app-link">
                    @coordination-network/user-app-link
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/user-app-link">
                    <img src="https://img.shields.io/npm/v/@coordination-network/user-app-link.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/user-app-link">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/user-app-link.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/user-client">
                    @coordination-network/user-client
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/user-client">
                    <img src="https://img.shields.io/npm/v/@coordination-network/user-client.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/user-client">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/user-client.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/wallet">
                    @coordination-network/wallet
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/wallet">
                    <img src="https://img.shields.io/npm/v/@coordination-network/wallet.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/wallet">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/wallet.svg?style=flat-square" />
                </a>
            </td>
        </tr>
        <tr>
            <td>
                <a href="/packages/zk-artifacts">
                    @coordination-network/zk-artifacts
                </a>
            </td>
            <td>
                <!-- NPM version -->
                <a href="https://npmjs.org/package/@coordination-network/zk-artifacts">
                    <img src="https://img.shields.io/npm/v/@coordination-network/zk-artifacts.svg?style=flat-square" />
                </a>
            </td>
            <td>
                <!-- Downloads -->
                <a href="https://npmjs.org/package/@coordination-network/zk-artifacts">
                    <img src="https://img.shields.io/npm/dm/@coordination-network/zk-artifacts.svg?style=flat-square" />
                </a>
            </td>
        </tr>
    </tbody>
</table>

## 📱 Apps

| App                                                                                                                                                                    | What it is                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/user-app`](apps/user-app)                                                                                                                                       | The person's crypto core, on Android, shown on screen as the wallet. Device secret, hardware P-256 key, derived keys, held credentials, presentation proving. No business logic; it serves network member apps over deep links, each request behind a consent screen. |
| [`apps/issuer-service`](apps/issuer-service)                                                                                                                           | A network member's server, run once per member (three members in the demo stack): submits sponsored registrations, requests and grants admission, publishes issuer keys, issues and revokes credentials, verifies presentations, and serves its own status page.      |
| [`apps/integration-testbed`](apps/integration-testbed)                                                                                                                 | The end-to-end flows in Node, and `yarn stack`: a local chain with the governance Safe, the paymaster and a bundler, three member servers, and a dashboard.                                                                                                           |
| [`apps/identity-testbed`](apps/identity-testbed)                                                                                                                       | Conformance vectors and the hardware keystore, exercised on a real device.                                                                                                                                                                                            |
| [`apps/registry-demo`](apps/registry-demo), [`apps/stealth-address-demo`](apps/stealth-address-demo), [`apps/web-demo`](apps/web-demo), [`apps/indexer`](apps/indexer) | Governance, stealth-address and browser demos, and the announcement indexer.                                                                                                                                                                                          |

The user app shares its logic with the planned browser apps:
`@coordination-network/user-app-core` holds the three operations a user app answers, over injected
ports, so the app is its ports and its screens. The screens are built from
`@coordination-network/app-ui`, the component set both phone apps share.

To run it, start the stack, open the dashboard it prints, and build the app as
[`apps/user-app`](apps/user-app)'s README describes:

```bash
yarn stack          # anvil, the governance Safe and contracts, the paymaster and a bundler, three member servers, a dashboard
```

To run the same stack against a network you deployed with the
[runbook](packages/contracts/docs/testing/e2e-runbook.md), put `RPC_URL`, `OWNER_PRIVATE_KEY`,
`STACK_BUNDLER_PRIVATE_KEY` and `STACK_MEMBER_SEEDS` in an untracked `.stack.env` and load it, then run
`yarn stack:genesis` and `yarn stack:testnet` to serve it. Genesis sets the network up once and is rerun
only to refill drained accounts or the deposit, never while the stack serves; `OWNER` needs about 0.50 ETH
for it on top of the deploy. A relative `DEPLOYMENT_FILE` is from the repository root. The phones keep the same ports. See
[`apps/integration-testbed`](apps/integration-testbed)'s README for the variables, the preflight and what
genesis does.

```bash
yarn stack:genesis  # sets the network up once, rerun to refill: fund accounts, admit the founders, publish their issuer keys
yarn stack:testnet  # the same stack and dashboard, with no deploy step
```

The dashboard opens on its Flow tab: a live line naming whatever member most recently did, then five
narrated flows — onboard the user, verify and issue the credential, prove with the credential,
revoke the credential, and a second founder signing up the same person — each with a plain sentence
and a live status. Its Members, Network, Chain and Connect tabs hold the rest: two founding members
(admitted at genesis, each with a phone app) and a candidate member (a server and a status page but no
phone app) each in their own colour, admission and credential actions proxied
through the dashboard, the chain and contracts, and the stack descriptor's QR code that the wallet
scans on first launch. See [`apps/integration-testbed`](apps/integration-testbed)'s README for what
each tab shows.

This walks through the same ground as [`specs/06-full-architecture-ws1.md`](specs/06-full-architecture-ws1.md)'s
WS1 flows 1 to 5: identity on the phone, registration paid by the Semaphore paymaster from a fresh
stealth address, member admission through the Safe, credential issuance, and presentation with
revocation. Stealth sends, flow 6, wait for the next workstream.

The app needs a dev build rather than Expo Go, since the keystore module and the native prover are
native code. Android only, for now, and 64-bit Arm (`arm64-v8a`) only.

On a phone, the wallet and each member app need a rebuilt dev client after this round (Reanimated is a
new native dependency), and the wallet's stored data should be erased once too, since held
credentials gained fields an older build never wrote. Forward the stack's ports over USB and run
each app's own Metro — user-app on `8081`, and each member app on `8082` or `8083` with
`EXPO_PUBLIC_MEMBER_ID` set on both its build and its `expo start` — then point the wallet at the
dashboard's `stack.json`, and pair each member app from its own QR in the `yarn stack` terminal
(`STACK_HOST` picks the address both advertise to a phone on the cable). See [`apps/user-app`](apps/user-app)'s README for the wallet's own commands.

### Pinned SDK bundle

The published `@coordination-network/*` packages all share one version, shown in the [packages](#-packages) table.
`app-ui` stays private because only the reference apps use it. The apps build every package from source, so
pin a demo run to a commit rather than to `main`.

## 🛠 Install

Clone this repository:

```bash
git clone https://github.com/ethereum/coordination-network.git
```

and install the dependencies:

```bash
cd coordination-network && yarn
```

The Solidity packages need [Foundry](https://getfoundry.sh/). Install the version this repository is pinned to:

```bash
yarn setup:foundry
```

The version matters beyond the compiler: `forge fmt` and `forge lint` change between releases, so an unpinned toolchain can fail `yarn style` in CI on code that passed locally, or the reverse. Plain `foundryup` installs a nightly build and will drift. CI installs the same pinned version, set in [`.github/workflows`](.github/workflows).

The credential circuit used by `yarn build` and `yarn start` requires [Nargo](https://noir-lang.org/docs/installation). Install Noir's toolchain manager and select the version pinned in CI:

```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup --version 1.0.0-beta.22
```

## 📜 Usage

### Code quality and formatting

Run [ESLint](https://eslint.org/) to analyze the code and catch bugs:

```bash
yarn lint
```

or to automatically fix fixable issues:

```bash
yarn lint:fix
```

Run [Prettier](https://prettier.io/) to check formatting rules:

```bash
yarn format
```

or to automatically format the code:

```bash
yarn format:write
```

To run both linting and formatting checks together:

```bash
yarn style
```

### Conventional commits

Coordination Network uses [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/). When you run `git commit`, a Git hook launches [czg](https://cz-git.qbb.sh/) to guide you through crafting a compliant message, and [commitlint](https://commitlint.js.org/) validates it. Staged files are also checked against ESLint and Prettier rules via `lint-staged` before the commit is created.

### Testing

Test the code with coverage:

```bash
yarn test
```

To test a single package:

```bash
yarn test:library <package-name>
```

### Build

Build all the packages:

```bash
yarn build
```

A `dist` folder will be created inside each JavaScript package.

### Releases

All the packages are released together on one shared version. Bump it with:

```bash
yarn version:bump <version>
# e.g. yarn version:bump 0.2.0
```

It will set that version on every published package and create a commit and a `v<version>` git tag. Then push both to the main branch:

```bash
git push && git push origin v<version>
# e.g. git push && git push origin v0.2.0
```

Pushing the tag triggers a workflow that builds the packages, publishes them on [npm](https://www.npmjs.com/) and releases a new version on Github with its changelogs automatically.
