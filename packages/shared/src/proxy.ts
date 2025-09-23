import { type Checker, sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import {
  type Client,
  type DescribeNode,
  KusamaProxyTypes,
  PolkadotProxyTypes,
  type RootTestTree,
  setupNetworks,
  type TestNode,
} from '@e2e-test/shared'

import type { Keyring } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { Vec } from '@polkadot/types'
import type { PalletProxyProxyDefinition } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import BN from 'bn.js'
import { match } from 'ts-pattern'
import { check, checkEvents, getBlockNumber, schedulerOffset, type TestConfig } from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Delay parameter for proxy tests.
 */
const PROXY_DELAY = 5

/**
 * Given a keyring and a network's proxy types, create a keypair for each proxy type.
 *
 * @returns A record of proxy type names to their corresponding keypairs. The proxy type names that key the return
 *          object will be derived from the fields in the `proxyTypes` argument.
 */
function createProxyAccounts(
  accountName: string,
  kr: Keyring,
  proxyTypes: Record<string, number>,
): Record<string, KeyringPair> {
  return Object.fromEntries(
    Object.entries(proxyTypes).map(([proxyType, _]) => [proxyType, kr.addFromUri(`${accountName} proxy ${proxyType}`)]),
  )
}

/**
 * Shorthand for a list of PJS-type fully-formed extrinsics.
 *
 * The pallet and extrinsic names are used to better identify the corresponding snapshot.
 */
interface ProxyAction {
  pallet: string
  extrinsic: string
  call: SubmittableExtrinsic<'promise', ISubmittableResult>
}

/**
 * A builder for proxy action lists.
 *
 * Each builder method returns a list of actions from a certain pallet that should/should not bevalid for a given proxy
 * type.
 * Returning lists allows for:
 * 1. no-ops in the form of empty lists, and
 * 2. providing multiple extrinsics of interest per pallet
 *
 * The test for each proxy type is then free to combine these lists as required.
 */
interface ProxyActionBuilder {
  buildAllianceAction(): ProxyAction[]
  buildAllianceMotionAction(): ProxyAction[]
  // The `Asset, `AssetOwner` and `AssetManager` proxy types rely on the same pallets, but different call filters.
  // They are differentiated here to clarify which all types can make, and which only some can.
  // The same applies to `Uniques` and `Nfts`
  buildAmbassadorCollectiveAction(): ProxyAction[]
  buildAmbassadorCoreAction(): ProxyAction[]
  buildAmbassadorReferendaAction(): ProxyAction[]
  buildAmbassadorSalaryAction(): ProxyAction[]
  buildAssetsAction(): ProxyAction[]
  buildAssetsManagerAction(): ProxyAction[]
  buildAssetsOwnerAction(): ProxyAction[]
  buildAuctionAction(): ProxyAction[]

  buildBalancesAction(): ProxyAction[]
  buildBountyAction(): ProxyAction[]
  buildBrokerAction(): ProxyAction[]
  buildBrokerPurchaseCreditAction(): ProxyAction[]
  buildBrokerRenewerAction(): ProxyAction[]

  buildCollatorSelectionAction(): ProxyAction[]
  buildCrowdloanAction(): ProxyAction[]

  buildFastUnstakeAction(): ProxyAction[]
  buildFellowshipCollectiveAction(): ProxyAction[]
  buildFellowshipCoreAction(): ProxyAction[]
  buildFellowshipReferendaAction(): ProxyAction[]
  buildFellowshipSalaryAction(): ProxyAction[]

  buildGovernanceAction(): ProxyAction[]

  buildIdentityAction(): ProxyAction[]
  buildIdentityJudgementAction(): ProxyAction[]
  buildIdentityNonJudgementAction(): ProxyAction[]

  buildMultisigAction(): ProxyAction[]

  buildNftsAction(): ProxyAction[]
  buildNftsManagerAction(): ProxyAction[]
  buildNftsOwnerAction(): ProxyAction[]
  buildNominationPoolsAction(): ProxyAction[]

  buildParasRegistrarAction(): ProxyAction[]
  buildProxyAction(): ProxyAction[]
  buildProxyRejectAnnouncementAction(): ProxyAction[]
  buildProxyRemoveProxyAction(proxyType?: number): ProxyAction[]

  buildSlotsAction(): ProxyAction[]
  buildSocietyAction(): ProxyAction[]
  buildStakingAction(): ProxyAction[]
  buildSystemAction(): ProxyAction[]
  buildSystemNonRemarkAction(): ProxyAction[]
  buildSystemRemarkAction(): ProxyAction[]

  buildVestingAction(): ProxyAction[]

  buildUniquesAction(): ProxyAction[]
  buildUniquesManagerAction(): ProxyAction[]
  buildUniquesOwnerAction(): ProxyAction[]
  buildUtilityAction(): ProxyAction[]
}

class ProxyActionBuilderImpl<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
> implements ProxyActionBuilder
{
  constructor(private client: Client<TCustom, TInitStorages>) {}

  buildAllianceAction(): ProxyAction[] {
    const allianceCalls: ProxyAction[] = []
    if (this.client.api.tx.alliance) {
      allianceCalls.push({
        pallet: 'alliance',
        extrinsic: 'join_alliance',
        call: this.client.api.tx.alliance.joinAlliance(),
      })
    }

    return allianceCalls
  }

  buildAllianceMotionAction(): ProxyAction[] {
    const allianceMotionCalls: ProxyAction[] = []
    if (this.client.api.tx.allianceMotion) {
      const proposal = this.client.api.tx.system.remark('hello')

      allianceMotionCalls.push({
        pallet: 'collectives',
        extrinsic: 'propose',
        call: this.client.api.tx.allianceMotion.propose(1, proposal.method.toHex(), proposal.method.toHex().length),
      })
    }

    return allianceMotionCalls
  }

  buildAmbassadorCollectiveAction(): ProxyAction[] {
    const ambassadorCollectiveCalls: ProxyAction[] = []
    if (this.client.api.tx.ambassadorCollective) {
      ambassadorCollectiveCalls.push({
        pallet: 'ranked_collective',
        extrinsic: 'vote',
        call: this.client.api.tx.ambassadorCollective.vote(1, true),
      })
    }

    return ambassadorCollectiveCalls
  }

  buildAmbassadorCoreAction(): ProxyAction[] {
    const ambassadorCoreCalls: ProxyAction[] = []
    if (this.client.api.tx.ambassadorCore) {
      ambassadorCoreCalls.push({
        pallet: 'core_fellowship',
        extrinsic: 'bump',
        call: this.client.api.tx.ambassadorCore.bump(testAccounts.eve.address),
      })
    }

    return ambassadorCoreCalls
  }

  buildAmbassadorReferendaAction(): ProxyAction[] {
    const ambassadorReferendaCalls: ProxyAction[] = []
    if (this.client.api.tx.ambassadorReferenda) {
      ambassadorReferendaCalls.push({
        pallet: 'referenda',
        extrinsic: 'place_decision_deposit',
        call: this.client.api.tx.ambassadorReferenda.placeDecisionDeposit(1),
      })
    }

    return ambassadorReferendaCalls
  }

  buildAmbassadorSalaryAction(): ProxyAction[] {
    const ambassadorSalaryCalls: ProxyAction[] = []
    if (this.client.api.tx.ambassadorSalary) {
      ambassadorSalaryCalls.push({
        pallet: 'salary',
        extrinsic: 'init',
        call: this.client.api.tx.ambassadorSalary.init(),
      })
    }

    return ambassadorSalaryCalls
  }

  buildAssetsAction(): ProxyAction[] {
    const assetsCalls: ProxyAction[] = []
    if (this.client.api.tx.assets) {
      assetsCalls.push(...this.buildAssetsManagerAction(), ...this.buildAssetsOwnerAction())
    }
    return assetsCalls
  }

  buildAssetsManagerAction(): ProxyAction[] {
    const assetsCalls: ProxyAction[] = []
    if (this.client.api.tx.assets) {
      assetsCalls.push({
        pallet: 'assets',
        extrinsic: 'mint',
        call: this.client.api.tx.assets.mint(1, testAccounts.eve.address, 1e10),
      })
    }
    return assetsCalls
  }

  buildAssetsOwnerAction(): ProxyAction[] {
    const assetsCalls: ProxyAction[] = []
    if (this.client.api.tx.assets) {
      assetsCalls.push({
        pallet: 'assets',
        extrinsic: 'create',
        call: this.client.api.tx.assets.create(1, testAccounts.eve.address, 1e10),
      })
    }
    return assetsCalls
  }

  buildAuctionAction(): ProxyAction[] {
    const auctionCalls: ProxyAction[] = []
    if (this.client.api.tx.auctions) {
      auctionCalls.push({
        pallet: 'auctions',
        extrinsic: 'bid',
        call: this.client.api.tx.auctions.bid(1000, 1, 1, 1, 100e10),
      })
    }

    return auctionCalls
  }

  buildBalancesAction(): ProxyAction[] {
    const balanceCalls: ProxyAction[] = []
    if (this.client.api.tx.balances) {
      balanceCalls.push({
        pallet: 'balances',
        extrinsic: 'burn',
        call: this.client.api.tx.balances.burn(1, false),
      })
    }

    return balanceCalls
  }

  buildBountyAction(): ProxyAction[] {
    const bountyCalls: ProxyAction[] = []
    if (this.client.api.tx.bounties) {
      bountyCalls.push({
        pallet: 'bounties',
        extrinsic: 'propose_bounty',
        call: this.client.api.tx.bounties.proposeBounty(100e10, 'Test Bounty'),
      })
    }

    return bountyCalls
  }

  buildBrokerAction(): ProxyAction[] {
    const brokerCalls: ProxyAction[] = [...this.buildBrokerRenewerAction()]
    if (this.client.api.tx.broker) {
      brokerCalls.push({
        pallet: 'broker',
        extrinsic: 'drop_history',
        call: this.client.api.tx.broker.dropHistory(0),
      })
    }

    return brokerCalls
  }

  buildBrokerPurchaseCreditAction(): ProxyAction[] {
    const brokerPurchaseCreditCalls: ProxyAction[] = []
    if (this.client.api.tx.broker) {
      brokerPurchaseCreditCalls.push({
        pallet: 'broker',
        extrinsic: 'purchase_credit',
        call: this.client.api.tx.broker.purchaseCredit(100e10, testAccounts.eve.address),
      })
    }

    return brokerPurchaseCreditCalls
  }

  buildBrokerRenewerAction(): ProxyAction[] {
    const brokerRenewerCalls: ProxyAction[] = []
    if (this.client.api.tx.broker) {
      // Coretime renewal can fail for different reasons at different times, and this can cause unstable snapshots.
      // To control which failure occurs, the global Coretime parachain's `Configuration` is set to `null`,
      // as this way the call to `renew` will predictably fail on the nonexistence of a configuration.
      this.client.dev.setStorage({
        Broker: {
          Configuration: null,
        },
      })

      brokerRenewerCalls.push({
        pallet: 'broker',
        extrinsic: 'renew',
        call: this.client.api.tx.broker.renew(1),
      })
    }

    return brokerRenewerCalls
  }

  buildCollatorSelectionAction(): ProxyAction[] {
    const collatorSelectionCalls: ProxyAction[] = []
    if (this.client.api.tx.collatorSelection) {
      collatorSelectionCalls.push({
        pallet: 'collator_selection',
        extrinsic: 'register_as_candidate',
        call: this.client.api.tx.collatorSelection.registerAsCandidate(),
      })
    }

    return collatorSelectionCalls
  }

  buildCrowdloanAction(): ProxyAction[] {
    const crowdloanCalls: ProxyAction[] = []
    if (this.client.api.tx.crowdloan) {
      crowdloanCalls.push({
        pallet: 'crowdloan',
        extrinsic: 'dissolve',
        call: this.client.api.tx.crowdloan.dissolve(1),
      })
    }

    return crowdloanCalls
  }

  buildFastUnstakeAction(): ProxyAction[] {
    const fastUnstakeCalls: ProxyAction[] = []
    if (this.client.api.tx.staking) {
      fastUnstakeCalls.push({
        pallet: 'staking',
        extrinsic: 'register_fast_unstake',
        call: this.client.api.tx.fastUnstake.registerFastUnstake(),
      })
    }

    return fastUnstakeCalls
  }

  buildFellowshipCollectiveAction(): ProxyAction[] {
    const fellowshipCollectiveCalls: ProxyAction[] = []
    if (this.client.api.tx.rankedCollective) {
      fellowshipCollectiveCalls.push({
        pallet: 'ranked_collective',
        extrinsic: 'vote',
        call: this.client.api.tx.rankedCollective.vote(1, true),
      })
    }

    return fellowshipCollectiveCalls
  }

  buildFellowshipCoreAction(): ProxyAction[] {
    const fellowshipCalls: ProxyAction[] = []
    if (this.client.api.tx.fellowshipCore) {
      fellowshipCalls.push({
        pallet: 'core_fellowship',
        extrinsic: 'bump',
        call: this.client.api.tx.fellowshipCore.bump(testAccounts.eve.address),
      })
    }

    return fellowshipCalls
  }

  buildFellowshipReferendaAction(): ProxyAction[] {
    const fellowshipReferendaCalls: ProxyAction[] = []
    if (this.client.api.tx.fellowshipReferenda) {
      fellowshipReferendaCalls.push({
        pallet: 'referenda',
        extrinsic: 'place_decision_deposit',
        call: this.client.api.tx.fellowshipReferenda.placeDecisionDeposit(1),
      })
    }

    return fellowshipReferendaCalls
  }

  buildFellowshipSalaryAction(): ProxyAction[] {
    const fellowshipSalaryCalls: ProxyAction[] = []
    if (this.client.api.tx.fellowshipSalary) {
      fellowshipSalaryCalls.push({
        pallet: 'salary',
        extrinsic: 'init',
        call: this.client.api.tx.fellowshipSalary.init(),
      })
    }

    return fellowshipSalaryCalls
  }

  buildGovernanceAction(): ProxyAction[] {
    const governanceCalls: ProxyAction[] = []
    if (this.client.api.tx.referenda) {
      governanceCalls.push({
        pallet: 'referenda',
        extrinsic: 'submit',
        call: this.client.api.tx.referenda.submit(
          {
            Origins: 'SmallTipper',
          } as any,
          {
            Inline: this.client.api.tx.system.remark('hello').method.toHex(),
          },
          {
            After: 0,
          },
        ),
      })
    }

    return governanceCalls
  }

  buildIdentityAction(): ProxyAction[] {
    return [...this.buildIdentityJudgementAction(), ...this.buildIdentityNonJudgementAction()]
  }

  buildIdentityJudgementAction(): ProxyAction[] {
    const identityJudgementCalls: ProxyAction[] = []
    if (this.client.api.tx.identity) {
      const hash = '0x0000000000000000000000000000000000000000000000000000000000000000'

      identityJudgementCalls.push({
        pallet: 'identity',
        extrinsic: 'provide_judgement',
        call: this.client.api.tx.identity.provideJudgement(0, testAccounts.eve.address, 'FeePaid', hash),
      })
    }

    return identityJudgementCalls
  }

  buildIdentityNonJudgementAction(): ProxyAction[] {
    const identityNonJudgementCalls: ProxyAction[] = []

    if (this.client.api.tx.identity) {
      identityNonJudgementCalls.push({
        pallet: 'identity',
        extrinsic: 'clear_identity',
        call: this.client.api.tx.identity.clearIdentity(),
      })
    }

    return identityNonJudgementCalls
  }

  buildMultisigAction(): ProxyAction[] {
    const testCall = this.client.api.tx.system.remark('hello').method.toHex()
    const multisigCalls: ProxyAction[] = []
    if (this.client.api.tx.multisig) {
      multisigCalls.push({
        pallet: 'multisig',
        extrinsic: 'as_multi',
        call: this.client.api.tx.multisig.asMulti(0, [], null, testCall, { refTime: 0, proofSize: 0 }),
      })
    }

    return multisigCalls
  }

  buildNftsAction(): ProxyAction[] {
    const nftsCalls: ProxyAction[] = []
    if (this.client.api.tx.nfts) {
      nftsCalls.push(...this.buildNftsManagerAction(), ...this.buildNftsOwnerAction())
    }
    return nftsCalls
  }

  buildNftsManagerAction(): ProxyAction[] {
    const nftsCalls: ProxyAction[] = []
    if (this.client.api.tx.nfts) {
      nftsCalls.push({
        pallet: 'nfts',
        extrinsic: 'set_metadata',
        call: this.client.api.tx.nfts.setMetadata(1, 1, 'test'),
      })
    }

    return nftsCalls
  }

  buildNftsOwnerAction(): ProxyAction[] {
    const nftsCalls: ProxyAction[] = []
    if (this.client.api.tx.nfts) {
      nftsCalls.push({
        pallet: 'nfts',
        extrinsic: 'destroy',
        call: this.client.api.tx.nfts.destroy(1, {
          item_metadatas: 1,
          item_configs: 1,
          attributes: 1,
        } as any),
      })
    }

    return nftsCalls
  }

  buildNominationPoolsAction(): ProxyAction[] {
    const nominationPoolsCalls: ProxyAction[] = []
    if (this.client.api.tx.nominationPools) {
      nominationPoolsCalls.push({
        pallet: 'nomination_pools',
        extrinsic: 'chill',
        call: this.client.api.tx.nominationPools.chill(1),
      })
    }

    return nominationPoolsCalls
  }

  buildParasRegistrarAction(): ProxyAction[] {
    const parasRegistrarCalls: ProxyAction[] = []
    if (this.client.api.tx.parasRegistrar) {
      parasRegistrarCalls.push(
        {
          pallet: 'paras_registrar',
          extrinsic: 'reserve',
          call: this.client.api.tx.parasRegistrar.reserve(),
        },
        {
          pallet: 'paras_registrar',
          extrinsic: 'register',
          call: this.client.api.tx.parasRegistrar.register(1000, 'genesis head', 'validation code'),
        },
      )
    }

    return parasRegistrarCalls
  }

  buildProxyAction(): ProxyAction[] {
    const proxyCalls: ProxyAction[] = []
    if (this.client.api.tx.proxy) {
      proxyCalls.push(
        ...this.buildProxyRejectAnnouncementAction(),
        // Can't include `add_proxy/remove_proxy` action, because the proxy type it will be called from may be a supertype of
        // the calling proxy type.
      )

      const hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
      proxyCalls.push({
        pallet: 'proxy',
        extrinsic: 'remove_announcement',
        call: this.client.api.tx.proxy.removeAnnouncement(testAccounts.eve.address, hash),
      })
    }

    return proxyCalls
  }

  buildProxyRejectAnnouncementAction(): ProxyAction[] {
    const cancelProxyCalls: ProxyAction[] = []
    if (this.client.api.tx.proxy) {
      const hash = '0x0000000000000000000000000000000000000000000000000000000000000000'

      cancelProxyCalls.push({
        pallet: 'proxy',
        extrinsic: 'reject_announcement',
        call: this.client.api.tx.proxy.rejectAnnouncement(testAccounts.eve.address, hash),
      })
    }

    return cancelProxyCalls
  }

  buildProxyRemoveProxyAction(proxyType?: number): ProxyAction[] {
    const proxyRemoveProxyCalls: ProxyAction[] = []
    if (this.client.api.tx.proxy) {
      proxyRemoveProxyCalls.push({
        pallet: 'proxy',
        extrinsic: 'remove_proxy',
        // Careful not to elicit unintended call filtering by using a proxy type that is a supertype of
        // of the calling proxy type.
        // With the available data at this point, it is not possible to foresee which proxy type is making the call.
        call: this.client.api.tx.proxy.removeProxy(testAccounts.eve.address, proxyType!, 0),
      })
    }

    return proxyRemoveProxyCalls
  }

  buildSlotsAction(): ProxyAction[] {
    const slotsCalls: ProxyAction[] = []
    if (this.client.api.tx.slots) {
      slotsCalls.push({
        pallet: 'slots',
        extrinsic: 'trigger_onboard',
        call: this.client.api.tx.slots.triggerOnboard(1000),
      })
    }

    return slotsCalls
  }

  buildSocietyAction(): ProxyAction[] {
    const societyCalls: ProxyAction[] = []
    if (this.client.api.tx.society) {
      societyCalls.push({
        pallet: 'society',
        extrinsic: 'bid',
        call: this.client.api.tx.society.bid(100e10),
      })
    }

    return societyCalls
  }

  buildStakingAction(): ProxyAction[] {
    const stakingCalls: ProxyAction[] = []
    if (this.client.api.tx.staking) {
      stakingCalls.push({
        pallet: 'staking',
        extrinsic: 'bond',
        call: this.client.api.tx.staking.bond(100e10, 'Staked'),
      })
    }

    return stakingCalls
  }

  buildSystemAction(): ProxyAction[] {
    return [...this.buildSystemNonRemarkAction(), ...this.buildSystemRemarkAction()]
  }

  buildSystemNonRemarkAction(): ProxyAction[] {
    return [
      {
        pallet: 'system',
        extrinsic: 'apply_authorized_upgrade',
        call: this.client.api.tx.system.applyAuthorizedUpgrade('code'),
      },
    ]
  }

  buildSystemRemarkAction(): ProxyAction[] {
    return [
      {
        pallet: 'system',
        extrinsic: 'remark',
        call: this.client.api.tx.system.remark('hello'),
      },
      {
        pallet: 'system',
        extrinsic: 'remark_with_event',
        call: this.client.api.tx.system.remarkWithEvent('hello'),
      },
    ]
  }

  buildVestingAction(): ProxyAction[] {
    const vestingCalls: ProxyAction[] = []
    if (this.client.api.tx.vesting) {
      vestingCalls.push({
        pallet: 'vesting',
        extrinsic: 'vested_transfer',
        call: this.client.api.tx.vesting.vestedTransfer(testAccounts.eve.address, {
          locked: 100e10,
          perBlock: 1e10,
          startingBlock: 1,
        }),
      })
    }

    return vestingCalls
  }

  buildUniquesAction(): ProxyAction[] {
    const uniquesCalls: ProxyAction[] = []
    if (this.client.api.tx.uniques) {
      uniquesCalls.push(...this.buildUniquesManagerAction(), ...this.buildUniquesOwnerAction())
    }

    return uniquesCalls
  }

  buildUniquesManagerAction(): ProxyAction[] {
    const uniquesCalls: ProxyAction[] = []
    if (this.client.api.tx.uniques) {
      uniquesCalls.push({
        pallet: 'uniques',
        extrinsic: 'mint',
        call: this.client.api.tx.uniques.mint(1, 1, testAccounts.eve.address),
      })
    }

    return uniquesCalls
  }

  buildUniquesOwnerAction(): ProxyAction[] {
    const uniquesCalls: ProxyAction[] = []
    if (this.client.api.tx.uniques) {
      uniquesCalls.push({
        pallet: 'uniques',
        extrinsic: 'create',
        call: this.client.api.tx.uniques.create(1, testAccounts.eve.address),
      })
    }

    return uniquesCalls
  }

  buildUtilityAction(): ProxyAction[] {
    return [
      {
        pallet: 'utility',
        extrinsic: 'batch',
        call: this.client.api.tx.utility.batch([]),
      },
      {
        pallet: 'utility',
        extrinsic: 'batch_all',
        call: this.client.api.tx.utility.batchAll([]),
      },
      {
        pallet: 'utility',
        extrinsic: 'force_batch',
        call: this.client.api.tx.utility.forceBatch([]),
      },
    ]
  }
}

/**
 * The type of proxy call filtering test to run.
 * - `Permitted`: Test that allowed proxy calls are *not* filtered
 * - `Forbidden`: Test that disallowed proxy calls *are* filtered
 */
enum ProxyCallFilteringTestType {
  Permitted = 0,
  Forbidden = 1,
}

/**
 * Build a list of actions that should be allowed for a given proxy type.
 * These are actions that the proxy type should be able to execute without being filtered.
 */
async function buildAllowedProxyActions<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(proxyType: string, client: Client<TCustom, TInitStorages>, chainName: string): Promise<ProxyAction[]> {
  const proxyActionBuilder = new ProxyActionBuilderImpl(client)

  // Note the pattern used: if the network has a certain pallet available, the list returned by the proxy action
  // builder won't be empty.
  // Otherwise, it will be empty, and this is a no-op.
  const result = match(proxyType)

    // Common

    .with('Any', () => {
      const actions = [
        ...proxyActionBuilder.buildAuctionAction(),
        ...proxyActionBuilder.buildBalancesAction(),
        ...proxyActionBuilder.buildBountyAction(),
        ...proxyActionBuilder.buildGovernanceAction(),
        ...proxyActionBuilder.buildMultisigAction(),
        ...proxyActionBuilder.buildNominationPoolsAction(),
        ...proxyActionBuilder.buildProxyAction(),
        ...proxyActionBuilder.buildStakingAction(),
        ...proxyActionBuilder.buildSystemRemarkAction(),
        ...proxyActionBuilder.buildUtilityAction(),
      ]

      // `vesting.vested_transfer` is currently disabled on asset hubs in run-up to AHM:
      // TODO: This is a temporary limitation that should be removed once the call is available again.
      if (!['assetHubPolkadot', 'assetHubKusama'].includes(chainName)) {
        actions.push(...proxyActionBuilder.buildVestingAction())
      }

      return actions
    })
    .with('NonTransfer', () => [
      ...proxyActionBuilder.buildAuctionAction(),
      ...proxyActionBuilder.buildBountyAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildMultisigAction(),
      ...proxyActionBuilder.buildNominationPoolsAction(),
      ...proxyActionBuilder.buildProxyAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemRemarkAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('CancelProxy', () => {
      const actions = [
        ...proxyActionBuilder.buildProxyRejectAnnouncementAction(),
        ...proxyActionBuilder.buildUtilityAction(),
        ...proxyActionBuilder.buildMultisigAction(),
      ]

      return actions
    })

    // Polkadot / Kusama

    .with('Auction', () => [
      ...proxyActionBuilder.buildAuctionAction(),
      ...proxyActionBuilder.buildCrowdloanAction(),
      ...proxyActionBuilder.buildSlotsAction(),
    ])
    .with('Governance', () => [
      ...proxyActionBuilder.buildBountyAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('Staking', () => [
      ...proxyActionBuilder.buildFastUnstakeAction(),
      ...proxyActionBuilder.buildNominationPoolsAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('NominationPools', () => [
      ...proxyActionBuilder.buildNominationPoolsAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])

    .with('Society', () => [...proxyActionBuilder.buildSocietyAction()])
    .with('Spokesperson', () => [...proxyActionBuilder.buildSystemRemarkAction()])
    .with('ParaRegistration', () => {
      const paraRegistrationCalls: ProxyAction[] = [
        ...proxyActionBuilder.buildParasRegistrarAction(),
        // This proxy type can only call  batch extrinsics from `pallet_utility`, which happens to coincide with the
        // current implementation of `buildUtilityAction`.
        ...proxyActionBuilder.buildUtilityAction(),
      ]

      if (chainName === 'polkadot') {
        paraRegistrationCalls.push(
          ...proxyActionBuilder.buildProxyRemoveProxyAction(PolkadotProxyTypes.ParaRegistration),
        )
      }
      if (chainName === 'kusama') {
        paraRegistrationCalls.push(...proxyActionBuilder.buildProxyRemoveProxyAction(KusamaProxyTypes.ParaRegistration))
      }

      return paraRegistrationCalls
    })

    // System Parachains

    .with('Collator', () => [
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    // Asset Hubs

    .with('Assets', () => [
      ...proxyActionBuilder.buildAssetsAction(),
      ...proxyActionBuilder.buildMultisigAction(),
      ...proxyActionBuilder.buildNftsAction(),
      ...proxyActionBuilder.buildUniquesAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('AssetManager', () => [
      ...proxyActionBuilder.buildAssetsManagerAction(),
      ...proxyActionBuilder.buildMultisigAction(),
      ...proxyActionBuilder.buildNftsManagerAction(),
      ...proxyActionBuilder.buildUniquesManagerAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('AssetOwner', () => [
      ...proxyActionBuilder.buildAssetsOwnerAction(),
      ...proxyActionBuilder.buildMultisigAction(),
      ...proxyActionBuilder.buildNftsOwnerAction(),
      ...proxyActionBuilder.buildUniquesOwnerAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])

    // Collectives

    .with('Alliance', () => [
      ...proxyActionBuilder.buildAllianceAction(),
      ...proxyActionBuilder.buildAllianceMotionAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])
    .with('Fellowship', () => [
      ...proxyActionBuilder.buildFellowshipCollectiveAction(),
      ...proxyActionBuilder.buildFellowshipCoreAction(),
      ...proxyActionBuilder.buildFellowshipReferendaAction(),
      ...proxyActionBuilder.buildFellowshipSalaryAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])
    .with('Ambassador', () => [
      ...proxyActionBuilder.buildAmbassadorCollectiveAction(),
      ...proxyActionBuilder.buildAmbassadorCoreAction(),
      ...proxyActionBuilder.buildAmbassadorReferendaAction(),
      ...proxyActionBuilder.buildAmbassadorSalaryAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    // Coretime

    .with('Broker', () => [
      ...proxyActionBuilder.buildBrokerAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    .with('CoretimeRenewer', () => [
      ...proxyActionBuilder.buildBrokerRenewerAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    .with('OnDemandPurchaser', () => [
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    // Identity

    .with('Identity', () => [
      ...proxyActionBuilder.buildIdentityAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    .with('IdentityJudgement', () => [
      ...proxyActionBuilder.buildIdentityJudgementAction(),
      ...proxyActionBuilder.buildUtilityAction(),
      ...proxyActionBuilder.buildMultisigAction(),
    ])

    .otherwise(() => [])

  return result
}

/**
 * Build a list of actions that should be disallowed for a given proxy type.
 * These are actions that the proxy type should NOT be able to execute and should be filtered.
 */
async function buildDisallowedProxyActions<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(proxyType: string, client: Client<TCustom, TInitStorages>, chainName: string): Promise<ProxyAction[]> {
  const proxyActionBuilder = new ProxyActionBuilderImpl(client)

  // For each proxy type, we return actions that it should NOT be able to execute
  const result = match(proxyType)

    // Common

    .with('Any', () => {
      const actions: ProxyAction[] = []
      // `vesting.vested_transfer` is currently disabled on asset hubs, pending the AHM.
      // TODO: This is a temporary limitation that should be removed once the call is available
      if (['assetHubPolkadot', 'assetHubKusama'].includes(chainName)) {
        actions.push(...proxyActionBuilder.buildVestingAction())
      }
      return actions
    })
    .with('NonTransfer', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])
    .with('CancelProxy', () => {
      const actions = [
        ...proxyActionBuilder.buildBalancesAction(),
        ...proxyActionBuilder.buildStakingAction(),
        ...proxyActionBuilder.buildSystemAction(),
      ]

      return actions
    })

    // Polkadot / Kusama

    .with('Auction', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])
    .with('Governance', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])
    .with('Staking', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])
    .with('NominationPools', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])
    .with('Society', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])
    .with('Spokesperson', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      // This proxy type can only call remark functions from the system pallet.
      // All other system calls are disallowed, an instance of which is in `buildSystemNonRemarkAction`.
      ...proxyActionBuilder.buildSystemNonRemarkAction(),
      ...proxyActionBuilder.buildUtilityAction(),
    ])

    .with('ParaRegistration', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildProxyAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])

    // System Parachains

    .with('Collator', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildGovernanceAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildVestingAction(),
    ])

    // Asset Hubs

    .with('Assets', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('AssetManager', () => [
      ...proxyActionBuilder.buildAssetsOwnerAction(),
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildNftsOwnerAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildUniquesOwnerAction(),
    ])
    .with('AssetOwner', () => [
      ...proxyActionBuilder.buildAssetsManagerAction(),
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildNftsManagerAction(),
      ...proxyActionBuilder.buildStakingAction(),
      ...proxyActionBuilder.buildSystemAction(),
      ...proxyActionBuilder.buildUniquesManagerAction(),
    ])

    // Collectives

    .with('Alliance', () => [
      // Check that ambassador actions are forbidden
      ...proxyActionBuilder.buildAmbassadorCollectiveAction(),
      ...proxyActionBuilder.buildAmbassadorCoreAction(),
      ...proxyActionBuilder.buildAmbassadorReferendaAction(),
      ...proxyActionBuilder.buildAmbassadorSalaryAction(),

      ...proxyActionBuilder.buildBalancesAction(),

      // and fellowship's as well.
      ...proxyActionBuilder.buildFellowshipCollectiveAction(),
      ...proxyActionBuilder.buildFellowshipCoreAction(),
      ...proxyActionBuilder.buildFellowshipReferendaAction(),
      ...proxyActionBuilder.buildFellowshipSalaryAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('Fellowship', () => [
      // Check that alliance actions are forbidden
      ...proxyActionBuilder.buildAllianceAction(),
      ...proxyActionBuilder.buildAllianceMotionAction(),

      // Check that ambassador actions are forbidden
      ...proxyActionBuilder.buildAmbassadorCollectiveAction(),
      ...proxyActionBuilder.buildAmbassadorCoreAction(),
      ...proxyActionBuilder.buildAmbassadorReferendaAction(),
      ...proxyActionBuilder.buildAmbassadorSalaryAction(),

      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('Ambassador', () => [
      ...proxyActionBuilder.buildAllianceAction(),
      ...proxyActionBuilder.buildAllianceMotionAction(),
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildFellowshipCollectiveAction(),
      ...proxyActionBuilder.buildFellowshipCoreAction(),
      ...proxyActionBuilder.buildFellowshipReferendaAction(),
      ...proxyActionBuilder.buildFellowshipSalaryAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])

    // Coretime

    .with('Broker', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      // TODO: credit purchase call disabled due to AHM. Credit must be purchased through the relay chain.
      // Add this back to `buildAllowedProxyActions` once the call is available.
      ...proxyActionBuilder.buildBrokerPurchaseCreditAction(),
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('CoretimeRenewer', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      // TODO: call disabled due to AHM.
      ...proxyActionBuilder.buildBrokerPurchaseCreditAction(),
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('OnDemandPurchaser', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      // TODO: call disabled due to AHM.
      ...proxyActionBuilder.buildBrokerPurchaseCreditAction(),
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])

    // Identity

    .with('Identity', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])
    .with('IdentityJudgement', () => [
      ...proxyActionBuilder.buildBalancesAction(),
      ...proxyActionBuilder.buildCollatorSelectionAction(),
      ...proxyActionBuilder.buildIdentityNonJudgementAction(),
      ...proxyActionBuilder.buildSystemAction(),
    ])

    .otherwise(() => [])

  return result
}

/**
 * Build a list of proxy actions based on the test type.
 * This function routes to either buildAllowedProxyActions or buildDisallowedProxyActions
 * based on the testType parameter.
 */
async function buildProxyActions<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  proxyType: string,
  client: Client<TCustom, TInitStorages>,
  testType: ProxyCallFilteringTestType,
  chainName: string,
): Promise<ProxyAction[]> {
  return testType === ProxyCallFilteringTestType.Permitted
    ? await buildAllowedProxyActions(proxyType, client, chainName)
    : await buildDisallowedProxyActions(proxyType, client, chainName)
}

/**
 * For a particular proxy type, and for a given test type ("allowed/disallowed"):
 * 1. As Alice, add a proxy account of that type
 * 2. As the proxy account, execute actions - on behalf of Alice - that such a proxy type is allowed/forbidden from execute
 * 3. Verify that the actions were correctly executed
 *     - The extrinsics are not required to be well-formed; in other words, the transaction can fail, though:
 *           - if the test type is "allowed", the transaction *must not* fail because of call filtering
 *           - if the test type is "forbidden", the transaction *must* fail because of call filtering
 *
 * To see which proxy-type-contingent actions are used, see `buildAllowedProxyActions` and `buildDisallowedProxyActions`.
 */
async function proxyCallFilteringSingleTestRunner<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  proxyType: string,
  proxyTypeIx: number,
  proxyAccount: KeyringPair,
  testType: ProxyCallFilteringTestType = ProxyCallFilteringTestType.Permitted,
) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  // Add the proxy account, with the to-be-tested proxy type
  const addProxyTx = client.api.tx.proxy.addProxy(proxyAccount.address, proxyTypeIx, 0)
  await sendTransaction(addProxyTx.signAsync(alice))

  await client.dev.newBlock()

  // Get the appropriate list of actions based on test type
  const proxyActions = await buildProxyActions(proxyType, client, testType, chain.name)

  if (proxyActions.length === 0) {
    return
  }

  await client.dev.setStorage({
    System: {
      account: [[[proxyAccount.address], { providers: 1, data: { free: 10000e10 } }]],
    },
  })

  // Execute each proxy action in its own block and check its results immediately
  for (const proxyAction of proxyActions) {
    // Execute the proxy action
    const proxyTx = client.api.tx.proxy.proxy(alice.address, proxyTypeIx, proxyAction.call)
    const result = await sendTransaction(proxyTx.signAsync(proxyAccount))

    // Advance to the next block to ensure events are processed
    await client.dev.newBlock()

    // Check the events for this specific call
    const events = await client.api.query.system.events()
    const proxyExecutedEvents = events.filter((record) => {
      const { event } = record
      return event.section === 'proxy' && event.method === 'ProxyExecuted'
    })

    // There should be exactly one `ProxyExecuted` event for this call
    expect(proxyExecutedEvents.length).toBe(1)

    // Check the result of this specific call
    const proxyExecutedEvent = proxyExecutedEvents[0]
    assert(client.api.events.proxy.ProxyExecuted.is(proxyExecutedEvent.event))
    const proxyExecutedData = proxyExecutedEvent.event.data

    // This path is taken for forbidden calls
    if (testType === ProxyCallFilteringTestType.Forbidden) {
      // Forbidden calls are expected to have failed *only* due to filtering.
      expect(proxyExecutedData.result.isErr).toBeTruthy()
      const error = proxyExecutedData.result.asErr
      if (error.isModule) {
        expect(
          client.api.errors.system.CallFiltered.is(error.asModule),
          `Call ${proxyAction.pallet}.${proxyAction.extrinsic} should be filtered for ${proxyType} proxy on ${chain.name}`,
        ).toBe(true)
      }
    }
    // Path taken for permitted calls
    else {
      // If the call failed, check that it was *not* due to call filtering.
      if (proxyExecutedData.result.isErr) {
        const error = proxyExecutedData.result.asErr
        if (error.isModule) {
          expect(
            client.api.errors.system.CallFiltered.is(error.asModule),
            `Call ${proxyAction.pallet}.${proxyAction.extrinsic} should not be filtered for ${proxyType} proxy on ${chain.name}`,
          ).toBe(false)
        } else {
          // If the call fail but not due to filtering, the test may proceed.
          // For this test, it may fail for other reasons, such as a bad origin or not enough funds.
        }
      } else {
        // Permitted calls can succeed, but are not expected to, so this arm can remain empty.
        expect(proxyExecutedData.result.isOk).toBe(true)
      }
    }

    // Snapshot the `Proxy.ProxyExecuted`event for the proxied call
    // If the pallet being tested is `balances`, its events should not be included in the snapshot
    // to avoid including block-specific fee events, which are unstable inbetween runs.
    let eventChecker: Checker
    if (proxyAction.pallet !== 'balances') {
      eventChecker = checkEvents(result, 'proxy', proxyAction.pallet)
    } else {
      eventChecker = checkEvents(result, 'proxy')
    }

    let redactKeys: RegExp | undefined
    if (['referenda', 'bounties'].includes(proxyAction.pallet)) {
      redactKeys = /^index$/
    }

    await eventChecker
      .redact({
        redactKeys,
      })
      .toMatchSnapshot(
        `events for proxy type ${proxyType}, pallet ${proxyAction.pallet}, call ${proxyAction.extrinsic}`,
      )
  }
}

/**
 * Main test runner for proxy call filtering.
 *
 * 1. creates proxies of every type (available in the current network) for Alice
 * 2. runs the test for each proxy type (if the proxy type is testable)
 *
 * To disable a proxy type from being tested, remove it from the `proxyTypesToTest` array.
 */
function proxyCallFilteringTestTree<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  proxyTypes: Record<string, number>,
  testType: ProxyCallFilteringTestType,
): DescribeNode {
  const kr = testAccounts.keyring

  const proxyAccounts = createProxyAccounts('Alice', kr, proxyTypes)

  const proxyTypesToTest = [
    'Any',
    'Governance',
    'NonTransfer',
    'Staking',
    'NominationPools',
    'CancelProxy',
    'Auction',
    'Society',
    'Spokesperson',
    'ParaRegistration',

    'Assets',
    'AssetOwner',
    'AssetManager',
    'Collator',

    'Alliance',
    'Fellowship',
    'Ambassador',

    'Broker',
    'CoretimeRenewer',
    'OnDemandPurchaser',

    'Identity',
    'IdentityJudgement',
  ]

  const children: TestNode[] = []
  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    // In this network, there might be some proxy types that should not/cannot be tested.
    if (!proxyTypesToTest.includes(proxyType)) {
      continue
    }

    children.push({
      kind: 'test' as const,
      label: `${testType === ProxyCallFilteringTestType.Permitted ? 'allowed' : 'forbidden'} proxy calls for ${proxyType}`,
      testFn: async () =>
        await proxyCallFilteringSingleTestRunner(chain, proxyType, proxyTypeIx, proxyAccounts[proxyType], testType),
    })
  }

  return {
    kind: 'describe',
    label: `filtering tests for ${testType === ProxyCallFilteringTestType.Permitted ? 'allowed' : 'forbidden'} proxy calls`,
    children,
  }
}

/// -------
/// -------
/// -------

/**
 * Test to the process of adding and removing proxies to another account.
 *
 * 1. creates proxies of every type for an account
 *     - these proxies have a delay of 0
 * 2. checks that the proxies exist
 * 3. removes every previously created proxy, one at a time with `remove_proxy`
 * 4. checks that the proxies no longer exist
 * 5. creates proxies of every type for the same account, this time with a delay
 * 6. checks that the proxies have been removed
 * 7. removes every previously created proxy, all at once with `remove_proxies`
 * 8. checks that the proxies have been removed
 */
export async function addRemoveProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig, proxyTypes: Record<string, number>, delay: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const kr = testAccounts.keyring

  // Create object with keys as proxy types and values as an Sr25519 keypair
  const proxyAccounts = createProxyAccounts('Alice', kr, proxyTypes)

  // Map from proxy indices to proxy types
  const proxyIndicesToTypes = Object.fromEntries(
    Object.entries(proxyTypes).map(([proxyType, proxyTypeIx]) => [proxyTypeIx, proxyType]),
  )

  // Create proxies

  let batch: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(proxyAccounts[proxyType].address, proxyTypeIx, 0)
    batch.push(addProxyTx)
  }

  const batchAddProxyTx = client.api.tx.utility.batchAll(batch)
  const addProxyEvents = await sendTransaction(batchAddProxyTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(addProxyEvents, 'proxy').toMatchSnapshot(`events when adding proxies to Alice`)

  // Check created proxies

  let proxyData = await client.api.query.proxy.proxies(alice.address)
  let proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  expect(proxies.length).toBe(Object.keys(proxyTypes).length)

  let proxyDeposit = proxyData[1]
  let proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  let proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  let proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(Object.keys(proxyTypes).length))
  expect(proxyDeposit.toNumber()).toBe(proxyDepositTotal.toNumber())

  for (const proxy of proxies) {
    await check(proxy).toMatchObject({
      delegate: encodeAddress(proxyAccounts[proxy.proxyType.toString()].address, testConfig.addressEncoding),
      proxyType: proxyIndicesToTypes[proxy.proxyType.toNumber()],
      delay: 0,
    })
  }

  // Remove proxies

  batch = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const removeProxyTx = client.api.tx.proxy.removeProxy(proxyAccounts[proxyType].address, proxyTypeIx, 0)
    batch.push(removeProxyTx)
  }
  const batchRemoveProxyTx = client.api.tx.utility.batchAll(batch)

  const removeProxyEvents = await sendTransaction(batchRemoveProxyTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(removeProxyEvents, 'proxy').toMatchSnapshot(`events when removing proxies from Alice (batch)`)

  const proxyDataAfterRemoval = await client.api.query.proxy.proxies(alice.address)
  const proxiesAfterRemoval: Vec<PalletProxyProxyDefinition> = proxyDataAfterRemoval[0]
  expect(proxiesAfterRemoval.length).toBe(0)

  const proxyDepositAfterRemoval = proxyDataAfterRemoval[1]
  expect(proxyDepositAfterRemoval.toNumber()).toBe(0)

  // Create proxies (with delay)

  batch = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(proxyAccounts[proxyType].address, proxyTypeIx, delay)
    batch.push(addProxyTx)
  }

  const batchAddProxyWithDelayTx = client.api.tx.utility.batchAll(batch)
  // No need to check proxy addition events again - just the delay having changed is uninteresting.
  await sendTransaction(batchAddProxyWithDelayTx.signAsync(alice))

  await client.dev.newBlock()

  // Check created proxies, again

  proxyData = await client.api.query.proxy.proxies(alice.address)
  proxies = proxyData[0]
  expect(proxies.length).toBe(Object.keys(proxyTypes).length)

  proxyDeposit = proxyData[1]
  proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(Object.keys(proxyTypes).length))
  expect(proxyDeposit.toNumber()).toBe(proxyDepositTotal.toNumber())

  for (const proxy of proxies) {
    await check(proxy)
      .redact({ removeKeys: /proxyType/ })
      .toMatchObject({
        delegate: encodeAddress(proxyAccounts[proxy.proxyType.toString()].address, testConfig.addressEncoding),
        delay: delay,
      })
  }

  // Remove delay-having proxies

  const removeProxiesTx = client.api.tx.proxy.removeProxies()
  await sendTransaction(removeProxiesTx.signAsync(alice))

  await client.dev.newBlock()

  // TODO: `remove_proxies` emits no events; when/if it ever does, this'll fail.
  const events = await client.api.query.system.events()
  const removeProxiesEvent = events.find((record) => {
    const { event } = record
    return event.section === 'proxy'
  })
  expect(removeProxiesEvent).toBeUndefined()

  proxyData = await client.api.query.proxy.proxies(alice.address)
  proxies = proxyData[0]
  expect(proxies.length).toBe(0)

  proxyDeposit = proxyData[1]
  expect(proxyDeposit.toNumber()).toBe(0)
}

/**
 * Test pure proxy management.
 *
 * 1. create as many pure proxies as there are proxy types in the current network
 * 2. use a `utility.batchAll` transaction
 * 2. check that they were all created
 * 3. (attempt to) delete all of them
 * 4. verify that they were deleted
 *     - only the `Any` proxy is currently removable via `proxy.killPure`, see #8056
 */
export async function createKillPureProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig, proxyTypes: Record<string, number>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  // Create pure proxies

  // Map between proxy types (represented as the index of the proxy type in the network's proxy enum), and
  // the index of the `proxy` extrinsic in the block in which the pure proxy was created.
  // To kill the pure proxies later, these data will be required.
  const pureProxyExtrinsicIndices = new Map<number, number>()
  // When creating pure proxies via batch calls, each proxy must be assigned a unique index.
  // Because this test uses a batch transaction to create several pure proxies of *different* types, the indices
  // can be the same for all proxies: zero.
  const proxyIx = 0
  // Map betewen proxy types (their indices, again), and their addresses.
  const pureProxyAddresses = new Map<number, string>()

  const batch: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const proxyTypeIx of Object.values(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.createPure(proxyTypeIx, 0, proxyIx)
    batch.push(addProxyTx)
  }

  const batchCreatePureProxiesTx = client.api.tx.utility.batchAll(batch)
  const createPureProxiesEvents = await sendTransaction(batchCreatePureProxiesTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(createPureProxiesEvents, 'proxy')
    .redact({ removeKeys: /pure/ })
    .toMatchSnapshot(`events when creating pure proxies for Alice`)

  // Check created proxies

  // Pure proxies aren't visible in the `proxies` query.
  const proxyData = await client.api.query.proxy.proxies(alice.address)
  const proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  expect(proxies.length).toBe(0)
  const proxyDeposit = proxyData[1]
  expect(proxyDeposit.eq(0)).toBe(true)

  const events = await client.api.query.system.events()

  const proxyEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'PureCreated'
  })

  expect(proxyEvents.length).toBe(Object.keys(proxyTypes).length)

  for (const proxyEvent of proxyEvents) {
    assert(client.api.events.proxy.PureCreated.is(proxyEvent.event))
    const eventData = proxyEvent.event.data
    // Log the extrinsic index that the `pure_proxy` extrinsic that created this pure proxy was run in.
    pureProxyExtrinsicIndices.set(
      proxyEvent.event.data.proxyType.toNumber(),
      proxyEvent.phase.asApplyExtrinsic.toNumber(),
    )

    pureProxyAddresses.set(eventData.proxyType.toNumber(), eventData.pure.toString())

    // Confer event data vs. storage
    const pureProxy = await client.api.query.proxy.proxies(eventData.pure)
    expect(pureProxy[0].length).toBe(1)
    expect(pureProxy[0][0].proxyType.eq(eventData.proxyType)).toBe(true)
    expect(pureProxy[0][0].delay.eq(0)).toBe(true)
    expect(pureProxy[0][0].delegate.eq(encodeAddress(alice.address, testConfig.addressEncoding))).toBe(true)

    const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
    const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
    const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor)
    expect(pureProxy[1].eq(proxyDepositTotal)).toBe(true)
  }

  // Kill pure proxies

  // To call `proxy.killPure`, the block number of `proxy.createPure` is required.
  // The current block number will have been the block in which the batch transaction containing all of the
  // `createPure` extrinsics were executed.
  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)

  // For every pure proxy type, create a `proxy.proxy` call, containing a `proxy.killPure` extrinsic.
  // Note that in the case of pure proxies, the account which called `proxy.createPure` becomes the delegate,
  // and the created pure account will become the delegator this needs to be reflected in the arguments for
  // `proxy.proxy`.
  for (const [proxyTypeIx, extIndex] of pureProxyExtrinsicIndices.entries()) {
    const killProxyTx = client.api.tx.proxy.killPure(alice.address, proxyTypeIx, proxyIx, currBlockNumber, extIndex)

    const proxyTx = client.api.tx.proxy.proxy(pureProxyAddresses.get(proxyTypeIx)!, null, killProxyTx)

    const proxyEvents = await sendTransaction(proxyTx.signAsync(alice))

    await client.dev.newBlock()

    // `proxy.killPure` does not emit any events.
    // #7995 will fix this, eliciting a failed test run sometime in the future.
    await checkEvents(proxyEvents, 'proxy')
      .redact({
        removeKeys: /pure/,
      })
      .toMatchSnapshot(`events when killing pure proxy of type ${proxyTypeIx} for Alice`)
  }

  // Check that the pure proxies were killed

  for (const proxyEvent of proxyEvents) {
    assert(client.api.events.proxy.PureCreated.is(proxyEvent.event))
    const eventData = proxyEvent.event.data

    const pureProxy = await client.api.query.proxy.proxies(eventData.pure)

    // At present, only `Any` pure proxies can successfully call `proxy.killPure`.
    // Pending a fix (see #8056), this may be updated to check that all pure proxy types can be killed.
    if (eventData.proxyType.toNumber() === proxyTypes['Any']) {
      expect(pureProxy[0].length).toBe(0)
      expect(pureProxy[1].eq(0)).toBe(true)
    } else {
      expect(pureProxy[0].length).toBe(1)
      expect(pureProxy[0][0].delegate.eq(encodeAddress(alice.address, testConfig.addressEncoding))).toBe(true)

      const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
      const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
      const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor)
      expect(pureProxy[1].eq(proxyDepositTotal)).toBe(true)
    }
  }
}

/**
 * Test a simple proxy scenario.
 *
 * 1. Alice adds Bob as their `Any` proxy, with no associated delay
 * 2. Bob performs a proxy call on behalf of Alice to transfer some funds to Charlie
 * 3. Charlie's balance is checked, as is Alice's
 */
export async function proxyCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie

  // Fund test accounts not already provisioned in the test chain spec.
  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Alice adds Bob as a 0-delay proxy
  const addProxyTx = client.api.tx.proxy.addProxy(bob.address, 'Any', 0)
  await sendTransaction(addProxyTx.signAsync(alice))

  await client.dev.newBlock()

  // Bob performs a proxy call to transfer funds to Charlie
  const transferAmount: number = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)
  const proxyTx = client.api.tx.proxy.proxy(alice.address, null, transferCall)

  const proxyEvents = await sendTransaction(proxyTx.signAsync(bob))

  // Check Charlie's balances beforehand
  const oldAliceBalance = (await client.api.query.system.account(alice.address)).data.free
  let charlieBalance = (await client.api.query.system.account(charlie.address)).data.free
  expect(charlieBalance.eq(0), 'Charlie should have no funds').toBe(true)

  await client.dev.newBlock()

  await checkEvents(proxyEvents, 'proxy', { section: 'balances', method: 'Transfer' }).toMatchSnapshot(
    "events when Bob transfers funds to Charlie as Alice's proxy",
  )

  // Check Alice's and Charlie's balances
  const newAliceBalance = (await client.api.query.system.account(alice.address)).data.free
  expect(newAliceBalance.eq(oldAliceBalance.sub(new BN(transferAmount))), 'Alice should have transferred funds').toBe(
    true,
  )
  charlieBalance = (await client.api.query.system.account(charlie.address)).data.free
  expect(charlieBalance.eq(transferAmount), 'Charlie should have the transferred funds').toBe(true)
}

/**
 * Test proxy announcements.
 *
 * 1. Alice adds Bob as their `Any` proxy, with no associated delay
 * 2. Bob announces an intent to perform a proxy call, on behalf of Alice, to transfer some funds to Charlie
 * 3. Alice rejects the announcement
 * 4. Bob reannounces the intent
 * 5. Bob cancels the intent themselves
 * 6. Bob reannounces the intent once more
 * 7. Bob finally performs the proxy call
 */
export async function proxyAnnouncementLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie

  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Alice adds Bob as a 0-delay proxy

  const addProxyTx = client.api.tx.proxy.addProxy(bob.address, 'Any', 0)
  await sendTransaction(addProxyTx.signAsync(alice))

  await client.dev.newBlock()

  // Bob announces an intent to transfer funds to Charlie
  const transferAmount = client.api.consts.balances.existentialDeposit.toBigInt() * 100n
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)

  await client.dev.newBlock()

  const announceTx = client.api.tx.proxy.announce(alice.address, transferCall.method.hash)
  const announcementEvents = await sendTransaction(announceTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(announcementEvents, 'proxy').toMatchSnapshot('events when Bob announces a proxy call')

  const currBlockNumber = await getBlockNumber(client.api, testConfig.blockProvider)
  const announcementObject = {
    real: encodeAddress(alice.address, testConfig.addressEncoding),
    callHash: transferCall.method.hash.toHex(),
    height: currBlockNumber,
  }

  // Sanity check - the announcement should be associated to Bob and not their delegator, Alice
  let announcements = await client.api.query.proxy.announcements(alice.address)
  expect(announcements[0].length).toBe(0)
  expect(announcements[1].eq(0)).toBe(true)
  announcements = await client.api.query.proxy.announcements(bob.address)
  expect(announcements[0].length).toBe(1)
  await check(announcements[0][0]).toMatchObject(announcementObject)

  const announcementDeposit = client.api.consts.proxy.announcementDepositBase
  const announcementDepositFactor = client.api.consts.proxy.announcementDepositFactor
  const announcementDepositTotal = announcementDeposit.add(announcementDepositFactor)
  expect(announcements[1].eq(announcementDepositTotal)).toBe(true)

  // Alice rejects the announcement

  const rejectAnnouncementTx = client.api.tx.proxy.rejectAnnouncement(bob.address, transferCall.method.hash)
  await sendTransaction(rejectAnnouncementTx.signAsync(alice))

  await client.dev.newBlock()

  // Rejection of announcements emits no events.
  // TODO: pending a discussion, this extrinsic may have an event added to it, which will break this test.
  let events = await client.api.query.system.events()
  const rejectAnnouncementEvent = events.find((record) => {
    const { event } = record
    return event.section === 'proxy'
  })
  expect(rejectAnnouncementEvent).toBeUndefined()

  announcements = await client.api.query.proxy.announcements(bob.address)
  expect(announcements[0].length).toBe(0)
  expect(announcements[1].eq(0)).toBe(true)

  // Bob reannounces the intent
  await sendTransaction(announceTx.signAsync(bob))

  await client.dev.newBlock()

  const offset = schedulerOffset(testConfig)

  announcements = await client.api.query.proxy.announcements(bob.address)
  expect(announcements[0].length).toBe(1)
  announcementObject.height = currBlockNumber + 2 * offset

  await check(announcements[0][0]).toMatchObject(announcementObject)
  expect(announcements[1].eq(announcementDepositTotal)).toBe(true)

  // Bob cancels the intent themselves
  const removeAnnouncementTx = client.api.tx.proxy.removeAnnouncement(alice.address, transferCall.method.hash)
  await sendTransaction(removeAnnouncementTx.signAsync(bob))

  await client.dev.newBlock()

  // Removal of announcements emits no events, this should also be empty.
  // TODO: see comment above for `rejectAnnouncement`
  events = await client.api.query.system.events()
  const removeAnnouncementEvent = events.find((record) => {
    const { event } = record
    return event.section === 'proxy'
  })
  expect(removeAnnouncementEvent).toBeUndefined()

  announcements = await client.api.query.proxy.announcements(bob.address)
  expect(announcements[0].length).toBe(0)
  expect(announcements[1].eq(0)).toBe(true)

  // Bob reannounces the intent once more
  await sendTransaction(announceTx.signAsync(bob))

  await client.dev.newBlock()

  const proxyAnnouncedTx = client.api.tx.proxy.proxyAnnounced(bob.address, alice.address, null, transferCall)
  const proxyAnnouncedEvents = await sendTransaction(proxyAnnouncedTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(proxyAnnouncedEvents, 'proxy').toMatchSnapshot('events when Bob performs the announced proxy call')
}

/**
 * E2E tests for proxy functionality:
 * - Adding and removing proxies
 * - Executing calls through proxies
 * - Proxy types and filtering
 */
export function baseProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig, proxyTypes: Record<string, number>): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName + ' base tests',
    children: [
      {
        kind: 'test',
        label: 'add proxies (with/without delay) to an account, and remove them',
        testFn: async () => await addRemoveProxyTest(chain, testConfig, proxyTypes, PROXY_DELAY),
      },
      {
        kind: 'test',
        label: 'create and kill pure proxies',
        testFn: async () => await createKillPureProxyTest(chain, testConfig, proxyTypes),
      },
      {
        kind: 'test',
        label: 'perform proxy call on behalf of delegator',
        testFn: async () => await proxyCallTest(chain),
      },
      {
        kind: 'test',
        label: 'proxy announcement lifecycle test',
        testFn: async () => await proxyAnnouncementLifecycleTest(chain, testConfig),
      },
    ],
  }
}

export function fullProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig, proxyTypes: Record<string, number>): RootTestTree {
  const allowedFilteringTests = proxyCallFilteringTestTree(chain, proxyTypes, ProxyCallFilteringTestType.Permitted)
  const forbiddenFilteringTests = proxyCallFilteringTestTree(chain, proxyTypes, ProxyCallFilteringTestType.Forbidden)

  const baseTestTree = baseProxyE2ETests(chain, testConfig, proxyTypes)

  return {
    kind: 'describe' as const,
    label: testConfig.testSuiteName + ' full tests (includes call filtering)',
    children: [baseTestTree, allowedFilteringTests, forbiddenFilteringTests],
  }
}
