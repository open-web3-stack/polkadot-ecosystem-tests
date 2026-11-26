import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  registerTestTree,
  type SalaryInstanceTestConfig,
  salaryInstanceE2ETests,
  secretarySalaryInstance,
} from '@e2e-test/shared'

const testConfig: SalaryInstanceTestConfig = {
  testSuiteName: 'Polkadot Collectives Secretary Salary',
  // `SecretarySalary` pays `SecretaryCollective` members from the Fellowship salary sovereign account on Asset Hub.
  instance: secretarySalaryInstance,
}

registerTestTree(salaryInstanceE2ETests(collectivesPolkadot, assetHubPolkadot, testConfig))
