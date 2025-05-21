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
  { name: 'Polkadot', proxyTypes: PolkadotProxyTypes },
  { name: 'Kusama', proxyTypes: KusamaProxyTypes },
  { name: 'AssetHubPolkadot', proxyTypes: AssetHubProxyTypes },
  { name: 'AssetHubKusama', proxyTypes: AssetHubProxyTypes },
  { name: 'CollectivesPolkadot', proxyTypes: CollectivesProxyTypes },
  { name: 'CoretimePolkadot', proxyTypes: CoretimeProxyTypes },
  { name: 'CoretimeKusama', proxyTypes: CoretimeProxyTypes },
  { name: 'PeoplePolkadot', proxyTypes: PeopleProxyTypes },
  { name: 'PeopleKusama', proxyTypes: PeopleProxyTypes },
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

function checkProxyTypeTests(network: NetworkProxyTypes, snapshotFiles: string[]): void {
  console.log(`\nChecking ${network.name} proxy type test coverage:`)

  const proxyTypes = network.proxyTypes
  const missingTests: string[] = []

  const proxyTypesToCheck = Object.keys(proxyTypes)

  // Filter snapshots for this network
  const networkSnapshots = snapshotFiles.filter((file) => file.includes(network.name))

  for (const proxyTypeName of proxyTypesToCheck) {
    const allowed = networkSnapshots.some((file) =>
      readFileSync(file, 'utf-8').includes(`allowed proxy calls for ${proxyTypeName}`),
    )
    const forbidden = networkSnapshots.some((file) =>
      readFileSync(file, 'utf-8').includes(`forbidden proxy calls for ${proxyTypeName}`),
    )

    if (!allowed) missingTests.push(`${proxyTypeName} (allowed tests missing)`)
    if (!forbidden) missingTests.push(`${proxyTypeName} (forbidden tests missing)`)
  }

  if (missingTests.length === 0) {
    console.log('✅ All proxy types have both allowed and forbidden test coverage')
  } else {
    console.log('❌ Missing test coverage for:')
    missingTests.forEach((test) => console.log(`  - ${test}`))
  }
}

function main() {
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const snapshotFiles = findProxyTestSnapshots(rootDir)
  console.log(snapshotFiles)

  console.log('Proxy Type Test Coverage Checker')
  console.log('===============================')

  for (const network of networks) {
    checkProxyTypeTests(network, snapshotFiles)
  }
}

main()
