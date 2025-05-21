import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

function checkProxyTypeTests(network: NetworkProxyTypes, snapshotFile: string): void {
  console.log(`\nChecking ${network.name} proxy type test coverage:`)

  const proxyTypes = network.proxyTypes
  const missingTests: string[] = []

  const proxyTypesToCheck = Object.keys(proxyTypes)

  for (const proxyTypeName of proxyTypesToCheck) {
    const allowed = readFileSync(snapshotFile, 'utf-8').includes(`allowed proxy calls for ${proxyTypeName}`)
    const forbidden =
      proxyTypeName === 'Any'
        ? true
        : readFileSync(snapshotFile, 'utf-8').includes(`forbidden proxy calls for ${proxyTypeName}`)

    const padLength = 35
    let msg: string
    msg = `${proxyTypeName} allowed tests:`
    msg = msg.padEnd(padLength, ' ')
    if (!allowed) {
      missingTests.push(`${msg} ❌`)
    } else {
      missingTests.push(`${msg} ✅`)
    }
    msg = `${proxyTypeName} forbidden tests:`
    msg = msg.padEnd(padLength, ' ')
    if (!forbidden) {
      missingTests.push(`${msg} ❌`)
    } else {
      missingTests.push(`${msg} ✅`)
    }
  }

  for (const test of missingTests) {
    console.log(test)
  }
}

function main() {
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const snapshotFiles = findProxyTestSnapshots(rootDir)
  console.log(snapshotFiles)

  console.log('Proxy Type Test Coverage Checker')
  console.log('===============================')

  for (const network of networks) {
    // Filter snapshots for this network
    const networkSnapshot = snapshotFiles.find((file) => file.split('/').pop()?.startsWith(network.name))
    if (!networkSnapshot) {
      console.log(`No snapshots found for ${network.name}`)
      continue
    }

    console.log(networkSnapshot)

    checkProxyTypeTests(network, networkSnapshot!)
  }
}

main()
