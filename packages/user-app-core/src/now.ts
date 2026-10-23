import type { UserAppPorts } from "./types"

/** `ports.now` is optional (a test harness injects a deterministic clock); real ports omit it. */
export function nowFn(ports: Pick<UserAppPorts, "now">): number {
    return (ports.now ?? Date.now)()
}
