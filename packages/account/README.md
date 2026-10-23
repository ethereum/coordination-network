# `@coordination-network/account`

Lets a user's or network member's device send onchain actions, like registering an identity or delivering value, without paying gas, while proving through Semaphore that it is allowed to, anonymously. Accounts are EIP-7702 accounts delegating to `Simple7702Account`. gas is paid by `SemaphorePaymaster`.

Three functions, plus Semaphore's `Identity` so callers import from one place. The account object and the user operation are viem's job.

## Install

```bash
yarn add @coordination-network/account
```

## Usage

```typescript
import { http } from "viem"
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction"
import {
    fetchPaymasterSemaphoreGroup,
    generatePaymasterProof,
    Identity,
    signDelegationIfUndelegated
} from "@coordination-network/account"

const group = await fetchPaymasterSemaphoreGroup({
    rpcUrl,
    semaphoreContract: paymasterAddress,
    groupId,
    startBlock: paymasterDeploymentBlock
})
const paymasterData = await generatePaymasterProof({ identity: new Identity(seed), group, sender: owner.address })
const delegation = await signDelegationIfUndelegated({ client, account: owner, implementation })
const account = await toSimple7702SmartAccount({ client, owner, implementation })

const bundlerClient = createBundlerClient({ client, transport: http(bundlerUrl) })
const hash = await bundlerClient.sendUserOperation({
    account,
    calls,
    paymaster: paymasterAddress,
    paymasterData,
    ...delegation
})
await bundlerClient.waitForUserOperationReceipt({ hash })
```

`fetchPaymasterSemaphoreGroup` reads the group's members from the contract, which a Semaphore proof needs for its Merkle path.

`generatePaymasterProof` binds the proof to the sending account and encodes it as the paymaster expects.

`signDelegationIfUndelegated` returns the signed EIP-7702 authorization for the account's first operation, and `undefined` once the account already delegates to `implementation`, so it can be spread into every send.
