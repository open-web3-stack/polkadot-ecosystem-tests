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
  setupNetworksForAssetHub,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub Proxy',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
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
      ...builder.buildVestingAction(),
    ],
    buildDisallowedActions: (_builder) => [],
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
      ...builder.buildProxyRemovalAction(AssetHubPolkadotProxyTypes.ParaRegistration),
    ],
  },
}

const assetHubPolkadotProxyCfg: ProxyTestConfig = createProxyConfig(
  AssetHubPolkadotProxyTypes,
  assetHubPolkadotProxyTypeConfig,
)

registerTestTree(fullProxyE2ETests(assetHubPolkadot, testConfig, assetHubPolkadotProxyCfg))
