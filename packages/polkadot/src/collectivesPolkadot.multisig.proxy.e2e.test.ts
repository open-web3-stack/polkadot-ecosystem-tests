import { collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  baseMultisigProxyE2Etests,
  CollectivesProxyTypes,
  type ParaTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Collectives Multisig Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultisigProxyE2Etests(collectivesPolkadot, testConfig, CollectivesProxyTypes))
