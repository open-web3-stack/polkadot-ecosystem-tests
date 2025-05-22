import { createReadStream, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  AssetHubProxyTypes,
  CollectivesProxyTypes,
  CoretimeProxyTypes,
  KusamaProxyTypes,
  PeopleProxyTypes,
  PolkadotProxyTypes,
} from '../packages/shared/src/helpers/proxyTypes.js'

type ProxyTypeMap = Record<string, number>

interface NetworkProxyTypes {
  name: string
  proxyTypes: ProxyTypeMap
}

const padLength = 40
type ProxyTestResult = Record<string, Record<'allowed' | 'forbidden', string>>

const networks: NetworkProxyTypes[] = [
  { name: 'polkadot', proxyTypes: PolkadotProxyTypes },
  { name: 'kusama', proxyTypes: KusamaProxyTypes },
  { name: 'assetHubPolkadot', proxyTypes: AssetHubProxyTypes },
  { name: 'assetHubKusama', proxyTypes: AssetHubProxyTypes },
  { name: 'collectivesPolkadot', proxyTypes: CollectivesProxyTypes },
  { name: 'coretimePolkadot', proxyTypes: CoretimeProxyTypes },
  { name: 'coretimeKusama', proxyTypes: CoretimeProxyTypes },
  { name: 'peoplePolkadot', proxyTypes: PeopleProxyTypes },
  { name: 'peopleKusama', proxyTypes: PeopleProxyTypes },
]

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

function checkProxyTypeTests(network: NetworkProxyTypes, networkSnapshotFilename: string): ProxyTestResult {
  console.log(`\nChecking ${network.name} proxy type test coverage:`)

  const proxyTypes = network.proxyTypes
  const proxyTestResults: ProxyTestResult = {}

  Object.keys(proxyTypes).forEach((proxyTypeName) => {
    proxyTestResults[proxyTypeName] = { allowed: '', forbidden: '' }
    for (const testType of ['allowed', 'forbidden']) {
      const msg = `${proxyTypeName} ${testType} tests:`.padEnd(padLength, ' ')
      proxyTestResults[proxyTypeName][testType] = `${msg} ❌ (not found)`
    }
  })

  const fileStream = readline.createInterface({
    input: createReadStream(networkSnapshotFilename),
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  let lineNumber = 0

  fileStream.on('line', (line) => {
    lineNumber++
    for (const proxyTypeName of Object.keys(proxyTypes)) {
      const allowedPattern = new RegExp(`allowed proxy calls for ${proxyTypeName}`)
      const forbiddenPattern = new RegExp(`forbidden proxy calls for ${proxyTypeName}`)

      let msg: string
      if (allowedPattern.test(line)) {
        msg = `${proxyTypeName} allowed tests:`
        msg = msg.padEnd(padLength, ' ')
        proxyTestResults[proxyTypeName]['allowed'] = `${msg} ✅ (line ${lineNumber})`
      }

      if (forbiddenPattern.test(line)) {
        if (proxyTypeName !== 'Any') {
          msg = `${proxyTypeName} forbidden tests:`
          msg = msg.padEnd(padLength, ' ')
          proxyTestResults[proxyTypeName]['forbidden'] = `${msg} ✅ (line ${lineNumber})`
        }
      }
    }
  })

  fileStream.on('end', () => {})

  return proxyTestResults
}

function main() {
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const snapshotFiles = findProxyTestSnapshots(rootDir)
  console.log(snapshotFiles)

  console.log('Proxy Type Test Coverage Checker')
  console.log('===============================')

  for (const network of networks) {
    // Filter snapshots for this network
    const networkSnapshotFilename = snapshotFiles.find((file) => file.split('/').pop()?.startsWith(network.name))
    if (!networkSnapshotFilename) {
      console.log(`No snapshots found for ${network.name}`)
      continue
    }

    console.log(networkSnapshotFilename)

    const proxyTestResults = checkProxyTypeTests(network, networkSnapshotFilename!)

    for (const [_, v] of Object.entries(proxyTestResults)) {
      for (const [_, j] of Object.entries(v)) {
        console.log(j)
      }
    }
  }
}

main()
