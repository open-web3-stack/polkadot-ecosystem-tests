import { assetHubKusama } from '@e2e-test/networks/chains'
import { convictionVotingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Conviction Voting',
}

registerTestTree(convictionVotingE2ETests(assetHubKusama, testConfig))
