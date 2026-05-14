import { assetHubWestend } from '@e2e-test/networks/chains'
import { type PsmTestConfig, psmE2ETests, registerTestTree } from '@e2e-test/shared'

const testCfg: PsmTestConfig = {
  testSuiteName: 'Westend Asset Hub PSM',
  psmStableAssetId: 50000342,
  psmInsuranceFundAccountRaw: '0x6d6f646c707573642f696e730000000000000000000000000000000000000000',
}

registerTestTree(psmE2ETests(assetHubWestend, testCfg))
