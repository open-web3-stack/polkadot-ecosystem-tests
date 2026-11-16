import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  ambassadorSalaryInstance,
  registerTestTree,
  type SalaryInstanceTestConfig,
  salaryInstanceE2ETests,
} from '@e2e-test/shared'

const testConfig: SalaryInstanceTestConfig = {
  testSuiteName: 'Polkadot Collectives Ambassador Salary',
  // `AmbassadorSalary` pays `AmbassadorCollective` members in USDT from its own sovereign account on Asset Hub.
  instance: ambassadorSalaryInstance,
}

registerTestTree(salaryInstanceE2ETests(collectivesPolkadot, assetHubPolkadot, testConfig))
