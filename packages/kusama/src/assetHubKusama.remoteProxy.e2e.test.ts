import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, remoteProxyE2ETests, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama AssetHub',
}

registerTestTree(remoteProxyE2ETests(assetHubKusama, testConfig, 'remoteProxyRelayChain'))
