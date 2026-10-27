// forge coverage has no threshold option, so this reads the lcov it writes and fails below the floors.
import { readFileSync } from "node:fs"

const LCOV_PATH = "packages/contracts/lcov.info"
const MINIMUM_LINE_PERCENT = 100
const MINIMUM_FUNCTION_PERCENT = 100
const MINIMUM_BRANCH_PERCENT = 95

const lcovReport = readFileSync(LCOV_PATH, "utf8")

let linesFound = 0
let linesHit = 0
let functionsFound = 0
let functionsHit = 0
let branchesFound = 0
let branchesHit = 0
for (const [, field, count] of lcovReport.matchAll(/^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/gm)) {
    if (field === "LF") linesFound += Number(count)
    if (field === "LH") linesHit += Number(count)
    if (field === "FNF") functionsFound += Number(count)
    if (field === "FNH") functionsHit += Number(count)
    if (field === "BRF") branchesFound += Number(count)
    if (field === "BRH") branchesHit += Number(count)
}

const linePercent = (100 * linesHit) / linesFound
const functionPercent = (100 * functionsHit) / functionsFound
const branchPercent = (100 * branchesHit) / branchesFound
console.info(
    `${LCOV_PATH}: lines ${linePercent.toFixed(2)}% functions ${functionPercent.toFixed(2)}% branches ${branchPercent.toFixed(2)}%`
)

// Written as "meets every floor" so a report missing a metric, which divides 0 by 0 into NaN, fails.
const meetsFloors =
    linePercent >= MINIMUM_LINE_PERCENT &&
    functionPercent >= MINIMUM_FUNCTION_PERCENT &&
    branchPercent >= MINIMUM_BRANCH_PERCENT

if (!meetsFloors) {
    console.error(
        `${LCOV_PATH}: below floor of lines ${MINIMUM_LINE_PERCENT}% functions ${MINIMUM_FUNCTION_PERCENT}% branches ${MINIMUM_BRANCH_PERCENT}%`
    )
    process.exit(1)
}
