import { coretimePolkadot } from '@e2e-test/networks/chains'
import { CoretimeProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Coretime Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(coretimePolkadot, testConfig, CoretimeProxyTypes))
