// The approved-issuer set now lives in @coordination-network/issuer-set, which the ApprovedIssuerSet.sol
// contract's TypeScript mirror also builds on. Re-exported here so every existing import of this module
// keeps working unchanged.
export {
    ApprovedIssuerSet,
    ISSUER_LEAF_DOMAIN,
    ISSUER_SET_MAX_DEPTH,
    issuerLeaf
} from "@coordination-network/issuer-set"
export type { IssuerMembershipProof, IssuerSet } from "@coordination-network/issuer-set"
