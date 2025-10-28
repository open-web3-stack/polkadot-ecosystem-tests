import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { baseTreasuryE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Treasury',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseTreasuryE2ETests(polkadot, assetHubPolkadot, testConfig))
