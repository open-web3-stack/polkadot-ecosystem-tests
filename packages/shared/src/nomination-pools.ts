import { encodeAddress } from '@polkadot/util-crypto'

import { type Chain, defaultAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { check, checkEvents, objectCmp } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { ApiPromise } from '@polkadot/api'
import type { KeyringPair } from '@polkadot/keyring/types'
import { type Option, u32 } from '@polkadot/types'
import type { PalletNominationPoolsBondedPoolInner, PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
import type { Codec } from '@polkadot/types/types'
import { assert, describe, test } from 'vitest'

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
  relayClient: { api: ApiPromise },
  signer: KeyringPair,
  root: string,
  nominator: string,
  bouncer: string,
): Promise<{ events: Promise<Codec[]> }> {
  const minJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = relayClient.api.consts.balances.existentialDeposit.toNumber()

  const depositorBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  const createNomPoolTx = relayClient.api.tx.nominationPools.create(depositorBond, root, nominator, bouncer)
  const createNomPoolEvents = sendTransaction(createNomPoolTx.signAsync(signer))

  return createNomPoolEvents
}

/**
 * Select some validators from the list present in the `Validators` storage item, in the `Staking` pallet.
 *
 * To avoid fetching all validators at once (over a thousand in Jan. 2025), only the first page of validators
 * in storage is considered - the size of the page is provided as an argument.
 *
 * If, in the validator page of the selected size, less than `validatorCount` validators are available, the function
 * will get as close to `validatorCount` as possible.
 *
 * @param api PJS client object.
 * @param pageSize The size of the page to fetch from storage.
 * @param validatorCount The (desired) number of validators to select.
 * @returns A list of at least 1 validator, and at most 16.
 */
async function getValidators(api: ApiPromise, pageSize: number, validatorCount: number) {
  // Between 1 and 16 validators can be nominated by the pool at any time.
  const min_validators = 1
  const max_validators = 16

  assert(pageSize >= max_validators)
  assert(min_validators <= validatorCount && validatorCount <= max_validators)

  // Query the list of validators from the `Validators` storage item in the `staking` pallet.
  const validators = await api.query.staking.validators.entriesPaged({ args: [], pageSize: pageSize })

  const validatorIds: [string, PalletStakingValidatorPrefs][] = validators.map((tuple) => [
    tuple[0].args[0].toString(),
    tuple[1],
  ])

  const selectedValidators: string[] = []

  let ix = 0
  let count = 0
  while (count < validatorCount) {
    const [valAddr, valData] = validatorIds[ix]

    // The pool's nominator should only select validators who still allow for nominators
    // to select them i.e. they have not blocked themselves.
    if (valData.blocked.isFalse) {
      selectedValidators.push(valAddr)
      count += 1
    }

    ix += 1
  }

  assert(selectedValidators.length >= min_validators && selectedValidators.length <= max_validators)

  return selectedValidators
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
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  const minJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = relayClient.api.consts.balances.existentialDeposit.toNumber()

  const depositorMinBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  // Attempt to create a pool with insufficient funds
  const createNomPoolTx = relayClient.api.tx.nominationPools.create(
    depositorMinBond - 1,
    defaultAccounts.alice.address,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address,
  )
  const createNomPoolEvents = await sendTransaction(createNomPoolTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(createNomPoolEvents, 'system')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('create nomination pool with insufficient funds events')

  /// Process events

  const events = await relayClient.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(relayClient.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(relayClient.api.errors.nominationPools.MinimumBondNotMet.is(dispatchError.asModule))
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
 * @param relayChain
 * @param addressEncoding
 */
async function nominationPoolLifecycleTest(relayChain, addressEncoding: number) {
  const [relayClient] = await setupNetworks(relayChain)

  const ferdie = defaultAccounts.keyring.addFromUri('//Ferdie')

  // Fund test accounts not already provisioned in the test chain spec.
  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccounts.charlie.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccounts.dave.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10000e10 } }],
        [[ferdie.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const preLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()

  // Obtain the minimum deposit required to create a pool, as calculated by `pallet_nomination_poola::create`.
  const minJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = relayClient.api.consts.balances.existentialDeposit.toNumber()

  const depositorMinBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  /**
   * Create pool with sufficient funds
   */

  const createNomPoolTx = relayClient.api.tx.nominationPools.create(
    depositorMinBond,
    defaultAccounts.alice.address,
    defaultAccounts.alice.address,
    defaultAccounts.alice.address,
  )
  const createNomPoolEvents = await sendTransaction(createNomPoolTx.signAsync(defaultAccounts.alice))

  /// Check that prior to the block taking effect, the pool does not yet exist with the
  /// most recently available pool ID.
  let poolData: Option<PalletNominationPoolsBondedPoolInner> = await relayClient.api.query.nominationPools.bondedPools(
    preLastPoolId + 1,
  )
  assert(poolData.isNone, 'Pool should not exist before block is applied')

  await relayClient.dev.newBlock()

  await checkEvents(createNomPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('create nomination pool events')

  /// Check status of created pool

  const nomPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()
  assert(preLastPoolId + 1 === nomPoolId, 'Pool ID should be most recently available number + 1')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should exist after block is applied')

  const nominationPoolPostCreation = poolData.unwrap()
  await check(nominationPoolPostCreation.commission).toMatchObject({
    current: null,
    max: null,
    changeRate: null,
    throttleFrom: null,
    claimPermission: null,
  })
  assert(nominationPoolPostCreation.memberCounter.eq(1), 'Pool should have 1 member')
  assert(nominationPoolPostCreation.points.eq(depositorMinBond), 'Pool should have `deposit_min_bond` points')
  await check(nominationPoolPostCreation.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.alice.address, addressEncoding),
  })
  assert(nominationPoolPostCreation.state.isOpen, 'Pool should be open after creation')

  /**
   * Update pool roles
   */

  const updateRolesTx = relayClient.api.tx.nominationPools.updateRoles(
    nomPoolId,
    { Set: defaultAccounts.bob.address },
    { Set: defaultAccounts.charlie.address },
    { Set: defaultAccounts.dave.address },
  )
  const updateRolesEvents = await sendTransaction(updateRolesTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(updateRolesEvents, 'staking', 'nominationPools').toMatchSnapshot('update roles events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after roles are updated')

  const nominationPoolWithRoles = poolData.unwrap()
  nominationPoolCmp(nominationPoolPostCreation, nominationPoolWithRoles, ['roles'])

  await check(nominationPoolWithRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.bob.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.charlie.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.dave.address, addressEncoding),
  })

  /**
   * Set the pool's commission data
   */

  // This will be `Perbill` runtime-side, so 0.1%
  const commission = 10e5

  const setCommissionTx = relayClient.api.tx.nominationPools.setCommission(nomPoolId, [
    commission,
    defaultAccounts.eve.address,
  ])

  const setCommissionMaxTx = relayClient.api.tx.nominationPools.setCommissionMax(nomPoolId, commission * 10)

  const setCommissionChangeRateTx = relayClient.api.tx.nominationPools.setCommissionChangeRate(nomPoolId, {
    maxIncrease: 10e8,
    minDelay: 10,
  })

  const setCommissionClaimPermissionTx = relayClient.api.tx.nominationPools.setCommissionClaimPermission(
    nomPoolId,
    'Permissionless',
  )

  const commissionTx = relayClient.api.tx.utility.batchAll([
    setCommissionTx,
    setCommissionMaxTx,
    setCommissionChangeRateTx,
    setCommissionClaimPermissionTx,
  ])
  const commissionEvents = await sendTransaction(commissionTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(commissionEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('commission alteration events')

  /// Check that all commission data were set correctly
  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after commission is changed')

  const blockNumber = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  const nominationPoolWithCommission = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithRoles, nominationPoolWithCommission, ['commission'])

  const newCommissionData = {
    max: commission * 10,
    current: [commission, encodeAddress(defaultAccounts.eve.address, addressEncoding)],
    changeRate: {
      maxIncrease: 10e8,
      minDelay: 10,
    },
    throttleFrom: blockNumber,
    claimPermission: { permissionless: null },
  }

  await check(nominationPoolWithCommission.commission).toMatchObject(newCommissionData)

  /**
   * Nominate a validator set
   */

  const validators = await getValidators(relayClient.api, 100, 16)

  const nominateTx = relayClient.api.tx.nominationPools.nominate(nomPoolId, validators)
  const nominateEvents = await sendTransaction(nominateTx.signAsync(defaultAccounts.charlie))

  await relayClient.dev.newBlock()

  // TODO: `nominate` does not emit any events from `staking` or `nominationPools` as of
  // Jan. 2025. [#7377](https://github.com/paritytech/polkadot-sdk/pull/7377) will fix this.
  await checkEvents(nominateEvents, 'staking', 'nominationPools', 'system')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('nomination pool validator selection events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after validators are nominated')

  const nominationPoolAfterNomination = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithCommission, nominationPoolAfterNomination, [])

  /**
   * Have another account join the pool
   */

  const joinPoolTx = relayClient.api.tx.nominationPools.join(minJoinBond, nomPoolId)
  const joinPoolEvents = await sendTransaction(joinPoolTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(joinPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('join nomination pool events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after new member joins')

  const nominationPoolWithMembers = poolData.unwrap()
  assert(nominationPoolWithMembers.memberCounter.eq(2), 'Pool should have 2 members')
  assert(
    nominationPoolWithMembers.points.eq(depositorMinBond + minJoinBond),
    'Pool should have `depositor_min_bond + min_join_bond` points',
  )

  nominationPoolCmp(nominationPoolWithCommission, nominationPoolWithMembers, ['memberCounter', 'points'])

  /**
   * Bond additional funds as Eve
   */

  const bondExtraTx = relayClient.api.tx.nominationPools.bondExtra({ FreeBalance: minJoinBond - 1 })
  const bondExtraEvents = await sendTransaction(bondExtraTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(bondExtraEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('bond extra funds events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after extra funds are bonded')

  const nominationPoolWithExtraBond = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithMembers, nominationPoolWithExtraBond, ['points'])
  assert(
    nominationPoolWithExtraBond.points.eq(depositorMinBond + 2 * minJoinBond - 1),
    'Incorrect pool point count after bond_extra',
  )

  /**
   * Claim commission as a random account - commission claim was set to permissionless.
   *
   * Commission is still 0 at this point, so the extrinsic will fail; the goal is to test the process.
   */

  const claimCommissionTx = relayClient.api.tx.nominationPools.claimCommission(nomPoolId)
  const claimCommissionEvents = await sendTransaction(claimCommissionTx.signAsync(ferdie))

  await relayClient.dev.newBlock()

  await checkEvents(claimCommissionEvents, 'nominationPools', 'system').toMatchSnapshot('claim commission events')

  let events = await relayClient.api.query.system.events()

  assert(
    events.filter((record) => {
      const { event } = record
      return event.section === 'nominationPools'
    }).length === 0,
    'claiming a fresh pool\'s commission will not emit any "nomination pools" events, as it the extrinsic fails',
  )

  const [systemEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(relayClient.api.events.system.ExtrinsicFailed.is(systemEvent.event))
  let dispatchError = systemEvent.event.data.dispatchError

  assert(dispatchError.isModule)
  // Even though the pool has no commission to claim, the extrinsic should fail with this error,
  // and not an access error due to Ferdie claiming the commission - the commission claim is permissionless.
  assert(relayClient.api.errors.nominationPools.NoPendingCommission.is(dispatchError.asModule))

  /**
   * Unbond previously bonded funds
   */

  const unbondTx = relayClient.api.tx.nominationPools.unbond(defaultAccounts.eve.address, minJoinBond - 1)
  const unbondEvents = await sendTransaction(unbondTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(unbondEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('unbond events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after funds are unbonded')
  const nominationPoolPostUnbond = poolData.unwrap()

  assert(nominationPoolPostUnbond.points.eq(depositorMinBond + minJoinBond))
  nominationPoolCmp(nominationPoolWithExtraBond, nominationPoolPostUnbond, ['points'])

  /**
   * As the pool's nominator, call `chill`
   */

  const chillTx = relayClient.api.tx.nominationPools.chill(nomPoolId)
  const chillEvents = await sendTransaction(chillTx.signAsync(defaultAccounts.charlie))

  await relayClient.dev.newBlock()

  // TODO: Like `nominate`, `chill` also does not emit any nomination pool events.
  // [#7377](https://github.com/paritytech/polkadot-sdk/pull/7377) also fixes this.
  await checkEvents(chillEvents, 'nominationPools', 'staking', 'system')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('chill events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after chill')

  const nominationPoolPostChill = poolData.unwrap()

  nominationPoolCmp(nominationPoolPostUnbond, nominationPoolPostChill, [])

  /**
   * Set pool state to blocked
   */

  const setStateTx = relayClient.api.tx.nominationPools.setState(nomPoolId, 'Blocked')
  const setStateEvents = await sendTransaction(setStateTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(setStateEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('set state events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after state is changed')

  const nominationPoolBlocked = poolData.unwrap()

  assert(nominationPoolBlocked.state.isBlocked, 'Pool state should now be blocked')
  nominationPoolCmp(nominationPoolPostUnbond, nominationPoolBlocked, ['state'])

  /**
   * Kick a member from the pool as the bouncer
   */

  const kickTx = relayClient.api.tx.nominationPools.unbond(defaultAccounts.eve.address, minJoinBond)
  const kickEvents = await sendTransaction(kickTx.signAsync(defaultAccounts.dave))

  await relayClient.dev.newBlock()

  await checkEvents(kickEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('unbond (kick) events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after bouncer-unbond')
  const nominationPoolPostKick = poolData.unwrap()

  nominationPoolCmp(nominationPoolBlocked, nominationPoolPostKick, ['points'])
  assert(nominationPoolPostKick.points.eq(depositorMinBond))
  // Although the bouncer has forcefully unbonded the member, they are still counted as a member
  // until the unbonding period (28/7 eras (Polkadot/Kusama)) has passed, and they withdraw.
  assert(nominationPoolPostKick.memberCounter.eq(2))

  /**
   * Set pool state to `Destroying`
   */

  const setDestroyingTx = relayClient.api.tx.nominationPools.setState(nomPoolId, 'Destroying')
  const setDestroyingEvents = await sendTransaction(setDestroyingTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(setDestroyingEvents, 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('set state to destroying events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome, 'Pool should still exist after state is changed')

  const nominationPoolDestroying = poolData.unwrap()
  assert(nominationPoolDestroying.state.isDestroying)
  nominationPoolCmp(nominationPoolPostKick, nominationPoolDestroying, ['state'])

  /**
   * Unbond as depositor - allowed as the pool is set to destroying
   *
   * At this point in time, this operation will fail, as the previous depositor began the unbonding
   * process, but has not fully unbonded and withdrawn their funds.
   */

  const unbondDepositorTx = relayClient.api.tx.nominationPools.unbond(defaultAccounts.alice.address, depositorMinBond)
  const unbondDepositorEvents = await sendTransaction(unbondDepositorTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(unbondDepositorEvents, 'system').toMatchSnapshot('unbond (depositor) events')

  /// Process events to look for the expected extrinsic error.

  events = await relayClient.api.query.system.events()

  // Collect the `system` event with the `ExtrinsicFailed` information.
  const [systemEv] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(relayClient.api.events.system.ExtrinsicFailed.is(systemEv.event))
  dispatchError = systemEv.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(relayClient.api.errors.nominationPools.MinimumBondNotMet.is(dispatchError.asModule))

  poolData = await relayClient.api.query.nominationPools.bondedPools(nomPoolId)
  assert(poolData.isSome)

  const nominationPoolPostDepositorUnbond = poolData.unwrap()
  nominationPoolCmp(nominationPoolDestroying, nominationPoolPostDepositorUnbond, [])
}

/**
 * Test setting a pool's metadata, checking it beforehand to see that a new pool's metadata is an empty string
 * of bytes.
 * @param relayChain
 */
async function nominationPoolSetMetadataTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  const preLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()

  const createNomPoolEvents = await createNominationPool(
    relayClient,
    defaultAccounts.alice,
    defaultAccounts.alice.address,
    defaultAccounts.alice.address,
    defaultAccounts.alice.address,
  )

  /// Check that prior to the pool creation extrinsic taking effect, the pool does not yet exist with the
  /// most recently available pool ID.
  const poolData: Option<PalletNominationPoolsBondedPoolInner> =
    await relayClient.api.query.nominationPools.bondedPools(preLastPoolId + 1)
  assert(poolData.isNone, 'Pool should not exist before block is applied')

  await relayClient.dev.newBlock()

  await checkEvents(createNomPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('create nomination pool events')

  /// Check metadata pre-alteration

  const nomPoolId = preLastPoolId + 1

  let metadata = await relayClient.api.query.nominationPools.metadata(nomPoolId)

  assert(metadata.eq(''), 'Pool should not have metadata')

  /// Set pool's metadata

  const setMetadataTx = relayClient.api.tx.nominationPools.setMetadata(nomPoolId, 'Test pool #1, welcome')
  const setMetadataEvents = await sendTransaction(setMetadataTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  /// TODO: no events are emitted here pending a PR to `pallet_nomination_pools`.
  await checkEvents(setMetadataEvents, 'nominationPools').toMatchSnapshot('set metadata events')

  /// Check the set metadata

  metadata = await relayClient.api.query.nominationPools.metadata(nomPoolId)

  assert(metadata.eq('Test pool #1, welcome'), 'Pool should have the correct metadata set')
}

/**
 * Test that joining a pool prevents an account from joining another.
 *
 */
async function nominationPoolDoubleJoinError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  const preLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()
  const firstPoolId = preLastPoolId + 1

  await createNominationPool(
    relayClient,
    defaultAccounts.alice,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address,
    defaultAccounts.dave.address,
  )

  await relayClient.dev.newBlock()

  /**
   * Have Eve join the pool
   */

  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const minJoinBond = await relayClient.api.query.nominationPools.minJoinBond()

  const joinPoolTx = relayClient.api.tx.nominationPools.join(minJoinBond, firstPoolId)
  const joinPoolEvents = await sendTransaction(joinPoolTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(joinPoolEvents, 'staking', 'nominationPools')
    .redact({ removeKeys: /poolId/ })
    .toMatchSnapshot('join nomination pool events')

  let poolData = await relayClient.api.query.nominationPools.bondedPools(firstPoolId)
  assert(poolData.isSome, 'Pool should still exist after new member joins')

  const nominationPoolWithMembers = poolData.unwrap()
  assert(nominationPoolWithMembers.memberCounter.eq(2), 'Pool should have 2 members')

  /**
   * Create a second pool
   */

  /// The depositor in the second pool cannot be Alice, as that would also be a double join - precisely the object of this test.
  await createNominationPool(
    relayClient,
    defaultAccounts.bob,
    defaultAccounts.alice.address,
    defaultAccounts.charlie.address,
    defaultAccounts.dave.address,
  )

  await relayClient.dev.newBlock()

  const secondPoolId = firstPoolId + 1

  /**
   * Try having Eve join the second pool
   */

  const joinSecondPoolTx = relayClient.api.tx.nominationPools.join(minJoinBond, secondPoolId)
  const joinSecondPoolEvents = await sendTransaction(joinSecondPoolTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(joinSecondPoolEvents, 'system').toMatchSnapshot('join second nomination pool events')

  // As before, scrutinize the cause of failure for `pallet_nomination_pools::join`.

  const events = await relayClient.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(relayClient.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(relayClient.api.errors.nominationPools.AccountBelongsToOtherPool.is(dispatchError.asModule))

  /**
   * Check that Eve is still a member of the first pool
   */

  poolData = await relayClient.api.query.nominationPools.bondedPools(firstPoolId)
  assert(poolData.isSome, 'Pool should still exist after failed join')

  const nominationPoolWithMembersAfterError = poolData.unwrap()
  assert(nominationPoolWithMembersAfterError.memberCounter.eq(2), 'Pool should have 2 members')

  /**
   * Check that Eve is not a member of the second pool
   */

  poolData = await relayClient.api.query.nominationPools.bondedPools(secondPoolId)
  assert(poolData.isSome, 'Pool should still exist after failed join')

  const secondNominationPoolAfterFailedJoin = poolData.unwrap()
  assert(secondNominationPoolAfterFailedJoin.memberCounter.eq(1), 'Pool should have 1 member')
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
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  const [relayClient] = await setupNetworks(relayChain)

  const one = new u32(relayClient.api.registry, 1)

  const preMinJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
  const preMinCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
  const preMaxPoolsOpt = (await relayClient.api.query.nominationPools.maxPools()).unwrapOr(one).toNumber()
  const preMaxMembersOpt = (await relayClient.api.query.nominationPools.maxPoolMembers()).unwrapOr(one).toNumber()
  const preMaxMembersPerPool = (await relayClient.api.query.nominationPools.maxPoolMembersPerPool())
    .unwrapOr(one)
    .toNumber()
  const preGlobalMaxCommission = (await relayClient.api.query.nominationPools.globalMaxCommission())
    .unwrapOr(one)
    .toNumber()

  // Attempt to modify nomination pool global parameters with a signed origin - this should fail.

  const setConfigsCall = (inc: number) =>
    relayClient.api.tx.nominationPools.setConfigs(
      { Set: preMinJoinBond + inc },
      { Set: preMinCreateBond + inc },
      { Set: preMaxPoolsOpt + inc },
      { Set: preMaxMembersOpt + inc },
      { Set: preMaxMembersPerPool + inc },
      { Set: preGlobalMaxCommission + inc },
    )
  const setConfigEvents = await sendTransaction(setConfigsCall(0).signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(setConfigEvents, 'nominationPools', 'system').toMatchSnapshot(
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
    const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

    await relayClient.dev.setStorage({
      Scheduler: {
        agenda: [
          [
            [number + 1],
            [
              {
                call: {
                  Inline: setConfigsCall(inc).method.toHex(),
                },
                origin: origin,
              },
            ],
          ],
        ],
      },
    })

    await relayClient.dev.newBlock()

    // Because this extrinsic was executed via the scheduler technique, its events won't be available
    // through `checkEvents` - hence the need for this event extraction process.
    const events = await relayClient.api.query.system.events()

    const nomPoolsEvents = events.filter((record) => {
      const { event } = record
      return event.section === 'nominationPools'
    })

    // TODO: `set_configs` does not emit events at this point. Fix this, after making a PR to `polkadot-sdk` and it flows downstream :)
    assert(nomPoolsEvents.length === 0, 'setting global nomination pool configs should emit 1 event')

    const postMinJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
    const postMinCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
    // None of the below can be `None`, as here it is assumed that the extrinsic above succeeded in setting them.
    // They can be safely unwrapped.
    const postMaxPoolsOpt = (await relayClient.api.query.nominationPools.maxPools()).unwrap().toNumber()
    const postMaxMembersOpt = (await relayClient.api.query.nominationPools.maxPoolMembers()).unwrap().toNumber()
    const postMaxMembersPerPool = (await relayClient.api.query.nominationPools.maxPoolMembersPerPool())
      .unwrap()
      .toNumber()
    const postGlobalMaxCommission = (await relayClient.api.query.nominationPools.globalMaxCommission())
      .unwrap()
      .toNumber()

    assert(postMinJoinBond === preMinJoinBond + inc)
    assert(postMinCreateBond === preMinCreateBond + inc)
    assert(postMaxPoolsOpt === preMaxPoolsOpt + inc)
    assert(postMaxMembersOpt === preMaxMembersOpt + inc)
    assert(postMaxMembersPerPool === preMaxMembersPerPool + inc)
    assert(postGlobalMaxCommission === preGlobalMaxCommission + inc)
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
>(relayChain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  const [relayClient] = await setupNetworks(relayChain)

  const preLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()
  const poolId = preLastPoolId + 1

  /**
   * Create the pool - here, Bob is the initial root.
   */

  await createNominationPool(
    relayClient,
    defaultAccounts.alice,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address,
    defaultAccounts.dave.address,
  )

  await relayClient.dev.newBlock()

  let poolData = await relayClient.api.query.nominationPools.bondedPools(poolId)
  assert(poolData.isSome, 'Pool should exist after creation')

  const nominationPool = poolData.unwrap()

  await check(nominationPool.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.bob.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.charlie.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.dave.address, addressEncoding),
  })

  /**
   * Change the pool's roles as the pool's current root - now Alice will be the root, though Bob's the one who
   * must sign this transaction.
   */

  await relayClient.dev.setStorage({
    System: {
      account: [[[defaultAccounts.bob.address], { providers: 1, data: { free: 10000e10 } }]],
    },
  })

  const updateRolesTx = relayClient.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccounts.alice.address },
    { Set: defaultAccounts.dave.address },
    { Set: defaultAccounts.bob.address },
  )
  const updateRolesEvents = await sendTransaction(updateRolesTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(updateRolesEvents, 'nominationPools').toMatchSnapshot('update roles events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(poolId)
  assert(poolData.isSome, 'Pool should still exist after roles are updated')

  const nominationPoolWithRoles = poolData.unwrap()

  nominationPoolCmp(nominationPool, nominationPoolWithRoles, ['roles'])

  await check(nominationPoolWithRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.bob.address, addressEncoding),
  })

  /**
   * Try and fail to change the pool's roles as the previous root
   */

  const updateRolesFailTx = relayClient.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccounts.eve.address },
    { Set: defaultAccounts.eve.address },
    { Set: defaultAccounts.eve.address },
  )
  const updateRolesFailEvents = await sendTransaction(updateRolesFailTx.signAsync(defaultAccounts.bob))

  await relayClient.dev.newBlock()

  await checkEvents(updateRolesFailEvents, 'system').toMatchSnapshot('update roles failure events')

  let events = await relayClient.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(relayClient.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(relayClient.api.errors.nominationPools.DoesNotHavePermission.is(dispatchError.asModule))

  /**
   * As the pool's newly set root, remove oneself from the role.
   */

  const updateRolesRemoveSelfTx = relayClient.api.tx.nominationPools.updateRoles(
    poolId,
    { Remove: null },
    { Noop: null },
    { Noop: null },
  )
  const updateRolesRemoveSelfEvents = await sendTransaction(updateRolesRemoveSelfTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(updateRolesRemoveSelfEvents, 'nominationPools').toMatchSnapshot('update roles remove self events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(poolId)
  assert(poolData.isSome, 'Pool should still exist after roles are updated')

  const nominationPoolWithoutRoot = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithRoles, nominationPoolWithoutRoot, ['roles'])

  await check(nominationPoolWithoutRoot.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: null,
    nominator: encodeAddress(defaultAccounts.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.bob.address, addressEncoding),
  })

  /**
   * Set the pool's roles via scheduler pallet, with a `Root` origin.
   */

  const updateRolesCall = relayClient.api.tx.nominationPools.updateRoles(
    poolId,
    { Set: defaultAccounts.charlie.address },
    { Set: defaultAccounts.dave.address },
    { Set: defaultAccounts.eve.address },
  )

  const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  await relayClient.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: updateRolesCall.method.toHex(),
              },
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  })

  await relayClient.dev.newBlock()

  events = await relayClient.api.query.system.events()

  const nomPoolsEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'nominationPools'
  })

  await check(nomPoolsEvents, 'nominationPools').toMatchSnapshot('update pool roles via scheduler pallet')

  poolData = await relayClient.api.query.nominationPools.bondedPools(poolId)
  assert(poolData.isSome, 'Pool should still exist after roles are updated')

  const nominationPoolUpdatedRoles = poolData.unwrap()

  nominationPoolCmp(nominationPoolWithoutRoot, nominationPoolUpdatedRoles, ['roles'])

  await check(nominationPoolUpdatedRoles.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.charlie.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.dave.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.eve.address, addressEncoding),
  })
}

export function nominationPoolsE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, () => {
    test('nomination pool lifecycle test', async () => {
      await nominationPoolLifecycleTest(relayChain, testConfig.addressEncoding)
    })

    test('nomination pool creation with insufficient funds', async () => {
      await nominationPoolCreationFailureTest(relayChain)
    })

    test('nomination pool metadata test', async () => {
      await nominationPoolSetMetadataTest(relayChain)
    })

    test('nomination pool double join test: an account can only ever be in one pool at a time', async () => {
      await nominationPoolDoubleJoinError(relayChain)
    })

    test('nomination pool global config test', async () => {
      await nominationPoolGlobalConfigTest(relayChain)
    })

    test('nomination pools update roles test', async () => {
      await nominationPoolsUpdateRolesTest(relayChain, testConfig.addressEncoding)
    })
  })
}
