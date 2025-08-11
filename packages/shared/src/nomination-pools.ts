import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { ApiPromise } from '@polkadot/api'
import type { KeyringPair } from '@polkadot/keyring/types'
import { type Option, u32 } from '@polkadot/types'
import type { PalletNominationPoolsBondedPoolInner } from '@polkadot/types/lookup'
import type { Codec } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  check,
  checkEvents,
  checkSystemEvents,
  createAndBondAccounts,
  getValidators,
  objectCmp,
  scheduleInlineCallWithOrigin,
  setValidatorsStorage,
} from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Compare the selected properties of two nomination pools.
 *
 * Fails if any of the properties to be compared is different.
 *
 * It can be desirable to compare a nomination pool in pre- and post-block-execution states of
 * different operations.
 * For example:
 * 1. before and after changing its commission information
 * 2. before and after changing its roles
 * 3. before and after adding a new member
 *
 * @param pool1
 * @param pool2
 * @param propertiesToBeSkipped List of properties to not be included in the comparison
 */
function nominationPoolCmp(
  pool1: PalletNominationPoolsBondedPoolInner,
  pool2: PalletNominationPoolsBondedPoolInner,
  propertiesToBeSkipped: string[],
) {
  const properties = ['commission', 'memberCounter', 'points', 'roles', 'state']

  const msgFun = (p: string) =>
    `Nomination pools differed on property \`${p}\`
      Left: ${pool1[p]}
      Right: ${pool2[p]}`

  objectCmp(pool1, pool2, properties, propertiesToBeSkipped, msgFun)
}

/**
 * Create a nomination pool for use in tests; useful helper to reduce boilerplate in tests.
 *
 * Creates a nomination pool with the minimum bond required to create a pool.
 * When this function returns, the transaction will have been broadcast; for it to take effect, a block
 * must be produced.
 *
 * @returns A promise resolving to the events emitted by the transaction, and the .
 */
async function createNominationPool(
  client: { api: ApiPromise },
  signer: KeyringPair,
  root: string,
  nominator: string,
  bouncer: string,
): Promise<{ events: Promise<Codec[]> }> {
  const minJoinBond = (await client.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await client.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = client.api.consts.balances.existentialDeposit.toNumber()

  const depositorBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  const createNomPoolTx = client.api.tx.nominationPools.create(depositorBond, root, nominator, bouncer)
  const createNomPoolEvents = sendTransaction(createNomPoolTx.signAsync(signer))

  return createNomPoolEvents
}

/// -------
/// -------
/// -------

/**
 * Test that attempts to create a nomination pool with insufficient funds.
 *
 * It should fail with a `MinimumBondNotMet` error.
 */
async function nominationPoolCreationFailureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  const minJoinBond = (await client.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await client.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = client.api.consts.balances.existentialDeposit.toNumber()

  const depositorMinBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  // Attempt to create a pool with insufficient funds
  const createNomPoolTx = client.api.tx.nominationPools.create(
    depositorMinBond - 1,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.bob.address,
    defaultAccountsSr25519.charlie.address,
  )
  await sendTransaction(createNomPoolTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'create nomination pool with insufficient funds events',
  )

  /// Process events

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.nominationPools.MinimumBondNotMet.is(dispatchError.asModule))
}

/**
 * Nomination pool lifecycle test.
 * Includes:
 *
 * 1. (successful) creation of a nomination pool
 * 2. updating the roles of the pool
 * 3. setting the commission data of the pool
 *
 *     3.1 setting the commission
 *
 *     3.2 setting the maximum commission
 *
 *     3.3 setting the commission change rate throttle and minimum delay between commission changes
 *
 *     3.4 setting the commission claim permission to permissionless
 *
 * 4. nominating a validator set as the pool's validator
 * 5. having another other account join the pool
 * 6. bonding additional funds from this newcomer account to the pool
 * 7. attempt to claim the pool's (zero) commission as a random account
 * 8. unbonding the additionally bonded funds from the newcomer account
 * 9. moving the pool to the `chill` nominating state, as its nominator
 * 10. setting the pool state to blocked
 * 11. kicking the newcomer account from the pool as the bouncer
 * 12. setting the pool state to destroying
 * 13. attempting to unbond the initial depositor's funds (should fail)
 * @param chain
 * @param addressEncoding
 */
async function nominationPoolLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)
  const ferdie = defaultAccountsSr25519.keyring.addFromUri('//Ferdie')

  // Fund test accounts not already provisioned in the test chain spec.
  await client.dev.setStorage({
    System: {
      account: [
        [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccountsSr25519.charlie.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccountsSr25519.dave.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccountsSr25519.eve.address], { providers: 1, data: { free: 10000e10 } }],
        [[ferdie.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const preLastPoolId = (await client.api.query.nominationPools.lastPoolId()).toNumber()

  // Obtain the minimum deposit required to create a pool, as calculated by `pallet_nomination_poola::create`.
  const minJoinBond = (await client.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await client.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = client.api.consts.balances.existentialDeposit.toNumber()

  const depositorMinBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  /**
   * Create pool with sufficient funds
   */

  const createNomPoolTx = client.api.tx.nominationPools.create(
    depositorMinBond,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.alice.address,
  )
  const createNomPoolEvents = await sendTransaction(createNomPoolTx.signAsync(defaultAccountsSr25519.alice))

  /// Check that prior to the block taking effect, the pool does not yet exist with the
  /// most recently available pool ID.
  let poolData: Option<PalletNominationPoolsBondedPoolInner> = await client.api.query.nominationPools.bondedPools(
    preLastPoolId + 1,
  )
  expect(poolData.isNone, 'Pool should not exist before block is applied').toBe(true)

  await client.dev.newBlock()

  const removedKeys = /poolId|stash/
  await checkEvents(createNomPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: removedKeys })
    .toMatchSnapshot('create nomination pool events')

  /// Check status of created pool

  const nomPoolId = (await client.api.query.nominationPools.lastPoolId()).toNumber()
  expect(preLastPoolId + 1, 'Pool ID should be most recently available number + 1').toBe(nomPoolId)

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should exist after block is applied').toBe(true)

  const nominationPoolPostCreation = poolData.unwrap()
  await check(nominationPoolPostCreation.commission).toMatchObject({
    current: null,
    max: null,
    changeRate: null,
    throttleFrom: null,
    claimPermission: null,
  })
  expect(nominationPoolPostCreation.memberCounter, 'Pool should have 1 member').toBe(1)
  expect(nominationPoolPostCreation.points, 'Pool should have `deposit_min_bond` points').toBe(depositorMinBond)
  await check(nominationPoolPostCreation.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
  })
  expect(nominationPoolPostCreation.state.isOpen, 'Pool should be open after creation').toBe(true)

  /**
   * Update pool roles
   */

  const updateRolesTx = client.api.tx.nominationPools.updateRoles(
    nomPoolId,
    { Set: defaultAccountsSr25519.bob.address },
    { Set: defaultAccountsSr25519.charlie.address },
    { Set: defaultAccountsSr25519.dave.address },
  )
  const updateRolesEvents = await sendTransaction(updateRolesTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkEvents(updateRolesEvents, 'nominationPools').toMatchSnapshot('update roles events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after roles are updated').toBe(true)

  const nominationPoolWithRoles = poolData.unwrap()
  nominationPoolCmp(nominationPoolPostCreation, nominationPoolWithRoles, ['roles'])

  await check(nominationPoolWithRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: encodeAddress(defaultAccountsSr25519.bob.address, addressEncoding),
    nominator: encodeAddress(defaultAccountsSr25519.charlie.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.dave.address, addressEncoding),
  })

  /**
   * Set the pool's commission data
   */

  // This will be `Perbill` runtime-side, so 0.1%. Note that in TypeScript,
  // `10e1` = `10 * 10`
  const commission = 1e6

  const setCommissionTx = client.api.tx.nominationPools.setCommission(nomPoolId, [
    commission,
    defaultAccountsSr25519.eve.address,
  ])

  const setCommissionMaxTx = client.api.tx.nominationPools.setCommissionMax(nomPoolId, commission * 10)

  const setCommissionChangeRateTx = client.api.tx.nominationPools.setCommissionChangeRate(nomPoolId, {
    maxIncrease: 1e9,
    minDelay: 10,
  })

  const setCommissionClaimPermissionTx = client.api.tx.nominationPools.setCommissionClaimPermission(
    nomPoolId,
    'Permissionless',
  )

  const commissionTx = client.api.tx.utility.batchAll([
    setCommissionTx,
    setCommissionMaxTx,
    setCommissionChangeRateTx,
    setCommissionClaimPermissionTx,
  ])
  const commissionEvents = await sendTransaction(commissionTx.signAsync(defaultAccountsSr25519.bob))

  await client.dev.newBlock()

  await checkEvents(commissionEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('commission alteration events')

  /// Check that all commission data were set correctly
  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after commission is changed').toBe(true)

  const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const nominationPoolWithCommission = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithRoles, nominationPoolWithCommission, ['commission'])

  const newCommissionData = {
    max: commission * 10,
    current: [commission, encodeAddress(defaultAccountsSr25519.eve.address, addressEncoding)],
    changeRate: {
      maxIncrease: 1e9,
      minDelay: 10,
    },
    throttleFrom: blockNumber,
    claimPermission: { permissionless: null },
  }

  await check(nominationPoolWithCommission.commission).toMatchObject(newCommissionData)

  ///
  /// Nominate a validator set
  ///

  /// If there are no validators (this test might be running in a genesis testnet), create some.

  const validatorCount = 16

  const currValCount = await client.api.query.staking.counterForValidators()

  let validators: string[]

  if (currValCount.eq(0)) {
    const validatorKeyPairs = await createAndBondAccounts(client, validatorCount)

    validators = validatorKeyPairs.map((v) => v.address)

    await setValidatorsStorage(client, validators)
  } else {
    validators = await getValidators(client.api, 100, validatorCount)
  }

  const nominateTx = client.api.tx.nominationPools.nominate(nomPoolId, validators)
  const nominateEvents = await sendTransaction(nominateTx.signAsync(defaultAccountsSr25519.charlie))

  await client.dev.newBlock()

  // TODO: `nominate` does not emit any events from `staking` or `nominationPools` as of
  // Jan. 2025. [#7377](https://github.com/paritytech/polkadot-sdk/pull/7377) will fix this.
  await checkEvents(nominateEvents, 'staking', 'nominationPools', 'system')
    .redact({ removeKeys: /poolId|stash/ })
    .toMatchSnapshot('nomination pool validator selection events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after validators are nominated')

  // TODO: current runtimes do not have the `PoolAccounts` runtime API call available.
  // When they do, verify that the pool's bonded account made the above nominations.
  //const [bondedAcc, rewardAcc] = await client.api.call.nominationPoolsApi.poolAccounts(nomPoolId)

  const nominationPoolAfterNomination = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithCommission, nominationPoolAfterNomination, [])

  /**
   * Have another account join the pool
   */

  const joinPoolTx = client.api.tx.nominationPools.join(minJoinBond, nomPoolId)
  const joinPoolEvents = await sendTransaction(joinPoolTx.signAsync(defaultAccountsSr25519.eve))

  await client.dev.newBlock()

  await checkEvents(joinPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId|stash/ })
    .toMatchSnapshot('join nomination pool events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after new member joins').toBe(true)

  const nominationPoolWithMembers = poolData.unwrap()
  expect(nominationPoolWithMembers.memberCounter.toNumber(), 'Pool should have 2 members').toBe(2)
  expect(
    nominationPoolWithMembers.points.toNumber(),
    'Pool should have `depositor_min_bond + min_join_bond` points',
  ).toBe(depositorMinBond + minJoinBond)

  nominationPoolCmp(nominationPoolWithCommission, nominationPoolWithMembers, ['memberCounter', 'points'])

  /**
   * Bond additional funds as Eve
   */

  const bondExtraTx = client.api.tx.nominationPools.bondExtra({ FreeBalance: minJoinBond - 1 })
  const bondExtraEvents = await sendTransaction(bondExtraTx.signAsync(defaultAccountsSr25519.eve))

  await client.dev.newBlock()

  await checkEvents(bondExtraEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId|stash/ })
    .toMatchSnapshot('bond extra funds events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after extra funds are bonded')

  const nominationPoolWithExtraBond = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithMembers, nominationPoolWithExtraBond, ['points'])
  expect(nominationPoolWithExtraBond.points.toNumber(), 'Incorrect pool point count after bond_extra').toBe(
    depositorMinBond + 2 * minJoinBond - 1,
  )

  /**
   * Claim commission as a random account - commission claim was set to permissionless.
   *
   * Commission is still 0 at this point, so the extrinsic will fail; the goal is to test the process.
   */

  const claimCommissionTx = client.api.tx.nominationPools.claimCommission(nomPoolId)
  await sendTransaction(claimCommissionTx.signAsync(ferdie))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'claim commission events',
  )

  let events = await client.api.query.system.events()

  expect(
    events.filter((record) => {
      const { event } = record
      return event.section === 'nominationPools'
    }).length,
    'claiming a fresh pool\'s commission will not emit any "nomination pools" events, as it the extrinsic fails',
  ).toBe(0)

  const [systemEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(systemEvent.event))
  let dispatchError = systemEvent.event.data.dispatchError

  assert(dispatchError.isModule)
  // Even though the pool has no commission to claim, the extrinsic should fail with this error,
  // and not an access error due to Ferdie claiming the commission - the commission claim is permissionless.
  assert(client.api.errors.nominationPools.NoPendingCommission.is(dispatchError.asModule))

  /**
   * Unbond previously bonded funds
   */

  const unbondTx = client.api.tx.nominationPools.unbond(defaultAccountsSr25519.eve.address, minJoinBond - 1)
  const unbondEvents = await sendTransaction(unbondTx.signAsync(defaultAccountsSr25519.eve))

  await client.dev.newBlock()

  await checkEvents(unbondEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId|stash|era/ })
    .toMatchSnapshot('unbond events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after funds are unbonded').toBe(true)
  const nominationPoolPostUnbond = poolData.unwrap()

  expect(nominationPoolPostUnbond.points).toBe(depositorMinBond + minJoinBond)
  nominationPoolCmp(nominationPoolWithExtraBond, nominationPoolPostUnbond, ['points'])

  /**
   * As the pool's nominator, call `chill`
   */

  const chillTx = client.api.tx.nominationPools.chill(nomPoolId)
  const chillEvents = await sendTransaction(chillTx.signAsync(defaultAccountsSr25519.charlie))

  await client.dev.newBlock()

  // TODO: Like `nominate`, `chill` also does not emit any nomination pool events.
  // [#7377](https://github.com/paritytech/polkadot-sdk/pull/7377) also fixes this.
  await checkEvents(chillEvents, 'nominationPools', 'staking', 'system')
    .redact({ removeKeys: /poolId|stash/ })
    .toMatchSnapshot('chill events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after chill').toBe(true)

  const nominationPoolPostChill = poolData.unwrap()

  nominationPoolCmp(nominationPoolPostUnbond, nominationPoolPostChill, [])

  /**
   * Set pool state to blocked
   */

  const setStateTx = client.api.tx.nominationPools.setState(nomPoolId, 'Blocked')
  const setStateEvents = await sendTransaction(setStateTx.signAsync(defaultAccountsSr25519.bob))

  await client.dev.newBlock()

  await checkEvents(setStateEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('set state events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after state is changed').toBe(true)

  const nominationPoolBlocked = poolData.unwrap()

  expect(nominationPoolBlocked.state.isBlocked, 'Pool state should now be blocked').toBe(true)
  nominationPoolCmp(nominationPoolPostUnbond, nominationPoolBlocked, ['state'])

  /**
   * Kick a member from the pool as the bouncer
   */

  const kickTx = client.api.tx.nominationPools.unbond(defaultAccountsSr25519.eve.address, minJoinBond)
  const kickEvents = await sendTransaction(kickTx.signAsync(defaultAccountsSr25519.dave))

  await client.dev.newBlock()

  await checkEvents(kickEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId|stash|era/ })
    .toMatchSnapshot('unbond (kick) events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after bouncer-unbond').toBe(true)
  const nominationPoolPostKick = poolData.unwrap()

  nominationPoolCmp(nominationPoolBlocked, nominationPoolPostKick, ['points'])
  expect(nominationPoolPostKick.points.toNumber()).toBe(depositorMinBond)
  // Although the bouncer has forcefully unbonded the member, they are still counted as a member
  // until the unbonding period (28/7 eras (Polkadot/Kusama)) has passed, and they withdraw.
  expect(nominationPoolPostKick.memberCounter.toNumber()).toBe(2)

  /**
   * Set pool state to `Destroying`
   */

  const setDestroyingTx = client.api.tx.nominationPools.setState(nomPoolId, 'Destroying')
  const setDestroyingEvents = await sendTransaction(setDestroyingTx.signAsync(defaultAccountsSr25519.bob))

  await client.dev.newBlock()

  await checkEvents(setDestroyingEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('set state to destroying events')

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome, 'Pool should still exist after state is changed').toBe(true)

  const nominationPoolDestroying = poolData.unwrap()
  expect(nominationPoolDestroying.state.isDestroying).toBe(true)
  nominationPoolCmp(nominationPoolPostKick, nominationPoolDestroying, ['state'])

  /**
   * Unbond as depositor - allowed as the pool is set to destroying
   *
   * At this point in time, this operation will fail, as the previous depositor began the unbonding
   * process, but has not fully unbonded and withdrawn their funds.
   */

  const unbondDepositorTx = client.api.tx.nominationPools.unbond(defaultAccountsSr25519.alice.address, depositorMinBond)
  await sendTransaction(unbondDepositorTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'unbond (depositor) events',
  )

  /// Process events to look for the expected extrinsic error.

  events = await client.api.query.system.events()

  // Collect the `system` event with the `ExtrinsicFailed` information.
  const [systemEv] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(systemEv.event))
  dispatchError = systemEv.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.nominationPools.MinimumBondNotMet.is(dispatchError.asModule))

  /// Check that the pool state is unchanged after the failed unbonding attempt.

  poolData = await client.api.query.nominationPools.bondedPools(nomPoolId)
  expect(poolData.isSome).toBe(true)

  const nominationPoolPostDepositorUnbond = poolData.unwrap()
  nominationPoolCmp(nominationPoolDestroying, nominationPoolPostDepositorUnbond, [])
}

/**
 * Test setting a pool's metadata, checking it beforehand to see that a new pool's metadata is an empty string
 * of bytes.
 * @param chain
 */
async function nominationPoolSetMetadataTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  const preLastPoolId = (await client.api.query.nominationPools.lastPoolId()).toNumber()

  const createNomPoolEvents = await createNominationPool(
    client,
    defaultAccountsSr25519.alice,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.alice.address,
  )

  /// Check that prior to the pool creation extrinsic taking effect, the pool does not yet exist with the
  /// most recently available pool ID.
  const poolData: Option<PalletNominationPoolsBondedPoolInner> = await client.api.query.nominationPools.bondedPools(
    preLastPoolId + 1,
  )
  expect(poolData.isNone, 'Pool should not exist before block is applied').toBe(true)

  await client.dev.newBlock()

  const removedKeys = /poolId|stash/
  await checkEvents(createNomPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: removedKeys })
    .toMatchSnapshot('create nomination pool events')

  /// Check metadata pre-alteration

  const nomPoolId = preLastPoolId + 1

  let metadata = await client.api.query.nominationPools.metadata(nomPoolId)

  expect(metadata.toString(), 'Pool should not have metadata').toBe('')

  /// Set pool's metadata

  const setMetadataTx = client.api.tx.nominationPools.setMetadata(nomPoolId, 'Test pool #1, welcome')
  const setMetadataEvents = await sendTransaction(setMetadataTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkEvents(setMetadataEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('set metadata events')

  /// Check the set metadata

  metadata = await client.api.query.nominationPools.metadata(nomPoolId)

  expect(metadata.toString(), 'Pool should have the correct metadata set').toBe('Test pool #1, welcome')
}

/**
 * Test that joining a pool prevents an account from joining another.
 *
 */
async function nominationPoolDoubleJoinError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  const preLastPoolId = (await client.api.query.nominationPools.lastPoolId()).toNumber()
  const firstPoolId = preLastPoolId + 1

  await createNominationPool(
    client,
    defaultAccountsSr25519.alice,
    defaultAccountsSr25519.bob.address,
    defaultAccountsSr25519.charlie.address,
    defaultAccountsSr25519.dave.address,
  )

  await client.dev.newBlock()

  /**
   * Have Eve join the pool
   */

  await client.dev.setStorage({
    System: {
      account: [
        [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccountsSr25519.eve.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const minJoinBond = await client.api.query.nominationPools.minJoinBond()

  const joinPoolTx = client.api.tx.nominationPools.join(minJoinBond, firstPoolId)
  const joinPoolEvents = await sendTransaction(joinPoolTx.signAsync(defaultAccountsSr25519.eve))

  await client.dev.newBlock()

  await checkEvents(joinPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId|stash/ })
    .toMatchSnapshot('join nomination pool events')

  let poolData = await client.api.query.nominationPools.bondedPools(firstPoolId)
  expect(poolData.isSome, 'Pool should still exist after new member joins').toBe(true)

  const nominationPoolWithMembers = poolData.unwrap()
  expect(nominationPoolWithMembers.memberCounter.toNumber(), 'Pool should have 2 members').toBe(2)

  /**
   * Create a second pool
   */

  /// The depositor in the second pool cannot be Alice, as that would also be a double join - precisely the object of this test.
  await createNominationPool(
    client,
    defaultAccountsSr25519.bob,
    defaultAccountsSr25519.alice.address,
    defaultAccountsSr25519.charlie.address,
    defaultAccountsSr25519.dave.address,
  )

  await client.dev.newBlock()

  const secondPoolId = firstPoolId + 1

  /**
   * Try having Eve join the second pool
   */

  const joinSecondPoolTx = client.api.tx.nominationPools.join(minJoinBond, secondPoolId)
  await sendTransaction(joinSecondPoolTx.signAsync(defaultAccountsSr25519.eve))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'join second nomination pool events',
  )

  // As before, scrutinize the cause of failure for `pallet_nomination_pools::join`.

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.nominationPools.AccountBelongsToOtherPool.is(dispatchError.asModule))

  /**
   * Check that Eve is still a member of the first pool
   */

  poolData = await client.api.query.nominationPools.bondedPools(firstPoolId)
  expect(poolData.isSome, 'Pool should still exist after failed join').toBe(true)

  const nominationPoolWithMembersAfterError = poolData.unwrap()
  expect(nominationPoolWithMembersAfterError.memberCounter.toNumber(), 'Pool should have 2 members').toBe(2)

  /**
   * Check that Eve is not a member of the second pool
   */

  poolData = await client.api.query.nominationPools.bondedPools(secondPoolId)
  expect(poolData.isSome, 'Pool should still exist after failed join').toBe(true)

  const secondNominationPoolAfterFailedJoin = poolData.unwrap()
  expect(secondNominationPoolAfterFailedJoin.memberCounter.toNumber(), 'Pool should have 1 member').toBe(1)
}

/**
 * Test setting global nomination pool parameters.
 *
 * First, this extrinsic is attempted with a signed origin.
 *
 * After that, it is ran by inserting a call with it into the scheduler pallet's storage.
 * This is to be done for Polkadot and Kusama's `AdminOrigin`,
 * which at the time of writing (Jan. 2025) is either `Root` or `StakingAdmin`.
 *
 * Pending a resolution to [this SE question](https://substrate.stackexchange.com/questions/12181/how-to-use-chopsticks-to-test-a-call-with-stakingadmin-origin),
 * this test only uses the `Root` origin.
 */
async function nominationPoolGlobalConfigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  const one = new u32(client.api.registry, 1)

  const preMinJoinBond = (await client.api.query.nominationPools.minJoinBond()).toNumber()
  const preMinCreateBond = (await client.api.query.nominationPools.minCreateBond()).toNumber()
  const preMaxPoolsOpt = (await client.api.query.nominationPools.maxPools()).unwrapOr(one).toNumber()
  const preMaxMembersOpt = (await client.api.query.nominationPools.maxPoolMembers()).unwrapOr(one).toNumber()
  const preMaxMembersPerPool = (await client.api.query.nominationPools.maxPoolMembersPerPool()).unwrapOr(one).toNumber()
  const preGlobalMaxCommission = (await client.api.query.nominationPools.globalMaxCommission()).unwrapOr(one).toNumber()

  // Attempt to modify nomination pool global parameters with a signed origin - this should fail.

  const setConfigsCall = (inc: number) =>
    client.api.tx.nominationPools.setConfigs(
      { Set: preMinJoinBond + inc },
      { Set: preMinCreateBond + inc },
      { Set: preMaxPoolsOpt + inc },
      { Set: preMaxMembersOpt + inc },
      { Set: preMaxMembersPerPool + inc },
      { Set: preGlobalMaxCommission + inc },
    )
  await sendTransaction(setConfigsCall(0).signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'setting global nomination pool configs with signed origin',
  )

  // Set global configs using the scheduler pallet to simulate `Root/StakingAdmin` origins.

  type Origin = { system: string } | { Origins: string }
  type OriginsAndIncrements = [Origin, number]

  const originsAndIncrements: OriginsAndIncrements[] = [
    [{ system: 'Root' }, 1],
    [{ Origins: 'StakingAdmin' }, 2],
  ]

  for (const [origin, inc] of originsAndIncrements) {
    await scheduleInlineCallWithOrigin(client, setConfigsCall(inc).method.toHex(), origin)

    await client.dev.newBlock()

    checkSystemEvents(client, 'nominationPools').toMatchSnapshot()

    const postMinJoinBond = (await client.api.query.nominationPools.minJoinBond()).toNumber()
    const postMinCreateBond = (await client.api.query.nominationPools.minCreateBond()).toNumber()
    // None of the below can be `None`, as here it is assumed that the extrinsic above succeeded in setting them.
    // They can be safely unwrapped.
    const postMaxPoolsOpt = (await client.api.query.nominationPools.maxPools()).unwrap().toNumber()
    const postMaxMembersOpt = (await client.api.query.nominationPools.maxPoolMembers()).unwrap().toNumber()
    const postMaxMembersPerPool = (await client.api.query.nominationPools.maxPoolMembersPerPool()).unwrap().toNumber()
    const postGlobalMaxCommission = (await client.api.query.nominationPools.globalMaxCommission()).unwrap().toNumber()

    expect(postMinJoinBond).toBe(preMinJoinBond + inc)
    expect(postMinCreateBond).toBe(preMinCreateBond + inc)
    expect(postMaxPoolsOpt).toBe(preMaxPoolsOpt + inc)
    expect(postMaxMembersOpt).toBe(preMaxMembersOpt + inc)
    expect(postMaxMembersPerPool).toBe(preMaxMembersPerPool + inc)
    expect(postGlobalMaxCommission).toBe(preGlobalMaxCommission + inc)
  }
}

/**
 * Test to `update_roles` extrinsic.
 *
 * 1. First, it is used to change a pool's roles, as the pool's (then current) root.
 * 2. Then, the previous root tries and fails to change the roles of the pool.
 * 3. The new root changes the roles of the pool, removing itself as root and setting it as `None`.
 * 4. A call to `update_roles` is inserted into the scheduler pallet's storage with a `Root` origin, which should
 *    allow it to run successfully in the next block; this is because at this stage, the pool has no root.
 */
async function nominationPoolsUpdateRolesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  const preLastPoolId = (await client.api.query.nominationPools.lastPoolId()).toNumber()
  const poolId = preLastPoolId + 1

  /**
   * Create the pool - here, Bob is the initial root.
   */

  await createNominationPool(
    client,
    defaultAccountsSr25519.alice,
    defaultAccountsSr25519.bob.address,
    defaultAccountsSr25519.charlie.address,
    defaultAccountsSr25519.dave.address,
  )

  await client.dev.newBlock()

  let poolData = await client.api.query.nominationPools.bondedPools(poolId)
  assert(poolData.isSome, 'Pool should exist after creation')

  const nominationPool = poolData.unwrap()

  await check(nominationPool.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: encodeAddress(defaultAccountsSr25519.bob.address, addressEncoding),
    nominator: encodeAddress(defaultAccountsSr25519.charlie.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.dave.address, addressEncoding),
  })

  /**
   * Change the pool's roles as the pool's current root - now Alice will be the root, though Bob's the one who
   * must sign this transaction.
   */

  await client.dev.setStorage({
    System: {
      account: [[[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: 10000e10 } }]],
    },
  })

  const updateRolesTx = client.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccountsSr25519.alice.address },
    { Set: defaultAccountsSr25519.dave.address },
    { Set: defaultAccountsSr25519.bob.address },
  )
  const updateRolesEvents = await sendTransaction(updateRolesTx.signAsync(defaultAccountsSr25519.bob))

  await client.dev.newBlock()

  await checkEvents(updateRolesEvents, 'nominationPools').toMatchSnapshot('update roles events')

  poolData = await client.api.query.nominationPools.bondedPools(poolId)
  expect(poolData.isSome, 'Pool should still exist after roles are updated').toBe(true)

  const nominationPoolWithRoles = poolData.unwrap()

  nominationPoolCmp(nominationPool, nominationPoolWithRoles, ['roles'])

  await check(nominationPoolWithRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccountsSr25519.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.bob.address, addressEncoding),
  })

  /**
   * Try and fail to change the pool's roles as the previous root
   */

  const updateRolesFailTx = client.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccountsSr25519.eve.address },
    { Set: defaultAccountsSr25519.eve.address },
    { Set: defaultAccountsSr25519.eve.address },
  )
  await sendTransaction(updateRolesFailTx.signAsync(defaultAccountsSr25519.bob))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'update roles failure events',
  )

  let events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.nominationPools.DoesNotHavePermission.is(dispatchError.asModule))

  /**
   * As the pool's newly set root, remove oneself from the role.
   */

  const updateRolesRemoveSelfTx = client.api.tx.nominationPools.updateRoles(
    poolId,
    { Remove: null },
    { Noop: null },
    { Noop: null },
  )
  const updateRolesRemoveSelfEvents = await sendTransaction(
    updateRolesRemoveSelfTx.signAsync(defaultAccountsSr25519.alice),
  )

  await client.dev.newBlock()

  await checkEvents(updateRolesRemoveSelfEvents, 'nominationPools').toMatchSnapshot('update roles remove self events')

  poolData = await client.api.query.nominationPools.bondedPools(poolId)
  expect(poolData.isSome, 'Pool should still exist after roles are updated').toBe(true)

  const nominationPoolWithoutRoot = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithRoles, nominationPoolWithoutRoot, ['roles'])

  await check(nominationPoolWithoutRoot.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: null,
    nominator: encodeAddress(defaultAccountsSr25519.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.bob.address, addressEncoding),
  })

  /**
   * Set the pool's roles via scheduler pallet, with a `Root` origin.
   */

  const updateRolesCall = client.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccountsSr25519.charlie.address },
    { Set: defaultAccountsSr25519.dave.address },
    { Set: defaultAccountsSr25519.eve.address },
  )

  await scheduleInlineCallWithOrigin(client, updateRolesCall.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  const nomPoolsEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'nominationPools'
  })

  await check(nomPoolsEvents, 'nominationPools').toMatchSnapshot('update pool roles via scheduler pallet')

  poolData = await client.api.query.nominationPools.bondedPools(poolId)
  expect(poolData.isSome, 'Pool should still exist after roles are updated').toBe(true)

  const nominationPoolUpdatedRoles = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithoutRoot, nominationPoolUpdatedRoles, ['roles'])

  await check(nominationPoolUpdatedRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccountsSr25519.alice.address, addressEncoding),
    root: encodeAddress(defaultAccountsSr25519.charlie.address, addressEncoding),
    nominator: encodeAddress(defaultAccountsSr25519.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccountsSr25519.eve.address, addressEncoding),
  })
}

export function baseNominationPoolsE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStoragesRelay>,
  testConfig: { testSuiteName: string; addressEncoding: number },
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'nomination pool lifecycle test',
        testFn: async () => await nominationPoolLifecycleTest(chain, testConfig.addressEncoding),
      },
      {
        kind: 'test',
        label: 'nomination pool creation with insufficient funds',
        testFn: async () => await nominationPoolCreationFailureTest(chain),
      },
      {
        kind: 'test',
        label: 'nomination pool metadata test',
        testFn: async () => await nominationPoolSetMetadataTest(chain),
      },
      {
        kind: 'test',
        label: 'nomination pool double join test: an account can only ever be in one pool at a time',
        testFn: async () => await nominationPoolDoubleJoinError(chain),
      },
      {
        kind: 'test',
        label: 'nomination pool global config test',
        testFn: async () => await nominationPoolGlobalConfigTest(chain),
      },
      {
        kind: 'test',
        label: 'nomination pools update roles test',
        testFn: async () => await nominationPoolsUpdateRolesTest(chain, testConfig.addressEncoding),
      },
    ],
  }
}
