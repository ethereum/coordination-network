import { blockScanWindowEnd, growBlockScanWindow, shrinkBlockScanWindow } from "../../src/blockScanWindow.ts"

test("blockScanWindowEnd stops at the head", () => {
    expect(blockScanWindowEnd(10n, 12n, 2000)).toBe(12n)
})

test("blockScanWindowEnd covers a full range below the head", () => {
    expect(blockScanWindowEnd(10n, 100_000n, 2000)).toBe(2009n)
})

test("blockScanWindowEnd of a single-block range is the from block", () => {
    expect(blockScanWindowEnd(10n, 100n, 1)).toBe(10n)
})

test("shrinkBlockScanWindow halves", () => {
    expect(shrinkBlockScanWindow(2000)).toBe(1000)
})

test("shrinkBlockScanWindow never drops below one", () => {
    expect(shrinkBlockScanWindow(1)).toBe(1)
})

test("growBlockScanWindow grows by 5%", () => {
    expect(growBlockScanWindow(1000, 2000)).toBe(1050)
})

test("growBlockScanWindow rounds up", () => {
    expect(growBlockScanWindow(1, 2000)).toBe(2)
})

test("growBlockScanWindow caps at the max", () => {
    expect(growBlockScanWindow(2000, 2000)).toBe(2000)
})
