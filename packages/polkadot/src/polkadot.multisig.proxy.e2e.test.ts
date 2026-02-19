import { polkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, PolkadotProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Multisig with Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(polkadot, testConfig, PolkadotProxyTypes))
