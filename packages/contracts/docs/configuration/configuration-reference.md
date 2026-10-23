# Configuration reference

This document lists the values a production deployment has to choose, across `contracts`,
`network-member-client`, `issuer-service` and `indexer`. Each component's own docs list its
addresses, keys and URLs.

A **hardcoded** value can't change after deployment. It should be decided before deploying.

## Contents

- [Contracts](#contracts)
    - [Network members](#network-members)
    - [Paymaster](#paymaster)
    - [Issuer keys](#issuer-keys)
    - [Revocation](#revocation)
- [Network member client](#network-member-client)
    - [Sponsored operation gas](#sponsored-operation-gas)
- [Issuer service](#issuer-service)
    - [Credential validity](#credential-validity)
    - [Rate limits](#rate-limits)
    - [Device attestation](#device-attestation)
    - [Presentation timing](#presentation-timing)
    - [Direct-write switches](#direct-write-switches)
    - [CORS](#cors)
    - [Log scanning](#log-scanning)
- [Indexer](#indexer)
    - [Chain scanning](#chain-scanning)

## Contracts

### Network members

The network member group is a Semaphore group of approved network members. A network member proves it
belongs before it can register a user or revoke a credential. The governance Safe, a multisig whose
owners are the network members' governance signers, admits and removes network members.

| Value                                                                                                                               | Default               | Changed by             | What it does                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`merkleTreeDuration`](https://github.com/semaphore-protocol/semaphore/blob/v4.14.5/packages/contracts/contracts/Semaphore.sol#L44) | 1 hour                | hardcoded              | How long a replaced group root verifies.<br>A removed network member can still write for the window, counted from when the root was replaced. |
| [`governanceThreshold`](../../src/NetworkMemberGovernance.sol#L115)                                                                 | `memberCount / 2 + 1` | hardcoded              | Signatures the Safe needs: a strict majority.<br>With two network members, either can block a change.                                         |
| [`MIN_MEMBERS`](../../src/NetworkMemberGovernance.sol#L62)                                                                          | 1                     | hardcoded (`constant`) | Fewest network members the network shrinks to.                                                                                                |

### Paymaster

The paymaster, `SemaphorePaymaster`, can sponsor gas payments for network member and user writes. Nothing onchain
links the write to the sponsored network member or user since Semaphore identities are not tied to any other onchain identity. The paymaster holds an ETH
deposit at the ERC-4337 EntryPoint, which pays for each operation. Its own Semaphore group holds the
network members and users it pays gas for.

| Value                                                        | Default | Changed by                                                                              | What it does                                                                                                                                                                                |
| ------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`merkleTreeDuration`](../../src/SemaphorePaymaster.sol#L51) | 1 hour  | group admin, the owner at deploy:<br>`updateGroupMerkleTreeDuration(GROUP_ID, seconds)` | How long a replaced paymaster group root verifies.<br>A removed network member stays sponsored for the window, counted from when the root was replaced.                                     |
| [`MAX_COST_PER_OP`](../../.env.example#L27)                  | 0.1 ETH | hardcoded (`immutable`)                                                                 | Most ETH one operation can cost: gas limits × fee.<br>Too low rejects honest operations when fees rise.<br>7,150,000 gas × 13.9 gwei = 99,385,000 gwei, approx. 100,000,000 gwei (0.1 ETH). |
| [`PAYMASTER_DEPOSIT`](../../.env.example#L33)                | 0.1 ETH | anyone:<br>`deposit()`                                                                  | ETH the paymaster spends on sponsored gas.<br>Must cover every operation in a bundle.                                                                                                       |
| [`PAYMASTER_STAKE`](../../.env.example#L34)                  | 1 ETH   | owner:<br>ETH sent with `addStake`                                                      | ETH locked so bundlers accept the paymaster.<br>The bundler sets the amount, not the EntryPoint.                                                                                            |
| [`PAYMASTER_UNSTAKE_DELAY`](../../.env.example#L37)          | 1 day   | owner:<br>`addStake(unstakeDelaySec)`                                                   | How long the stake stays locked after unlocking. It can only be raised.<br>Bundlers accept one day at minimum, per ERC-7562.                                                                |

### Issuer keys

The approved issuer set holds the issuer keys network members have published. A user's presentation
proves its credential was signed by one of them without saying which.

| Value                                                               | Default             | Changed by                                        | What it does                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`DEFAULT_ROOT_DURATION`](../../src/ApprovedIssuerSet.sol#L35)      | 1 hour              | governance Safe:<br>`updateRootDuration(seconds)` | How long a replaced issuer set root verifies.<br>A retired issuer key backs proofs for up to the window. A change applies to past roots too. |
| [`MAX_DEPTH`](../../src/ApprovedIssuerSet.sol#L29)                  | 20, about 1 million | hardcoded (`constant`)                            | Most issuer keys the set can ever hold.<br>Retired keys keep their slot.                                                                     |
| [`MAX_ISSUER_KEYS_PER_MEMBER`](../../src/ApprovedIssuerSet.sol#L43) | 8                   | hardcoded (`constant`)                            | Most live keys one network member can hold.<br>Bounds the gas of removing a network member.                                                  |

### Revocation

The revocation tree holds every revoked credential. A presentation proves its credential is not in it.

| Value                                                              | Default             | Changed by             | What it does                                                                                               |
| ------------------------------------------------------------------ | ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`DEFAULT_ROOT_DURATION`](../../src/revocation/Revocation.sol#L26) | 1 hour              | hardcoded (`constant`) | How long a replaced revocation root verifies.<br>A revoked credential still verifies for up to the window. |
| [`REVOCATION_MAX_DEPTH`](../../../circuits/src/main.nr#L13)        | 20, about 1 million | hardcoded              | Most revocations a presentation can prove against.<br>Past it, no user can build a presentation.           |

## Network member client

### Sponsored operation gas

The network member client builds the sponsored operations the issuer service sends through the
paymaster. Their gas limits are hardcoded and their fee comes from the RPC node.

| Value                                                                     | Default             | Changed by | What it does                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`GAS_LIMITS`](../../../network-member-client/src/sponsored-relay.ts#L45) | 7.15 million in all | hardcoded  | Gas each sponsored operation may use, sized for a revocation into a depth-20 tree.<br>Limits times the fee must stay under `MAX_COST_PER_OP`.<br>See code for gas variables, calc: 6,050,000 + 230,000 + 400,000 + 470,000 = 7,150,000 gas. |

## Issuer service

Each network member runs an issuer service. It issues credentials to users and verifies their
presentations, and it sends registrations, deliveries and revocations to the chain. The
[issuer service README](../../../../apps/issuer-service/README.md) documents every environment
variable. Credential validity is the only hardcoded value here.

### Credential validity

| Value                                                                  | Default | Changed by | What it does                                                                                      |
| ---------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------- |
| [`validitySeconds`](../../../../apps/issuer-service/src/server.ts#L51) | 30 days | hardcoded  | How long an issued credential lasts.<br>Longer leaves a stolen credential usable, unless revoked. |

### Rate limits

Each limit is per server, not per user.

| Value                                                                            | Default | Changed by | What it does                        |
| -------------------------------------------------------------------------------- | ------- | ---------- | ----------------------------------- |
| [`CHALLENGES_PER_MINUTE`](../../../../apps/issuer-service/src/config.ts#L94)     | 30      | env var    | Challenges per 60-second window.    |
| [`ISSUANCES_PER_MINUTE`](../../../../apps/issuer-service/src/config.ts#L96)      | 30      | env var    | Issuances per 60-second window.     |
| [`REGISTRATIONS_PER_MINUTE`](../../../../apps/issuer-service/src/config.ts#L172) | 30      | env var    | Registrations per 60-second window. |
| [`DELIVERIES_PER_MINUTE`](../../../../apps/issuer-service/src/config.ts#L194)    | 30      | env var    | Deliveries per 60-second window.    |
| [`REVOCATIONS_PER_MINUTE`](../../../../apps/issuer-service/src/config.ts#L196)   | 30      | env var    | Revocations per 60-second window.   |

### Device attestation

Before issuing, the service checks the user's Android phone attestation, which shows where the phone
keeps its key. It also checks Google's list of revoked devices.

| Value                                                                                            | Default               | Changed by | What it does                                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`MIN_DEVICE_SECURITY_LEVEL`](../../../../apps/issuer-service/src/config.ts#L98)                 | `TRUSTED_ENVIRONMENT` | env var    | Lowest Android key security level issuance accepts.<br>`SOFTWARE` skips attestation, and `STRONGBOX` rules out many phones. |
| [`DEVICE_ATTESTATION_MAX_STALENESS_SECONDS`](../../../../apps/issuer-service/src/config.ts#L103) | 3 days                | env var    | Age of Google's revocation list before issuance stops.<br>Shorter catches revoked devices sooner but fails more.            |

### Presentation timing

A verifier asks a user for a presentation, a zero-knowledge proof about the user's credential, and
the issuer service checks it.

| Value                                                                                    | Default | Changed by | What it does                                                                |
| ---------------------------------------------------------------------------------------- | ------- | ---------- | --------------------------------------------------------------------------- |
| [`VERIFY_MAX_SKEW_SECONDS`](../../../../apps/issuer-service/src/config.ts#L255)          | 300     | env var    | Drift allowed from the server's clock.                                      |
| [`PRESENTATION_REQUEST_TTL_SECONDS`](../../../../apps/issuer-service/src/config.ts#L259) | 300     | env var    | How long a presentation request stays usable.                               |
| [`VERIFICATION_RECORD_TTL_SECONDS`](../../../../apps/issuer-service/src/config.ts#L261)  | 1 day   | env var    | How long a verification outcome is kept.<br>Shorter keeps less about users. |

### Direct-write switches

By default every write goes through the paymaster from a fresh address. Each switch lets one kind of
write come from the network member's own funded key, which records the network member's address
against that write onchain.

| Value                                                                              | Default | Changed by | What it does                                                                                       |
| ---------------------------------------------------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------------- |
| [`ALLOW_DIRECT_REGISTRATION`](../../../../apps/issuer-service/src/config.ts#L170)  | `false` | env var    | Registrations from the network member's own key.<br>Ties each enrolled user to the network member. |
| [`ALLOW_DIRECT_DELIVERY`](../../../../apps/issuer-service/src/config.ts#L190)      | `false` | env var    | Deliveries from the network member's own key.<br>Ties each delivery to the network member.         |
| [`ALLOW_DIRECT_REVOCATION`](../../../../apps/issuer-service/src/config.ts#L192)    | `false` | env var    | Revocations from the network member's own key.<br>Ties each revocation to the network member.      |
| [`ALLOW_IN_MEMORY_REVOCATION`](../../../../apps/issuer-service/src/config.ts#L206) | `false` | env var    | Revocations kept in memory.<br>Lost on restart, so local testing only.                             |

### CORS

Browsers only let a web page call the issuer service from an origin the service allows.

| Value                                                                        | Default | Changed by | What it does                                                                         |
| ---------------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------ |
| [`CORS_ALLOWED_ORIGINS`](../../../../apps/issuer-service/src/config.ts#L114) | empty   | env var    | Browser origins allowed to call the server.<br>Add exact origins only for a web app. |

### Log scanning

The service rebuilds both Semaphore groups and the pending join requests from contract event logs.

| Value                                                                              | Default | Changed by | What it does                                                                                                             |
| ---------------------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`LOG_WINDOW_BLOCKS`](../../../../apps/issuer-service/src/config.ts#L176)          | unset   | env var    | Widest `eth_getLogs` range.<br>Unset reads each range in one call, which hosted RPCs may reject.                         |
| [`LOG_CONFIRMATIONS`](../../../../apps/issuer-service/src/config.ts#L178)          | unset   | env var    | How far the join-request scan trails the tip of the chain.<br>Unset rescans every read, and 2 suits public Sepolia RPCs. |
| [`MEMBER_GROUP_FROM_BLOCK`](../../../../apps/issuer-service/src/config.ts#L174)    | 0       | env var    | Where the network member group scan starts.<br>Set to `blockNumber` in the deployment file.                              |
| [`PAYMASTER_GROUP_FROM_BLOCK`](../../../../apps/issuer-service/src/config.ts#L168) | 0       | env var    | Where the paymaster group scan starts.<br>Set to `blockNumber` in the deployment file.                                   |
| [`GOVERNANCE_DEPLOY_BLOCK`](../../../../apps/issuer-service/src/config.ts#L250)    | 0       | env var    | Where the join-request scan starts.<br>Set to `blockNumber` in the deployment file.                                      |

## Indexer

### Chain scanning

The indexer scans ERC-5564 announcements for stealth deliveries to the network member's users. The Default
column shows the value `.env.example` uses. The [indexer README](../../../../apps/indexer/README.md) documents them all.

| Value                                                                      | Default     | Changed by | What it does                                                                                             |
| -------------------------------------------------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| [`CONFIRMATIONS`](../../../../apps/indexer/src/config.ts#L51)              | 5           | env var    | Blocks behind the tip of the chain before a block counts as scanned.<br>Reorgs are rare beyond 2 blocks. |
| [`START_BLOCK`](../../../../apps/indexer/src/config.ts#L44)                | 25790000    | env var    | Read only by `/health`, which reports one block below it as scanned before any key is registered.        |
| [`SCAN_INTERVAL_MS`](../../../../apps/indexer/src/config.ts#L45)           | 5000        | env var    | Polling interval.<br>Shorter finds deliveries sooner and costs more RPC calls.                           |
| [`MAX_BLOCK_SCAN_WINDOW_SIZE`](../../../../apps/indexer/src/config.ts#L50) | 2000        | env var    | Widest `eth_getLogs` range.<br>Shrunk automatically when the RPC rejects it.                             |
| [`TRUSTED_PROXY_ADDRESS`](../../../../apps/indexer/src/config.ts#L40)      | `127.0.0.1` | env var    | Proxy allowed to set the logged client address.                                                          |
