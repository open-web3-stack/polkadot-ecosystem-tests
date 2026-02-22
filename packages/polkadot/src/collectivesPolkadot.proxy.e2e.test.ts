import { collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  CollectivesProxyTypes,
  createProxyConfig,
  fullProxyE2ETests,
  type ProxyTestConfig,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Collectives Proxy',
}

const collectivesPolkadotProxyCfg: ProxyTestConfig = createProxyConfig(CollectivesProxyTypes)

registerTestTree(fullProxyE2ETests(collectivesPolkadot, testConfig, collectivesPolkadotProxyCfg))
