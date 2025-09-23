import { polkadot } from '@e2e-test/networks/chains'
import { fullProxyE2ETests, PolkadotProxyTypes, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(fullProxyE2ETests(polkadot, testConfig, PolkadotProxyTypes))
