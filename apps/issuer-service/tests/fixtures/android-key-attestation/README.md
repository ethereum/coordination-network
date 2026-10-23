# Android key attestation test chains

Real attestation chains from Google's
[android/keyattestation](https://github.com/android/keyattestation) `testdata/`,
copied at commit `55c35040a1b5b72e6d63bfb150c5c68a175c1462` under the Apache
License 2.0 in `LICENSE`. Each `.pem` is a chain, leaf first; its `.json` is
Google's decoding of the leaf's key description.

The `.pem` files are unchanged. The `.json` files were reformatted by this
repository's Prettier; their content is unchanged.

All of them attest `noAuthRequired` keys, so none passes this issuer's policy.
`marlin` ends in the software attestation root, and
`invalid/tags_not_in_ascending_order` carries a malformed key description.
