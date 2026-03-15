import { kusama } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Preimage',
}

registerTestTree(basePreimageE2ETests(kusama, testConfig))
