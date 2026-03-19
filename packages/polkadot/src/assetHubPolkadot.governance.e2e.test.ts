import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, type GovernanceTestConfig, registerTestTree } from '@e2e-test/shared'

const governanceConfig: GovernanceTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Governance',
  tracks: [{ trackId: 1, trackName: 'small_tipper', originName: 'SmallTipper' }],
}

registerTestTree(baseGovernanceE2ETests(assetHubPolkadot, governanceConfig))
