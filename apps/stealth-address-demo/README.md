# Stealth address demonstration

This repo demonstrates the full stealth address flow using six functions, built on the `@coordination-network/identity` SDK.

## Getting started

Requires [Foundry](https://getfoundry.sh) and Node.

```bash
yarn && yarn build
cd apps/stealth-address-demo
yarn test
```

## API

**1. The receiver derives their meta stealth address**

```ts
const metaStealthAddress = generateMetaStealthAddress(deviceSecret)
```

**2. The sender derives a stealth account from that meta stealth address**

```ts
const ephemeralKey = generateEphemeralKey()
const stealthAddress = generateStealthAccount(metaStealthAddress, ephemeralKey.privateKey)
```

**3. The sender sends funds to the receiver stealth account**

```ts
await payStealthAccount({ stealthAddress, tokenAddress, tokenId: 1n, amount: 100n })
```

**4. The sender announces the payment onchain**

```ts
await publishAnnouncement({ metaStealthAddress, ephemeralKey, announcerAddress })
```

**5. The receiver scans the announcements with their viewing key to find their account**

```ts
const stealthAddress = await scanForAnnouncement(deviceSecret, announcerAddress)
```

**6. The receiver recovers the stealth account and spends funds**

```ts
await spendReceivedFunds({
    ephemeralKey,
    viewingPrivateKey,
    spendingPrivateKey,
    stealthAddress,
    recipient,
    tokenAddress,
    tokenId: 1n,
    amount: 100n
})
```

## Production differences

- Meta stealth addresses are looked up from the `IdentityRegistry`
- Gas is sponsored via the Semaphore paymaster.
- Step 5 rescans from local node genesis. In production, we use `apps/indexer`
