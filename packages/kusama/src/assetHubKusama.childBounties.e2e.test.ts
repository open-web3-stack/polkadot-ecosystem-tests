import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, type ChildBountiesTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ChildBountiesTestConfig = {
  testSuiteName: 'Kusama Asset Hub Child Bounties',
  // Asset Hub Kusama routes slashed bounty curator deposits to the treasury pot (`OnSlash = Treasury`).
  curatorSlashSink: 'treasury',
}

registerTestTree(baseChildBountiesE2ETests(assetHubKusama, testConfig))
