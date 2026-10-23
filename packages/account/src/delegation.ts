import { isAddressEqual, type Address, type PrivateKeyAccount, type PublicClient, type SignedAuthorization } from "viem"

export async function signDelegationIfUndelegated({
    client,
    account,
    implementation
}: {
    client: PublicClient
    account: PrivateKeyAccount
    implementation: Address
}): Promise<{ authorization: SignedAuthorization } | undefined> {
    const delegatedTo = await client.getDelegation({ address: account.address })
    if (delegatedTo && isAddressEqual(delegatedTo, implementation)) return undefined

    const authorization = await account.signAuthorization({
        chainId: await client.getChainId(),
        contractAddress: implementation,
        nonce: await client.getTransactionCount({ address: account.address })
    })
    return { authorization }
}
