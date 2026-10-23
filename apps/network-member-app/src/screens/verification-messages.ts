/** Public refusal messages shared by same-phone and QR verification. */
export const CODE_LINE: Record<string, string> = {
    ISSUER_ROOT_MISMATCH: "Issuer list out of date",
    REVOCATION_ROOT_INVALID: "Credential revoked",
    CREDENTIAL_REVOKED: "Credential revoked",
    NO_CREDENTIAL: "No matching credential"
}
