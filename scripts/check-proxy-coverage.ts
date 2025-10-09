/**
 * This module checks the coverage of proxy filtering tests across different chains.
 * Such tests are used to ensure that proxy types:
 * 1. *can* make calls they are allowed to: (referred to as"allowed" tests in this module)
 * 2. *cannot* make calls they are forbidden from making: (referred to as "forbidden" tests)
 *
 * This [issue](https://github.com/open-web3-stack/polkadot-ecosystem-tests/pull/266) showed that some proxy types were
 * not covered by proxy filtering tests, despite being present in the test module.
 * This was due to an oversight when building each proxy type's actions for tests.
 *
 * Due to the wide scope of the tests and the considerable size of each snapshot file, it is not effective to manually
 * check each proxy type's coverage.
 *
 * This script is thus used to check the coverage of proxy filtering tests for all proxy types in all chains.
 *
 * For each chain (Polkadot, Kusama, etc.), it:
 * 1. Finds the chain's proxy E2E test snapshot file
 * 2. Searches for both "allowed" and "forbidden" proxy call tests for each proxy type
 * 3. Reports which proxy types have tests, and which don't
 *
 * This helps ensure that all proxy types have proper test coverage for both allowed and forbidden
 * proxy call scenarios.
 */

import { createReadStream, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  AssetHubPolkadotProxyTypes,
  CollectivesProxyTypes,
  CoretimeProxyTypes,
  KusamaProxyTypes,
  PeopleProxyTypes,
  PolkadotProxyTypes,
  type ProxyTypeMap,
} from '../packages/shared/src/helpers/proxyTypes.js'

/**
 * When printing the results for each network's proxy type, pad the output to this length.
 */
const PAD_LENGTH = 40

/**
 * Generate a unique background color for a network's filepath when logged.
 * A simple hash function is used to convert the network name into a number between 16 and 231
 * (the range of 6x6x6 color cube in ANSI colors).
 *
 * @param networkName The name of the network
 * @returns ANSI escape code for a background color
 */
function getNetworkBackgroundColor(networkName: string): string {
  // Simple hash function to get a number from a string
  let hash = 0
  for (let i = 0; i < networkName.length; i++) {
    hash = (hash << 5) - hash + networkName.charCodeAt(i)
  }

  // Map the hash to a color in the ANSI 6 x 6 x 6 color cube (colors from 16 to 231).
  const color = (Math.abs(hash) % 216) + 16

  return `\x1b[48;5;${color}m`
}

/**
 * An object with a chain's name and its proxy types.
 * The name used must correspond with the name of the chain's snapshot file; for example,
 * if Polkadot's proxy E2E test snapshots are in `polkadot.proxy.e2e.test.ts.snap`, then the name
 * should be `polkadot`.
 */
interface ChainAndProxyTypes {
  name: string
  proxyTypes: ProxyTypeMap
}

/**
 * The list of chains that currently have proxy E2E test snapshots, and their proxy types.
 */
const networks: ChainAndProxyTypes[] = [
  { name: 'polkadot', proxyTypes: PolkadotProxyTypes },
  { name: 'kusama', proxyTypes: KusamaProxyTypes },
  { name: 'assetHubPolkadot', proxyTypes: AssetHubPolkadotProxyTypes },
  { name: 'assetHubKusama', proxyTypes: AssetHubPolkadotProxyTypes },
  { name: 'collectivesPolkadot', proxyTypes: CollectivesProxyTypes },
  { name: 'coretimePolkadot', proxyTypes: CoretimeProxyTypes },
  { name: 'coretimeKusama', proxyTypes: CoretimeProxyTypes },
  { name: 'peoplePolkadot', proxyTypes: PeopleProxyTypes },
  { name: 'peopleKusama', proxyTypes: PeopleProxyTypes },
]

/**
 * Represents the test results for a single proxy type, with the status for both allowed and forbidden tests.
 */
type TestTypes = {
  allowed: string
  forbidden: string
}

/**
 * Result of a search for proxy filtering tests for a given chain.
 *
 * Each of the outer keys is a string representing a proxy type in that chain.
 * Each proxy type's corresponding value is an object containing:
 * - `allowed`: a message indicating whether the snapshot file contained _any_ "allowed" test for that proxy type
 * - `forbidden`: the same, but for forbidden tests of that proxy type
 *
 * In either case, if the test is found, the message will be `✅ (line <line number>)`, where the line number is for
 * _any_ of the found tests, with no guarantees on match ordinality cardinality.
 * If not, the message will be `❌ (not found)`.
 */
type SearchResult = Record<string, TestTypes>

/**
 * Creates a new SearchResult with all proxy types initialized to "not found" status.
 *
 * @param proxyTypes The proxy types to initialize results for
 * @returns A SearchResult with all proxy types initialized
 */
function createSearchResult(proxyTypes: ProxyTypeMap): SearchResult {
  return Object.fromEntries(
    Object.keys(proxyTypes).map((proxyTypeName) => [
      proxyTypeName,
      {
        allowed: `${`${proxyTypeName} allowed tests:`.padEnd(PAD_LENGTH, ' ')} ❌ (not found)`,
        forbidden: `${`${proxyTypeName} forbidden tests:`.padEnd(PAD_LENGTH, ' ')} ❌ (not found)`,
      },
    ]),
  )
}

/**
 * Find proxy filtering tests for all proxy types in a given chain.
 * The search is done in the given file, which must be an E2E test snapshot file.
 *
 * @param chain The chain whose proxy types' tests will be checked.
 * @param networkSnapshotFilename The path to the chain's proxy E2E test snapshot file.
 * @returns A promise that resolves to a record of proxy types -> their search results.
 */
function findProxyFilteringTests(chain: ChainAndProxyTypes, networkSnapshotFilename: string): Promise<SearchResult> {
  const proxyTypes = chain.proxyTypes
  const proxyTestResults = createSearchResult(proxyTypes)

  return new Promise((resolve) => {
    // Open the chain's snapshot file.
    const fileStream = readline.createInterface({
      input: createReadStream(networkSnapshotFilename),
      crlfDelay: Number.POSITIVE_INFINITY,
    })

    let lineNumber = 0

    // For each line in the snapshot file, check if it contains any proxy filtering test for any of the proxy types.
    // If either test type is found for any proxy types, move on to next line, as there is no need to check the rest
    // of the proxy types.
    fileStream.on('line', (line) => {
      lineNumber++
      for (const proxyTypeName of Object.keys(proxyTypes)) {
        const allowedPattern = new RegExp(`allowed proxy calls for ${proxyTypeName} `)
        const forbiddenPattern = new RegExp(`forbidden proxy calls for ${proxyTypeName} `)

        let msg: string
        if (allowedPattern.test(line)) {
          msg = `${proxyTypeName} allowed tests:`
          msg = msg.padEnd(PAD_LENGTH, ' ')
          proxyTestResults[proxyTypeName]['allowed'] = `${msg} ✅ (line ${lineNumber})`
          break
        }

        if (forbiddenPattern.test(line)) {
          msg = `${proxyTypeName} forbidden tests:`
          msg = msg.padEnd(PAD_LENGTH, ' ')
          proxyTestResults[proxyTypeName]['forbidden'] = `${msg} ✅ (line ${lineNumber})`
          break
        }
      }
    })

    fileStream.on('close', () => {
      resolve(proxyTestResults)
    })
  })
}

/**
 * Recursively find all proxy E2E test snapshot files in the given directory.
 *
 * @param dir The directory to search for snapshot files.
 * @returns A list of paths to all proxy E2E test snapshot files.
 */
function findProxyTestSnapshots(dir: string): string[] {
  const files: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findProxyTestSnapshots(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('proxy.e2e.test.ts.snap')) {
      files.push(fullPath)
    }
  }

  return files
}

async function main() {
  // This script is run from `./scripts`, so going up once leads to the root directory.
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const snapshotFiles = findProxyTestSnapshots(rootDir)

  console.log('Proxy Type Test Coverage Checker')
  console.log('===============================')

  for (const network of networks) {
    const networkSnapshotFilename = snapshotFiles.find((file) => file.split('/').pop()?.startsWith(network.name))
    if (!networkSnapshotFilename) {
      console.log(`No snapshots found for ${network.name}`)
      continue
    }

    const searchResults = await findProxyFilteringTests(network, networkSnapshotFilename)

    console.log(`\nProxy call filtering test coverage for network: ${network.name}`)
    console.log(`Snapshot filepath: ${getNetworkBackgroundColor(network.name)}${networkSnapshotFilename}\x1b[0m`)
    for (const [_, msgPerTestType] of Object.entries(searchResults)) {
      for (const [_, searchResult] of Object.entries(msgPerTestType)) {
        console.log(searchResult)
      }
    }
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0))
