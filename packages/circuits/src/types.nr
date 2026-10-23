pub struct Credential {
    pub(crate) programme_hash: Field,
    pub(crate) country_code: Field,
    pub(crate) not_before: u64,
    pub(crate) expires_at: u64,
    pub(crate) device_key_commitment: Field,
    pub(crate) holder_key_commitment: Field,
    pub(crate) revocation_commitment: Field,
}
