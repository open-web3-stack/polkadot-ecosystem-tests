import { coretimePolkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, CoretimeProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Coretime Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(coretimePolkadot, testConfig, CoretimeProxyTypes))
