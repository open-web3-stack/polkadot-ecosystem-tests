import { assetHubKusama } from '@e2e-test/networks/chains'
import {
  AssetHubKusamaProxyTypes,
  createProxyConfig,
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  type ParaTestConfig,
  type ProxyTestConfig,
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
  // The `Auction` proxy type cannot execute any calls on the AH without the `remote_proxy` pallet.
  // Its call filter is set to block all calls.
  ['Auction']: {
    buildAllowedActions: (_builder) => [],
    buildDisallowedActions: (builder) => [
      ...builder.buildAuctionAction(),
      ...builder.buildBalancesAction(),
      ...builder.buildCrowdloanAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildSlotsAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemAction(),
      ...builder.buildVestingAction(),
    ],
  },
  ['ParaRegistration']: {
    buildAllowedActions: (_builder) => [],
    // The `ParaRegistration` proxy type cannot execute any calls on the AH without the `remote_proxy` pallet.
    // Its call filter is set to block all calls.
    buildDisallowedActions: (builder) => [
      ...defaultProxyTypeConfig.ParaRegistration.buildDisallowedActions(builder),
      // Post-AHM won't have the `paras_registrar` pallet, so the below action will result in an empty list.
      ...builder.buildParasRegistrarAction(),
      ...builder.buildUtilityAction(),
      ...builder.buildProxyRemovalAction(AssetHubKusamaProxyTypes.ParaRegistration),
    ],
  },
}

const assetHubKusamaProxyCfg: ProxyTestConfig = createProxyConfig(
  AssetHubKusamaProxyTypes,
  assetHubKusamaProxyTypeConfig,
)

registerTestTree(fullProxyE2ETests(assetHubKusama, testConfig, assetHubKusamaProxyCfg))
