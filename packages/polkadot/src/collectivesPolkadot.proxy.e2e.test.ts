import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { CollectivesProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Collectives Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(collectivesPolkadot, testConfig, CollectivesProxyTypes))
