import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  AssetHubPolkadotProxyTypes,
  createProxyConfig,
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
  type ProxyTypeConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub Proxy',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

const assetHubPolkadotProxyTypeConfig: ProxyTypeConfig = {
  ...defaultProxyTypeConfig,
  ['Any']: {
    buildAllowedActions: (builder) => [
      ...builder.buildAuctionAction(),
      ...builder.buildBalancesAction(),
      ...builder.buildBountyAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildMultisigAction(),
      ...builder.buildNominationPoolsAction(),
      ...builder.buildProxyAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemRemarkAction(),
      ...builder.buildUtilityAction(),
      // Pending AHM, vesting is disabled on asset hubs, so `Any` proxy types will be unable to
      //...builder.buildVestingAction(),
    ],
    buildDisallowedActions: (builder) => [...builder.buildVestingAction()],
  },
}

const assetHubPolkadotProxyCfg: ProxyTestConfig = createProxyConfig(
  AssetHubPolkadotProxyTypes,
  assetHubPolkadotProxyTypeConfig,
)

registerTestTree(fullProxyE2ETests(assetHubPolkadot, testConfig, assetHubPolkadotProxyCfg))
