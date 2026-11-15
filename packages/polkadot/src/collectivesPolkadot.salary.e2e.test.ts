import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { baseSalaryE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Collectives Salary',
}

registerTestTree(baseSalaryE2ETests(collectivesPolkadot, assetHubPolkadot, testConfig))
