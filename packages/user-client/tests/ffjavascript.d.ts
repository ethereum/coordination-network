declare module "ffjavascript" {
    export interface Curve {
        terminate(): Promise<void>
    }

    export function getCurveFromName(name: string): Promise<Curve>
}
