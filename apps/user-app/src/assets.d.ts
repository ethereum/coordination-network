/** Metro resolves a bundled asset to an opaque module id, which `expo-asset` then unpacks. */
declare module "*.noir" {
    const asset: number
    export default asset
}

declare module "*.dat" {
    const asset: number
    export default asset
}
