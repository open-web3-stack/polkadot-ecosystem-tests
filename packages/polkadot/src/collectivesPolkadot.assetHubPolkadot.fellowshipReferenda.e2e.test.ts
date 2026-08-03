import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { fellowshipReferendaE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Fellowship referenda',
}

registerTestTree(fellowshipReferendaE2ETests(assetHubPolkadot, collectivesPolkadot, testConfig))
