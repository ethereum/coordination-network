/** The zero address, the Safe's "unset" value for `gasToken` and `refundReceiver`. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/**
 * The gas and refund fields of every transaction this package builds, all zeroed.
 *
 * A Safe transaction can reimburse whoever submitted it out of the Safe's own
 * balance. This flow does not: the network member that sends the transaction
 * pays its own gas, and the Safe never holds or moves funds. Zeroing these
 * fields is what turns that off, so every transaction this package builds
 * refunds nobody.
 */
export const NO_REFUND = {
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS
} as const
