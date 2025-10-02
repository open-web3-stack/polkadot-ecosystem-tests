import { assetHubKusama } from '@e2e-test/networks/chains'
import {
  AssetHubProxyTypes,
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTypeConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama AssetHub Proxy',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

const assetHubKusamaProxyTypeConfig: ProxyTypeConfig = {
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

registerTestTree(fullProxyE2ETests(assetHubKusama, testConfig, AssetHubProxyTypes, assetHubKusamaProxyTypeConfig))
