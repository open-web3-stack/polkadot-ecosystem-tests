import { collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  CollectivesProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Collectives Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

const collectivesPolkadotProxyCfg: ProxyTestConfig = createProxyConfig(CollectivesProxyTypes)

registerTestTree(fullProxyE2ETests(collectivesPolkadot, testConfig, collectivesPolkadotProxyCfg))
