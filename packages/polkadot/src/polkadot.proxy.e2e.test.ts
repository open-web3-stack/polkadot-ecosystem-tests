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

/**
 * When removing a proxy account, the calling account's proxy type needs to be at least as powerful as the
 * proxy type of the account being removed.
 *
 * The lattice that relay chain proxy types form is such that
 * 1. `Any` is the maximum
 * 2. `NonTransfer` is, barring `Any`, the supremum (least upper bound)of all other types
 * 3. there is no infimum between the remaining types
 *
 * Therefore, to test proxy removal with a `ParaRegistration` proxy type, the proxy type to be removed
 * must be `ParaRegistration`.
 *
 * Thus, relaychains' proxy E2E tests need to provide a custom `ParaRegistration` proxy type config
 * that specifies the type being passed to the proxy removal action builder.
 */
const polkadotProxyTypeConfig: ProxyTypeConfig = {
  ...defaultProxyTypeConfig,
  ['ParaRegistration']: {
    buildAllowedActions: (builder) => [
      ...builder.buildParasRegistrarAction(),
      ...builder.buildUtilityAction(),
      ...builder.buildProxyRemoveProxyAction(PolkadotProxyTypes.ParaRegistration),
    ],
    buildDisallowedActions: (builder) => [...defaultProxyTypeConfig.ParaRegistration.buildDisallowedActions(builder)],
  },
}

registerTestTree(fullProxyE2ETests(polkadot, testConfig, PolkadotProxyTypes, polkadotProxyTypeConfig))
