import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { baseMultisigProxyE2Etests, CollectivesProxyTypes, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Collectives Multisig Proxy',
}

registerTestTree(baseMultisigProxyE2Etests(collectivesPolkadot, testConfig, CollectivesProxyTypes))
