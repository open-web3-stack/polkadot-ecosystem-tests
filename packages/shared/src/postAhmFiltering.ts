import { type Chain, testAccounts } from '@e2e-test/networks'
import { type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { sha256AsU8a } from '@polkadot/util-crypto'

import { type TestConfig, testCallsViaForceBatch } from './helpers/index.js'

/**
 * Test that all staking extrinsics are filtered on the calling chain.
 */
async function stakingCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // Create a `utility.forceBatch` with all staking extrinsics using garbage but well-formed arguments
  const batchCalls = [
    // call index 0
    client.api.tx.staking.bond(1_000_000_000n, { Staked: null }),
    // 1
    client.api.tx.staking.bondExtra(1_000_000_000n),
    // 2
    client.api.tx.staking.unbond(1_000_000_000n),
    // 3
    client.api.tx.staking.withdrawUnbonded(0),
    // 4
    client.api.tx.staking.validate({ commission: 1e7, blocked: false }),
    // 5
    client.api.tx.staking.nominate([testAccounts.alice.address]),
    // 6
    client.api.tx.staking.chill(),
    // 7
    client.api.tx.staking.setPayee({ Staked: null }),
    // 8
    client.api.tx.staking.setController(),
    // 9
    client.api.tx.staking.setValidatorCount(100),
    // 10
    client.api.tx.staking.increaseValidatorCount(10),
    // 11
    client.api.tx.staking.scaleValidatorCount(10),
    // 12
    client.api.tx.staking.forceNoEras(),
    // 13
    client.api.tx.staking.forceNewEra(),
    // 14
    client.api.tx.staking.setInvulnerables([testAccounts.alice.address]),
    // 15
    client.api.tx.staking.forceUnstake(testAccounts.alice.address, 0),
    // 16
    client.api.tx.staking.forceNewEraAlways(),
    // 17
    client.api.tx.staking.cancelDeferredSlash(0, [0]),
    // 18
    client.api.tx.staking.payoutStakers(testAccounts.alice.address, 0),
    // 19
    client.api.tx.staking.rebond(1_000_000_000n),
    // 20
    client.api.tx.staking.reapStash(testAccounts.alice.address, 0),
    // 21
    client.api.tx.staking.kick([testAccounts.alice.address]),
    // 22
    client.api.tx.staking.setStakingConfigs(
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
    ),
    // 23
    client.api.tx.staking.chillOther(testAccounts.alice.address),
    // 24
    client.api.tx.staking.forceApplyMinCommission(testAccounts.alice.address),
    // 25
    client.api.tx.staking.setMinCommission(10_000_000),
    // 26
    client.api.tx.staking.payoutStakersByPage(testAccounts.alice.address, 0, 0),
    // 27
    client.api.tx.staking.updatePayee(testAccounts.alice.address),
    // 28
    client.api.tx.staking.deprecateControllerBatch([testAccounts.alice.address]),
    // 29
    client.api.tx.staking.restoreLedger(testAccounts.alice.address, null, null, null),
    // 30
    client.api.tx.staking.migrateCurrency(testAccounts.alice.address),
    // 33
    client.api.tx.staking.manualSlash(testAccounts.alice.address, 0, 0),
  ]

  await testCallsViaForceBatch(client, 'Staking', batchCalls, testAccounts.alice, 'Filtered')
}

/**
 * Test that all vesting extrinsics are filtered on the calling chain.
 */
async function vestingCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const batchCalls = [
    // call index 0
    client.api.tx.vesting.vest(),
    // 1
    client.api.tx.vesting.vestOther(bob.address),
    // 2
    client.api.tx.vesting.vestedTransfer(bob.address, { perBlock: 1_000_000n, locked: 10_000_000n, startingBlock: 0 }),
    // 3
    client.api.tx.vesting.forceVestedTransfer(alice.address, bob.address, {
      perBlock: 1_000_000n,
      locked: 10_000_000n,
      startingBlock: 0,
    }),
    // 4
    client.api.tx.vesting.mergeSchedules(0, 1),
    // 5
    client.api.tx.vesting.forceRemoveVestingSchedule(bob.address, 0),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test that all referenda extrinsics are filtered on the calling chain.
 */
async function referendaCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.referenda.submit(
      { system: 'Root' },
      { Inline: client.api.tx.system.remark('0x00').method.toHex() },
      { At: 0 },
    ),
    // 1
    client.api.tx.referenda.placeDecisionDeposit(0),
    // 2
    client.api.tx.referenda.refundDecisionDeposit(0),
    // 3
    client.api.tx.referenda.cancel(0),
    // 4
    client.api.tx.referenda.kill(0),
    // 5
    client.api.tx.referenda.nudgeReferendum(0),
    // 6
    client.api.tx.referenda.oneFewerDeciding(0),
    // 7
    client.api.tx.referenda.refundSubmissionDeposit(0),
    // 8
    client.api.tx.referenda.setMetadata(0, null),
  ]

  await testCallsViaForceBatch(client, 'Referenda', batchCalls, alice, 'Filtered')
}

/**
 * Test that all conviction-voting extrinsics are filtered on the calling chain.
 */
async function convictionVotingCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const batchCalls = [
    // call index 0
    client.api.tx.convictionVoting.vote(0, {
      Standard: { vote: { aye: true, conviction: 0 }, balance: 1_000_000_000n },
    }),
    // 1
    client.api.tx.convictionVoting.delegate(0, bob.address, 0, 1_000_000_000n),
    // 2
    client.api.tx.convictionVoting.undelegate(0),
    // 3
    client.api.tx.convictionVoting.unlock(0, bob.address),
    // 4
    client.api.tx.convictionVoting.removeVote(null, 0),
    // 5
    client.api.tx.convictionVoting.removeOtherVote(bob.address, 0, 0),
  ]

  await testCallsViaForceBatch(client, 'ConvictionVoting', batchCalls, alice, 'Filtered')
}

/**
 * Test that all preimage extrinsics are filtered on the calling chain.
 */
async function preimageCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.preimage.notePreimage('0x00'),
    // 1
    client.api.tx.preimage.unnotePreimage('0x0000000000000000000000000000000000000000000000000000000000000000'),
    // 2
    client.api.tx.preimage.requestPreimage('0x0000000000000000000000000000000000000000000000000000000000000000'),
    // 3
    client.api.tx.preimage.unrequestPreimage('0x0000000000000000000000000000000000000000000000000000000000000000'),
    // 4
    client.api.tx.preimage.ensureUpdated(['0x0000000000000000000000000000000000000000000000000000000000000000']),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test that all nomination-pools extrinsics are filtered on the calling chain.
 */
async function nominationPoolsCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const batchCalls = [
    // call index 0
    client.api.tx.nominationPools.join(1_000_000_000n, 0),
    // 1
    client.api.tx.nominationPools.bondExtra({ FreeBalance: 1_000_000_000n }),
    // 2
    client.api.tx.nominationPools.claimPayout(),
    // 3
    client.api.tx.nominationPools.unbond(bob.address, 1_000_000_000n),
    // 4
    client.api.tx.nominationPools.poolWithdrawUnbonded(0, 0),
    // 5
    client.api.tx.nominationPools.withdrawUnbonded(bob.address, 0),
    // 6
    client.api.tx.nominationPools.create(1_000_000_000n, bob.address, bob.address, bob.address),
    // 7
    client.api.tx.nominationPools.createWithPoolId(1_000_000_000n, bob.address, bob.address, bob.address, 0),
    // 8
    client.api.tx.nominationPools.nominate(0, [bob.address]),
    // 9
    client.api.tx.nominationPools.setState(0, 'Destroying'),
    // 10
    client.api.tx.nominationPools.setMetadata(0, '0x00'),
    // 11
    client.api.tx.nominationPools.setConfigs(
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
      { Noop: null },
    ),
    // 12
    client.api.tx.nominationPools.updateRoles(0, { Noop: null }, { Noop: null }, { Noop: null }),
    // 13
    client.api.tx.nominationPools.chill(0),
    // 14
    client.api.tx.nominationPools.bondExtraOther(bob.address, { FreeBalance: 1_000_000_000n }),
    // 15
    client.api.tx.nominationPools.setClaimPermission('Permissioned'),
    // 16
    client.api.tx.nominationPools.claimPayoutOther(bob.address),
    // 17
    client.api.tx.nominationPools.setCommission(0, [1e7, bob.address]),
    // 18
    client.api.tx.nominationPools.setCommissionMax(0, 1e7),
    // 19
    client.api.tx.nominationPools.setCommissionChangeRate(0, { maxIncrease: 1e7, minDelay: 0 }),
    // 20
    client.api.tx.nominationPools.claimCommission(0),
    // 21
    client.api.tx.nominationPools.adjustPoolDeposit(0),
    // 22
    client.api.tx.nominationPools.setCommissionClaimPermission(0, 'Permissionless'),
    // 23
    client.api.tx.nominationPools.applySlash(bob.address),
    // 24
    client.api.tx.nominationPools.migrateDelegation(bob.address),
    // 25
    client.api.tx.nominationPools.migratePoolToDelegateStake(0),
  ]

  await testCallsViaForceBatch(client, 'NominationPools', batchCalls, alice, 'Filtered')
}

/**
 * Test that all bounties extrinsics are filtered on the calling chain.
 */
async function bountiesCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const batchCalls = [
    // call index 0
    client.api.tx.bounties.proposeBounty(1_000_000_000n, '0x00'),
    // 1
    client.api.tx.bounties.approveBounty(0),
    // 2
    client.api.tx.bounties.proposeCurator(0, bob.address, 1_000_000n),
    // 3
    client.api.tx.bounties.unassignCurator(0),
    // 4
    client.api.tx.bounties.acceptCurator(0),
    // 5
    client.api.tx.bounties.awardBounty(0, bob.address),
    // 6
    client.api.tx.bounties.claimBounty(0),
    // 7
    client.api.tx.bounties.closeBounty(0),
    // 8
    client.api.tx.bounties.extendBountyExpiry(0, '0x00'),
    // 9
    client.api.tx.bounties.approveBountyWithCurator(0, bob.address, 1_000_000n),
    // 10
    client.api.tx.bounties.pokeDeposit(0),
  ]

  await testCallsViaForceBatch(client, 'Bounties', batchCalls, alice, 'Filtered')
}

/**
 * Test that all child-bounties extrinsics are filtered on the calling chain.
 */
async function childBountiesCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const batchCalls = [
    // call index 0
    client.api.tx.childBounties.addChildBounty(0, 1_000_000_000n, '0x00'),
    // 1
    client.api.tx.childBounties.proposeCurator(0, 0, bob.address, 1_000_000n),
    // 2
    client.api.tx.childBounties.acceptCurator(0, 0),
    // 3
    client.api.tx.childBounties.unassignCurator(0, 0),
    // 4
    client.api.tx.childBounties.awardChildBounty(0, 0, bob.address),
    // 5
    client.api.tx.childBounties.claimChildBounty(0, 0),
    // 6
    client.api.tx.childBounties.closeChildBounty(0, 0),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test that BABE extrinsics are NOT filtered on the calling chain.
 */
async function babeCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    // Requires: equivocation_proof (Box<EquivocationProof>), key_owner_proof
    // Using minimal structures - actual proofs would be complex
    client.api.tx.babe.reportEquivocation(
      // These are placeholder values - actual equivocation proofs are complex objects
      // The call will fail validation but the structure is correct
      {} as any,
      {} as any,
    ),
    // call index 1
    client.api.tx.babe.reportEquivocationUnsigned({} as any, {} as any),
    // call index 2
    client.api.tx.babe.planConfigChange({ V1: { c: [1, 1], allowedSlots: 'PrimarySlots' } }),
  ]

  await testCallsViaForceBatch(client, 'Grandpa', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that GRANDPA extrinsics are NOT filtered on the calling chain.
 */
async function grandpaCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.grandpa.reportEquivocation({} as any, {} as any),
    // call index 1
    client.api.tx.grandpa.reportEquivocationUnsigned({} as any, {} as any),
    // call index 2
    client.api.tx.grandpa.noteStalled(1000, 1000),
  ]

  await testCallsViaForceBatch(client, 'Grandpa', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that Beefy extrinsics are NOT filtered on the calling chain.
 */
async function beefyCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  // Beefy has 7 calls: indices 0-6 (from beefy/src/lib.rs)
  // Use the tx API methods directly - they handle argument encoding automatically
  // The calls will fail validation but that's fine, we're just checking filtering
  const batchCalls = [
    // Call index 0
    client.api.tx.beefy.reportDoubleVoting({} as any, {} as any),
    // call index 1
    client.api.tx.beefy.reportDoubleVotingUnsigned({} as any, {} as any),
    // Call index 2
    client.api.tx.beefy.setNewGenesis(1),
    // Call index 3
    client.api.tx.beefy.reportForkVoting({} as any, {} as any),
    // Call index 4
    client.api.tx.beefy.reportForkVotingUnsigned({} as any, {} as any),
    // Call index 5
    client.api.tx.beefy.reportFutureBlockVoting({} as any, {} as any),
    // Call index 6
    client.api.tx.beefy.reportFutureBlockVotingUnsigned({} as any, {} as any),
  ]

  await testCallsViaForceBatch(client, 'Grandpa', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that `paraSlashing` extrinsics are NOT filtered on the calling chain.
 */
async function parasSlashingCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const batchCalls = [
    // call index 0 - report_dispute_lost_unsigned
    client.api.tx.parasSlashing.reportDisputeLostUnsigned({} as any, {} as any),
  ]

  await testCallsViaForceBatch(client, 'ParasSlashing', batchCalls, testAccounts.alice, 'NotFiltered')
}

/**
 * Test that Slots extrinsics are filtered on the calling chain.
 */
async function slotsCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.slots.forceLease(1000, alice.address, 1_000_000_000n, 0, 1),
    // call index 1
    client.api.tx.slots.clearAllLeases(1000),
    // call index 2
    client.api.tx.slots.triggerOnboard(1000),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test that Auctions extrinsics are filtered on the calling chain.
 */
async function auctionsCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.auctions.newAuction(1000, 0),
    // call index 1
    client.api.tx.auctions.bid(1000, 0, 0, 1, 1_000_000_000n),
    // call index 2
    client.api.tx.auctions.cancelAuction(),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test the crowdloan extrinsics which are NOT filtered (withdraw, refund, dissolve) on the calling chain.
 */
async function crowdloanCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 2 - withdraw (OFF, ON)
    client.api.tx.crowdloan.withdraw(alice.address, 1000),
    // call index 3 - refund (OFF, ON)
    client.api.tx.crowdloan.refund(1000),
    // call index 4 - dissolve (OFF, ON)
    client.api.tx.crowdloan.dissolve(1000),
  ]

  await testCallsViaForceBatch(client, 'Crowdloan', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that Crowdloan extrinsics that are filtered on the calling chain.
 */
async function crowdloanCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0 - create
    client.api.tx.crowdloan.create(1000, 1_000_000_000n, 0, 1, 1000, null),
    // call index 1 - contribute
    client.api.tx.crowdloan.contribute(1000, 1_000_000n, null),
    // call index 5 - edit
    client.api.tx.crowdloan.edit(1000, 1_000_000_000n, 0, 1, 1000, null),
    // call index 6 - add_memo
    client.api.tx.crowdloan.addMemo(1000, '0x00'),
    // call index 7 - poke
    client.api.tx.crowdloan.poke(1000),
    // call index 8 - contribute_all
    client.api.tx.crowdloan.contributeAll(1000, null),
  ]

  await testCallsViaForceBatch(client, 'Vesting', batchCalls, alice, 'Filtered')
}

/**
 * Test that all scheduler extrinsics are filtered on the calling chain.
 */
async function schedulerCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.scheduler.schedule(1000, null, 0, client.api.tx.system.remark('0x00').method.toHex()),
    // call index 1
    client.api.tx.scheduler.cancel(1000, 0),
    // call index 2
    client.api.tx.scheduler.scheduleNamed(
      sha256AsU8a('task_id'),
      1000,
      null,
      0,
      client.api.tx.system.remark('0x00').method.toHex(),
    ),
    // call index 3
    client.api.tx.scheduler.cancelNamed(sha256AsU8a('task_id')),
    // call index 4
    client.api.tx.scheduler.scheduleAfter(10, null, 0, client.api.tx.system.remark('0x00')),
    // call index 5
    client.api.tx.scheduler.scheduleNamedAfter(
      sha256AsU8a('task_id'),
      10,
      null,
      0,
      client.api.tx.system.remark('0x00'),
    ),
    // call index 6
    client.api.tx.scheduler.setRetry([1000, 0], 3, 10),
    // call index 7
    client.api.tx.scheduler.setRetryNamed(sha256AsU8a('task_id'), 3, 10),
    // call index 8
    client.api.tx.scheduler.cancelRetry([1000, 0]),
    // call index 9
    client.api.tx.scheduler.cancelRetryNamed(sha256AsU8a('task_id')),
  ]

  await testCallsViaForceBatch(client, 'Scheduler', batchCalls, alice, 'Filtered')
}

/**
 * Test that all treasury extrinsics are filtered on the calling chain.
 */
async function treasuryCallsFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 3
    client.api.tx.treasury.spendLocal(1_000_000_000n, alice.address),
    // call index 4
    client.api.tx.treasury.removeApproval(0),
    // call index 5
    client.api.tx.treasury.spend({ v4: {} } as any, 1_000_000_000n, { v4: {} } as any, null),
    // call index 6
    client.api.tx.treasury.payout(0),
    // call index 7
    client.api.tx.treasury.checkStatus(0),
    // call index 8
    client.api.tx.treasury.voidSpend(0),
  ]

  await testCallsViaForceBatch(client, 'Treasury', batchCalls, alice, 'Filtered')
}

/**
 * Test that System extrinsics are NOT filtered on the calling chain.
 */
async function systemCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.system.remark('0x00'),
    // call index 1
    client.api.tx.system.setHeapPages(0),
    // call index 2
    client.api.tx.system.setCode('0x00'),
    // call index 3
    client.api.tx.system.setCodeWithoutChecks('0x00'),
    // call index 4
    client.api.tx.system.setStorage([]),
    // call index 5
    client.api.tx.system.killStorage([]),
    // call index 6
    client.api.tx.system.killPrefix('0x00', 0),
    // call index 7
    client.api.tx.system.remarkWithEvent('0x00'),
  ]

  await testCallsViaForceBatch(client, 'System', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that StakingAhClient extrinsics are NOT filtered on the calling chain.
 */
async function stakingAhClientCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.stakingAhClient.validatorSet({} as any),
    // call index 1
    client.api.tx.stakingAhClient.setMode('Active'),
    // call index 2
    client.api.tx.stakingAhClient.forceOnMigrationEnd(),
  ]

  await testCallsViaForceBatch(client, 'StakingAhClient', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that Paras extrinsics are NOT filtered on the calling chain.
 */
async function parasCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 0
    client.api.tx.paras.forceSetCurrentCode(1000, '0x00'),
    // call index 1
    client.api.tx.paras.forceSetCurrentHead(1000, '0x00'),
    // call index 2
    client.api.tx.paras.forceScheduleCodeUpgrade(1000, '0x00', 1000),
    // call index 3
    client.api.tx.paras.forceNoteNewHead(1000, '0x00'),
    // call index 4
    client.api.tx.paras.forceQueueAction(1000),
    // call index 5
    client.api.tx.paras.addTrustedValidationCode('0x00'),
    // call index 6
    client.api.tx.paras.pokeUnusedValidationCode('0x0000000000000000000000000000000000000000000000000000000000000000'),
    // call index 7
    client.api.tx.paras.includePvfCheckStatement(
      {
        accept: true,
        subject: '0x0000000000000000000000000000000000000000000000000000000000000000',
        session_index: 1000,
        validator_index: 0,
      },
      '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    ),
    // call index 8
    client.api.tx.paras.forceSetMostRecentContext(1000, 1000),
    // call index 9
    client.api.tx.paras.removeUpgradeCooldown(1000),
    // call index 10
    client.api.tx.paras.authorizeForceSetCurrentCodeHash(
      1000,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      1000,
    ),
    // call index 11
    client.api.tx.paras.applyAuthorizedForceSetCurrentCode(1000, '0x00'),
  ]

  await testCallsViaForceBatch(client, 'Paras', batchCalls, alice, 'NotFiltered')
}

/**
 * Test that Coretime extrinsics are NOT filtered on the calling chain.
 */
async function coretimeCallsNotFilteredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice

  const batchCalls = [
    // call index 1 - request_core_count (ON, ON)
    client.api.tx.coretime.requestCoreCount(10),
    // call index 2 - request_revenue_at (OFF, ON)
    client.api.tx.coretime.requestRevenueAt(1000),
    // call index 3 - credit_account (ON, ON)
    client.api.tx.coretime.creditAccount(alice.address, 1_000_000_000n),
    // call index 4 - assign_core (ON, ON)
    client.api.tx.coretime.assignCore(0, 1000, [], null),
  ]

  await testCallsViaForceBatch(client, 'Coretime', batchCalls, alice, 'NotFiltered')
}

export function postAhmFilteringE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'filtered calls',
        children: [
          {
            kind: 'test',
            label: 'staking calls are filtered',
            testFn: async () => await stakingCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'vesting calls are filtered',
            testFn: async () => await vestingCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'referenda calls are filtered',
            testFn: async () => await referendaCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'conviction-voting calls are filtered',
            testFn: async () => await convictionVotingCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage calls are filtered',
            testFn: async () => await preimageCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'nomination pools calls are filtered',
            testFn: async () => await nominationPoolsCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'bounties calls are filtered',
            testFn: async () => await bountiesCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'child-bounties calls are filtered',
            testFn: async () => await childBountiesCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'slots calls are filtered',
            testFn: async () => await slotsCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'auctions calls are filtered',
            testFn: async () => await auctionsCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'crowdloan calls (create, contribute, edit, etc) are filtered',
            testFn: async () => await crowdloanCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'scheduler calls are filtered',
            testFn: async () => await schedulerCallsFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'treasury calls are filtered',
            testFn: async () => await treasuryCallsFilteredTest(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'unfiltered calls',
        children: [
          {
            kind: 'test',
            label: 'babe calls are not filtered',
            testFn: async () => await babeCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'grandpa calls are not filtered',
            testFn: async () => await grandpaCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'beefy calls are not filtered',
            testFn: async () => await beefyCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'parasSlashing calls are not filtered',
            testFn: async () => await parasSlashingCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'crowdloan calls (withdraw, refund, dissolve) are not filtered',
            testFn: async () => await crowdloanCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'system calls are not filtered',
            testFn: async () => await systemCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'stakingAhClient calls are not filtered',
            testFn: async () => await stakingAhClientCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'paras calls are not filtered',
            testFn: async () => await parasCallsNotFilteredTest(chain),
          },
          {
            kind: 'test',
            label: 'coretime calls are not filtered',
            testFn: async () => await coretimeCallsNotFilteredTest(chain),
          },
        ],
      },
    ],
  }
}
