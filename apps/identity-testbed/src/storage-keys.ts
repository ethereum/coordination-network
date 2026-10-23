export const DEVICE_SECRET_KEY = "testbed.device-secret"

/** Every SecureStore key this app writes — `eraseAll` sweeps exactly this list. */
export const SECURE_STORE_KEYS = [DEVICE_SECRET_KEY] as const
