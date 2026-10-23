// forge coverage has no threshold option, so this reads the lcov it writes and fails below the floors.
import { readFileSync } from "node:fs"

const LCOV_PATH = "packages/contracts/lcov.info"
const MINIMUM_LINE_PERCENT = 98
const MINIMUM_FUNCTION_PERCENT = 97

const lcovReport = readFileSync(LCOV_PATH, "utf8")

let linesFound = 0
let linesHit = 0
let functionsFound = 0
let functionsHit = 0
for (const [, field, count] of lcovReport.matchAll(/^(LF|LH|FNF|FNH):(\d+)$/gm)) {
    if (field === "LF") linesFound += Number(count)
    if (field === "LH") linesHit += Number(count)
    if (field === "FNF") functionsFound += Number(count)
    if (field === "FNH") functionsHit += Number(count)
}

const linePercent = (100 * linesHit) / linesFound
const functionPercent = (100 * functionsHit) / functionsFound
console.info(`${LCOV_PATH}: lines ${linePercent.toFixed(2)}% functions ${functionPercent.toFixed(2)}%`)

if (linePercent < MINIMUM_LINE_PERCENT || functionPercent < MINIMUM_FUNCTION_PERCENT) {
    console.error(`${LCOV_PATH}: below floor of lines ${MINIMUM_LINE_PERCENT}% functions ${MINIMUM_FUNCTION_PERCENT}%`)
    process.exit(1)
}
