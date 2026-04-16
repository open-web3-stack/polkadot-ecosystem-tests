import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type PsmTestConfig, psmE2ETests, registerTestTree } from '@e2e-test/shared'

const testCfg: PsmTestConfig = {
  testSuiteName: 'Polkadot Asset Hub PSM',
  psmStableAssetId: 4242,
  psmInsuranceFundAccountRaw: '0x6d6f646c70792f706567736d0000000000000000000000000000000000000000',
}

registerTestTree(psmE2ETests(assetHubPolkadot, testCfg))
