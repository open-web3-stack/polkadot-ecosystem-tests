import { karura } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Karura Preimage',
}

registerTestTree(basePreimageE2ETests(karura, testConfig))
