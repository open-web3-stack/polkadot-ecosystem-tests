import { polkadot } from '@e2e-test/networks/chains'
import {
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  PolkadotProxyTypes,
  type ProxyTypeConfig,
  type RelayTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Proxy',
  addressEncoding: 0,
  blockProvider: 'Local',
}

const polkadotProxyTypeConfig: ProxyTypeConfig = {
  ...defaultProxyTypeConfig,
  [PolkadotProxyTypes.ParaRegistration]: {
    buildAllowedActions: (builder) => [
      ...builder.buildParasRegistrarAction(),
      ...builder.buildUtilityAction(),
      ...builder.buildProxyRemoveProxyAction(PolkadotProxyTypes.ParaRegistration),
    ],
    buildDisallowedActions: (builder) => [...defaultProxyTypeConfig.ParaRegistration.buildDisallowedActions(builder)],
  },
}

registerTestTree(fullProxyE2ETests(polkadot, testConfig, PolkadotProxyTypes, polkadotProxyTypeConfig))
