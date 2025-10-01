import { kusama } from '@e2e-test/networks/chains'
import {
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  KusamaProxyTypes,
  type ProxyTypeConfig,
  type RelayTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Proxy',
  addressEncoding: 2,
  blockProvider: 'Local',
}

const kusamaProxyTypeConfig: ProxyTypeConfig = {
  ...defaultProxyTypeConfig,
  [KusamaProxyTypes.ParaRegistration]: {
    buildAllowedActions: (builder) => [
      ...builder.buildParasRegistrarAction(),
      ...builder.buildUtilityAction(),
      ...builder.buildProxyRemoveProxyAction(KusamaProxyTypes.ParaRegistration),
    ],
    buildDisallowedActions: (builder) => [...defaultProxyTypeConfig.ParaRegistration.buildDisallowedActions(builder)],
  },
}

registerTestTree(fullProxyE2ETests(kusama, testConfig, KusamaProxyTypes, kusamaProxyTypeConfig))
