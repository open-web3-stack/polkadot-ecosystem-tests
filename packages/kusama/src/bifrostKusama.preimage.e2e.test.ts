import { bifrostKusama } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Bifrost Kusama Preimage',
}

registerTestTree(basePreimageE2ETests(bifrostKusama, testConfig))
