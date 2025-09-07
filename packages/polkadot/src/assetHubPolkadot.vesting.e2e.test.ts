import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { assetHubVestingE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Vesting',
  addressEncoding: 0,
  relayOrPara: 'Para',
  asyncBacking: 'Enabled',
}

registerTestTree(assetHubVestingE2ETests(assetHubPolkadot, testConfig))
