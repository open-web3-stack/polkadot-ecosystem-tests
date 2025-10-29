import { kusama } from '@e2e-test/networks/chains'
import {
  createProxyConfig,
  defaultProxyTypeConfig,
  fullProxyE2ETests,
  KusamaProxyTypes,
  type ProxyTestConfig,
  type ProxyTypeConfig,
  type RelayTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Proxy',
  addressEncoding: 2,
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
const kusamaProxyTypeConfig: ProxyTypeConfig = {
  ...defaultProxyTypeConfig,
  ['Any']: {
    buildAllowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildMultisigAction(),
      ...builder.buildProxyAction(),
      ...builder.buildProxyRejectAnnouncementAction(),
      ...builder.buildProxyRemovalAction(KusamaProxyTypes.Any),
      ...builder.buildSystemAction(),
      ...builder.buildUtilityAction(),
    ],
    buildDisallowedActions: (builder) => [
      ...builder.buildAuctionAction(),
      ...builder.buildBountyAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildNominationPoolsAction(),
      ...builder.buildStakingAction(),
      ...builder.buildVestingAction(),
    ],
  },
  ['NonTransfer']: {
    buildAllowedActions: (builder) => [
      ...builder.buildProxyAction(),
      ...builder.buildMultisigAction(),
      ...builder.buildSystemRemarkAction(),
      ...builder.buildUtilityAction(),
    ],
    buildDisallowedActions: (builder) => [
      ...builder.buildAuctionAction(),
      ...builder.buildBalancesAction(),
      ...builder.buildBountyAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildNominationPoolsAction(),
      ...builder.buildStakingAction(),
      ...builder.buildVestingAction(),
    ],
  },

  ['Auction']: {
    buildAllowedActions: (builder) => [...builder.buildCrowdloanAction(), ...builder.buildParasRegistrarAction()],
    buildDisallowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildVestingAction(),

      // TODO: this is not right, see https://github.com/polkadot-fellows/runtimes/blob/main/relay/kusama/src/lib.rs#L1391
      // Needs an issue
      ...builder.buildAuctionAction(),
      ...builder.buildSlotsAction(),
    ],
  },

  ['Governance']: {
    buildAllowedActions: (builder) => [...builder.buildUtilityAction()],
    buildDisallowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildBountyAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildMultisigAction(),
      ...builder.buildProxyAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemAction(),
      ...builder.buildVestingAction(),
    ],
  },

  ['Staking']: {
    buildAllowedActions: (builder) => [...builder.buildUtilityAction()],
    buildDisallowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildFastUnstakeAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildNominationPoolsAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemAction(),
      ...builder.buildVestingAction(),
    ],
  },

  ['NominationPools']: {
    buildAllowedActions: (builder) => [...builder.buildUtilityAction()],
    buildDisallowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildGovernanceAction(),
      ...builder.buildNominationPoolsAction(),
      ...builder.buildStakingAction(),
      ...builder.buildSystemAction(),
      ...builder.buildVestingAction(),
    ],
  },
  ['Society']: {
    buildAllowedActions: (_builder) => [],
    buildDisallowedActions: (builder) => [
      ...builder.buildBalancesAction(),
      ...builder.buildSocietyAction(),
      ...builder.buildSystemAction(),
      ...builder.buildUtilityAction(),
    ],
  },
  ['ParaRegistration']: {
    buildAllowedActions: (builder) => [
      ...builder.buildParasRegistrarAction(),
      ...builder.buildUtilityAction(),
      ...builder.buildProxyRemovalAction(KusamaProxyTypes.ParaRegistration),
    ],
    buildDisallowedActions: (builder) => [...defaultProxyTypeConfig.ParaRegistration.buildDisallowedActions(builder)],
  },
}

const kusamaProxyCfg: ProxyTestConfig = createProxyConfig(KusamaProxyTypes, kusamaProxyTypeConfig)

registerTestTree(fullProxyE2ETests(kusama, testConfig, kusamaProxyCfg))
