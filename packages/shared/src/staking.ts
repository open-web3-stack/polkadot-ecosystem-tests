import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { BlockHash } from '@polkadot/types/interfaces'
import type { PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import BN from 'bn.js'
import { check, checkEvents, checkSystemEvents, expectPjsEqual, scheduleInlineCallWithOrigin } from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Locate the block number at which the current era ends.
 *
 * This is done by binary-searching through blocks, starting at the estimate obtained from
 * `api.derive.session.progress`, and stopping when `api.query.staking.activeEra` changes.
 *
 * Complexity: in essence, `O(1)` since `MAX` is fixed, but in practice,
 * `ceil(log_2(MAX))`.
 *
 * @returns The block number at which the current era ends, and following which a `staking.EraPaid` event
 * is emitted.
 */
async function locateEraChange(client: Client<any, any>): Promise<number | undefined> {
  const initialBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const activeEraOpt = await client.api.query.staking.activeEra()
  if (activeEraOpt.isNone) {
    // Nothing to do if there is no active era.
    return undefined
  }
  const activeEra = activeEraOpt.unwrap().index.toNumber()
  const previousEra = activeEra - 1

  // Estimate of active era start block.
  const eraProgress = await client.api.derive.session.eraProgress()

  // It is assumed that the active era changes at most this amount of blocks after the estimate provided
  // by `api.derive.session.progress`. Adjust as needed.
  const MAX = 512

  // Initial bounds for binary search.
  let lo = initialBlockNumber - eraProgress.toNumber() - 1
  let hi = Math.min(lo + MAX, initialBlockNumber)
  assert(lo < hi)

  let mid!: number
  let midBlockHash: BlockHash | undefined
  let eraAtMidBlock: number | undefined
  let eraAtNextBlock: number | undefined

  while (lo <= hi) {
    mid = lo + Math.floor((hi - lo) / 2)

    midBlockHash = await client.api.rpc.chain.getBlockHash(mid)
    const apiAt = await client.api.at(midBlockHash)
    if (apiAt === undefined) {
      console.warn('locateEraChange: apiAt is undefined for block ', mid)
      return undefined
    }

    eraAtMidBlock = (await apiAt.query.staking.activeEra()).unwrap().index.toNumber()

    // Check the next block to see if this is the transition point
    const nextBlockHash = await client.api.rpc.chain.getBlockHash(mid + 1)
    const apiAtNext = await client.api.at(nextBlockHash)
    if (apiAtNext === undefined) {
      console.warn('locateEraChange: apiAtNext is undefined for block ', mid + 1)
      return undefined
    }
    eraAtNextBlock = (await apiAtNext.query.staking.activeEra()).unwrap().index.toNumber()

    // If the transition point was found, return it
    if (eraAtMidBlock !== eraAtNextBlock) {
      return mid
    }

    // Otherwise continue binary search
    if (eraAtMidBlock === activeEra) {
      hi = mid - 1
    } else if (eraAtMidBlock === previousEra) {
      lo = mid + 1
    } else {
      // This really should never happen
      throw new Error('locateEraChange: eraAtMidBlock is neither activeEra nor previousEra')
    }
  }

  // If arrived here, a transition point was not found.
  return undefined
}

/// -------
/// -------
/// -------

/**
 * Test that it is not possible to validate before bonding funds.
 */
async function validateNoBondedFundsFailureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  // 1e7 is 1% commission
  const validateTx = client.api.tx.staking.validate({ commission: 1e7, blocked: false })
  await sendTransaction(validateTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'events when attempting to validate with no bonded funds',
  )

  /// Check event - the above extrinsic should have raised a `NotController` error.

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.staking.NotController.is(dispatchError.asModule))
}

/**
 * Test that it is not possible to nominate before bonding funds.
 */
async function nominateNoBondedFundsFailureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  // The empty list of targets is only checked *after* the extrinsic's origin, as it should,
  // so anything can be given here.
  const nominateTx = client.api.tx.staking.nominate([defaultAccountsSr25519.alice.address])
  await sendTransaction(nominateTx.signAsync(defaultAccountsSr25519.alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'events when attempting to nominate with no bonded funds',
  )

  /// Check event - the above extrinsic should have raised a `NotController` error.

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.staking.NotController.is(dispatchError.asModule))
}

/**
 * Staking lifecycle test.
 *
 * Stages:
 *
 * 1. account keypairs for tentative validators (Ed25519) are generated and funded
 * 2. these accounts bond their funds
 * 3. they then choose to become validators
 * 4. another account bonds funds
 * 5. this account bonds extra funds
 * 6. this account nominates the validators
 * 7. one of the validators chills itself
 * 8. this validator forcibly kicks its nomination
 * 9. this validator sets its preferences so that it is blocked
 * 10. the nominator tries to nominate the blocked validator
 * 11. the chilled validator unbonds all its funds
 */
async function stakingLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)
  ///
  /// Generate validators, and fund them.
  ///

  const validatorCount = 3

  const validators: KeyringPair[] = []

  for (let i = 0; i < validatorCount; i++) {
    const validator = defaultAccountsSr25519.keyring.addFromUri(`//Validator_${i}`)
    validators.push(validator)
  }

  await client.dev.setStorage({
    System: {
      account: validators.map((v) => [[v.address], { providers: 1, data: { free: 10000e10 } }]),
    },
  })

  ///
  /// Bond each validator's funds
  ///

  for (const [index, validator] of validators.entries()) {
    const bondTx = client.api.tx.staking.bond(5000e10, { Staked: null })
    const bondEvents = await sendTransaction(bondTx.signAsync(validator))

    await client.dev.newBlock()

    await checkEvents(bondEvents, 'staking').toMatchSnapshot(`validator ${index} bond events`)
  }

  // Use the network's minimum validator commission.
  const minValidatorCommission = await client.api.query.staking.minCommission()

  const eraNumberOpt = await client.api.query.staking.currentEra()
  assert(eraNumberOpt.isSome)
  const eraNumber = eraNumberOpt.unwrap()

  for (const [index, validator] of validators.entries()) {
    const validateTx = client.api.tx.staking.validate({ commission: minValidatorCommission, blocked: false })
    const validateEvents = await sendTransaction(validateTx.signAsync(validator))

    await client.dev.newBlock()

    await checkEvents(validateEvents, 'staking').toMatchSnapshot(`validator ${index} validate events`)

    const prefs: PalletStakingValidatorPrefs = await client.api.query.staking.validators(validator.address)
    const { commission, blocked } = prefs

    expect(commission.toNumber()).toBe(minValidatorCommission.toNumber())
    expect(blocked.isFalse).toBeTruthy()
  }

  ///
  /// Bond another account's funds
  ///

  const alice = defaultAccountsSr25519.alice

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const bondTx = client.api.tx.staking.bond(10000e10, { Staked: null })
  const bondEvents = await sendTransaction(bondTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(bondEvents, 'staking').toMatchSnapshot('nominator bond events')

  /// Bond extra funds

  // Necessary to avoid `ResponseError: {"invalid":{"stale":null}}` errors
  let aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  const bondExtraTx = client.api.tx.staking.bondExtra(10000e10)
  const bondExtraEvents = await sendTransaction(bondExtraTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  await checkEvents(bondExtraEvents, 'staking').toMatchSnapshot('nominator bond extra events')

  ///
  /// Nominate the validators
  ///

  const nominateTx = client.api.tx.staking.nominate(validators.map((v) => v.address))
  await sendTransaction(nominateTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  // nominate emits no events
  let events = await client.api.query.system.events()
  const nominateEvent = events.find((record) => {
    const { event } = record
    return event.section === 'staking'
  })
  expect(nominateEvent).toBeUndefined()

  /// Check the nominator's nominations

  let nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominations = nominationsOpt.unwrap()
  expect(nominations.submittedIn.toNumber()).toBe(eraNumber.toNumber())
  expect(nominations.suppressed.isFalse).toBeTruthy()
  expect(nominations.targets.length).toBe(validators.length)

  const targets = nominations.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  expect(validators.every((v) => targets.includes(encodeAddress(v.address, addressEncoding)))).toBe(true)

  ///
  /// Chill one of the validators
  ///

  const chillTx = client.api.tx.staking.chill()
  const chillEvents = await sendTransaction(chillTx.signAsync(validators[0]))

  await client.dev.newBlock()

  await checkEvents(chillEvents, 'staking').toMatchSnapshot('chill events')

  /// Check the nominator's nominations again

  nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominationsPostChill = nominationsOpt.unwrap()

  expect(nominationsPostChill.submittedIn.toNumber()).toBe(eraNumber.toNumber())
  expect(nominationsPostChill.suppressed.isFalse).toBe(true)
  expect(nominationsPostChill.targets.length).toBe(validators.length)

  // Check that the chilled validator is *still* in the nominations.
  // Its previous call to `validate` would only have taken effect in the next era, as will the
  // posterior call to `chill`.
  const targetsPostChill = nominations.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  expect(targetsPostChill.every((v) => targets.includes(encodeAddress(v, addressEncoding)))).toBe(true)

  ///
  /// Chilled validator wishes to remove all its nominations
  ///

  let validatorZeroNonce = (await client.api.rpc.system.accountNextIndex(validators[0].address)).toNumber()

  const kickTx = client.api.tx.staking.kick([alice.address])
  const kickEvents = await sendTransaction(kickTx.signAsync(validators[0], { nonce: validatorZeroNonce++ }))

  await client.dev.newBlock()

  await checkEvents(kickEvents, 'staking').toMatchSnapshot('kick events')

  /// Check the nominator's nominations once again

  nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominationsPostKick = nominationsOpt.unwrap()

  expect(nominationsPostKick.submittedIn.toNumber()).toBe(eraNumber.toNumber())
  expect(nominationsPostKick.suppressed.isFalse).toBe(true)
  expect(nominationsPostKick.targets.length).toBe(validators.length - 1)

  // Check that the kicked nominator's nominations *no longer* include the validator who kicked them.
  const targetsPostKick = nominationsPostKick.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  expect(targetsPostKick.includes(encodeAddress(validators[0].address, addressEncoding))).toBe(false)

  ///
  /// Chilled validator wishes to validate again, but this time it blocks itself
  ///

  const blockTx = client.api.tx.staking.validate({ commission: minValidatorCommission, blocked: true })
  const blockEvents = await sendTransaction(blockTx.signAsync(validators[0], { nonce: validatorZeroNonce++ }))

  await client.dev.newBlock()

  await checkEvents(blockEvents, 'staking').toMatchSnapshot('validate (blocked) events')

  const prefs: PalletStakingValidatorPrefs = await client.api.query.staking.validators(validators[0].address)
  const { commission, blocked } = prefs

  expect(commission.toNumber()).toBe(minValidatorCommission.toNumber())
  expect(blocked).toBeTruthy()

  ///
  /// Nominator tries to select the blocked validator
  ///

  const nominateTx2 = client.api.tx.staking.nominate(validators.map((v) => v.address))
  await sendTransaction(nominateTx2.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'events when attempting to nominate a blocked validator',
  )

  // Check events for the correct error code
  events = await client.api.query.system.events()

  const [ev1] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev1.event))
  const dispatchError = ev1.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.staking.BadTarget.is(dispatchError.asModule))

  ///
  /// Chilled validator unbonds all its funds
  ///

  const unbondTx = client.api.tx.staking.unbond(5000e10)
  const unbondEvents = await sendTransaction(unbondTx.signAsync(validators[0], { nonce: validatorZeroNonce++ }))

  await client.dev.newBlock()

  await checkEvents(unbondEvents, 'staking').toMatchSnapshot('unbond events')
}

/**
 * Test the use of `force_unstake` to forcibly remove a nominator from the system.
 *
 * 1. Two accounts bond funds
 * 2. One account declares its intent to validate, and the other nominates the first
 * 3. The nominator is forcibly unstaked via a `Root` call to `force_unstake`
 *
 * A nominator must be used in these tests and not a validator, since registering validators requires
 * waiting for an entire era to pass.
 */
async function forceUnstakeTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  ///
  /// Bond funds for both Alice and Bob
  ///

  const bondTx = client.api.tx.staking.bond(10000e10, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))

  await client.dev.newBlock()

  /// Express intent to validate as Alice, and nominate as Bob

  const validateTx = client.api.tx.staking.validate({ commission: 10e6, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))

  await client.dev.newBlock()

  const nominateTx = client.api.tx.staking.nominate([alice.address])
  await sendTransaction(nominateTx.signAsync(bob))

  await client.dev.newBlock()

  ///
  /// Force unstake Bob, first with a signed origin (which *must* fail), and then a `Root` origin.
  ///

  const slashingSpans = await client.api.query.staking.slashingSpans(bob.address)
  expect(slashingSpans.isNone).toBeTruthy()

  // Bob can have no slashing spans recorded as a fresh nominator, so `force_unstake`'s second argument is 0.
  const forceUnstakeTx = client.api.tx.staking.forceUnstake(bob.address, 0)

  /// Try the extrinsic with a `Signed` origin

  await sendTransaction(forceUnstakeTx.signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'force unstake bad origin events',
  )

  let nominatorPrefs = await client.api.query.staking.nominators(bob.address)
  assert(nominatorPrefs.isSome)

  scheduleInlineCallWithOrigin(client, forceUnstakeTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  nominatorPrefs = await client.api.query.staking.nominators(bob.address)
  expect(nominatorPrefs.isNone).toBeTruthy()
}

/**
 * Test the fast unstaking process.
 *
 * 1. An accounts bonds some funds
 * 2. it nominates some validators
 * 3. it registers itself for fast unstaking
 */
async function fastUnstakeTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)
  const kr = defaultAccountsSr25519
  const alice = kr.alice
  const bob = kr.bob
  const charlie = kr.charlie

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const bondTx = client.api.tx.staking.bond(10000e10, { Staked: null })

  const bondEvents = await sendTransaction(bondTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(bondEvents, 'staking').toMatchSnapshot('nominator bond events')

  /// Nominate some validators

  let aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  const nominateTx = client.api.tx.staking.nominate([bob.address, charlie.address])
  await sendTransaction(nominateTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  // nominate emits no events
  let events = await client.api.query.system.events()
  const nominateEvent = events.find((record) => {
    const { event } = record
    return event.section === 'staking'
  })
  expect(nominateEvent).toBeUndefined()

  // Check nominations

  let nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominations = nominationsOpt.unwrap()

  const eraNumberOpt = await client.api.query.staking.currentEra()
  assert(eraNumberOpt.isSome)
  const eraIndex = eraNumberOpt.unwrap()

  await check(nominations).toMatchObject({
    submittedIn: eraIndex.toNumber(),
    suppressed: false,
    targets: [encodeAddress(bob.address, addressEncoding), encodeAddress(charlie.address, addressEncoding)],
  })

  /// Fast unstake

  const registerFastUnstakeTx = client.api.tx.fastUnstake.registerFastUnstake()
  await sendTransaction(registerFastUnstakeTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  events = await client.api.query.system.events()
  const registerFastUnstakeEvent = events.filter((record) => {
    const { event } = record
    return event.section === 'fastUnstake'
  })
  // `register_fast_unstake` emits a `BatchChecked` event
  expect(registerFastUnstakeEvent.length).toBe(1)

  // Check that Alice's tentative nominations have been removed
  nominationsOpt = await client.api.query.staking.nominators(alice.address)
  expect(nominationsOpt.isNone).toBeTruthy()
}

/**
 * Test the setting of minimum validator commission with `set_min_commission`.
 *
 * This is done for `Root/StakingAdmin` origins, which constitute valid `AdminOrigin` in Polkadot/Kusama
 * as of Jan. 2025.
 *
 * 1. First, the extrinsic is attempted with only a `Signed` origin, which should fail.
 * 2. Then, the extrinsic is run with both `AdminOrigin/Root` origins, via the `scheduler` pallet.
 *
 *    2.1 The new minimum validator commission value is checked.
 */
async function setMinCommission<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const preMinCommission = (await client.api.query.staking.minCommission()).toNumber()

  const setMinCommissionCall = (inc: number) => client.api.tx.staking.setMinCommission(preMinCommission + inc)

  ///
  /// Try the extrinsic with a `Signed` origin
  ///

  await sendTransaction(setMinCommissionCall(0).signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'set staking configs bad origin events',
  )

  // Dissect the error

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  expect(dispatchError.isBadOrigin).toBeTruthy()

  ///
  /// Run the extrinsic with a `Root/StakingAdmin` origins.
  ///

  type Origin = { system: string } | { Origins: string }
  type OriginsAndIncrements = [Origin, number]

  const originsAndIncrements: OriginsAndIncrements[] = [
    [{ system: 'Root' }, 100],
    [{ Origins: 'StakingAdmin' }, 200],
  ]

  for (const [origin, inc] of originsAndIncrements) {
    scheduleInlineCallWithOrigin(client, setMinCommissionCall(inc).method.toHex(), origin)

    await client.dev.newBlock()

    const events = await client.api.query.system.events()

    const stakingEvents = events.filter((record) => {
      const { event } = record
      return event.section === 'staking'
    })

    // TODO: `set_minimum_commission` does not emit events at this point.
    expect(stakingEvents.length, 'setting global nomination pool configs should emit 1 event').toBe(0)

    const postMinCommission = (await client.api.query.staking.minCommission()).toNumber()

    expect(postMinCommission).toBe(preMinCommission + inc)
  }
}

/**
 * Test the setting of staking configuration parameters with `set_staking_configs`.
 *
 * This requires a `Root` origin.
 *
 * 1. First, the extrinsic is attempted with only a `Signed` origin, which should fail.
 * 2. Then, the extrinsic is run with a `Root` origin, introduced via the `scheduler` pallet into the agenda for the
 *    upcoming block, which should succeed.
 *
 *    2.1 The new global staking config values are checked.
 */
async function setStakingConfigsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const oneThousand = client.api.createType('u32', 1000)
  const tenPercent = client.api.createType('Percent', 1)

  const preMinNominatorBond = (await client.api.query.staking.minNominatorBond()).toNumber()
  const preMinValidatorBond = (await client.api.query.staking.minValidatorBond()).toNumber()
  const preMaxNominatorsCount = (await client.api.query.staking.maxNominatorsCount()).unwrapOr(oneThousand).toNumber()
  const preMaxValidatorsCount = (await client.api.query.staking.maxValidatorsCount()).unwrapOr(oneThousand).toNumber()
  const preChillThreshold = (await client.api.query.staking.chillThreshold()).unwrapOr(tenPercent).toNumber()
  const preMinCommission = (await client.api.query.staking.minCommission()).toNumber()
  const preMaxStakedRewards = (await client.api.query.staking.maxStakedRewards()).unwrapOr(tenPercent).toNumber()

  const setStakingConfigsCall = (inc: number) =>
    client.api.tx.staking.setStakingConfigs(
      { Set: preMinNominatorBond + inc },
      { Set: preMinValidatorBond + inc },
      { Set: preMaxNominatorsCount + inc },
      { Set: preMaxValidatorsCount + inc },
      { Set: preChillThreshold + inc },
      { Set: preMinCommission + inc },
      { Set: preMaxStakedRewards + inc },
    )

  ///
  /// Try the extrinsic with a `Signed` origin
  ///

  await sendTransaction(setStakingConfigsCall(0).signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'set staking configs bad origin events',
  )

  // Dissect the error

  let events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  expect(dispatchError.isBadOrigin).toBeTruthy()

  ///
  /// Run the extrinsic with a `Root` origin
  ///

  const inc = 10

  scheduleInlineCallWithOrigin(client, setStakingConfigsCall(inc).method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  // Check new config values

  events = await client.api.query.system.events()

  const stakingEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'staking'
  })

  // TODO: `set_staking_configs` does not emit events at this point.
  expect(stakingEvents.length, 'setting staking configs should emit 1 event').toBe(0)

  const postMinNominatorBond = (await client.api.query.staking.minNominatorBond()).toNumber()
  const postMinValidatorBond = (await client.api.query.staking.minValidatorBond()).toNumber()
  const postMaxNominatorsCount = (await client.api.query.staking.maxNominatorsCount()).unwrap().toNumber()
  const postMaxValidatorsCount = (await client.api.query.staking.maxValidatorsCount()).unwrap().toNumber()
  const postChillThreshold = (await client.api.query.staking.chillThreshold()).unwrap().toNumber()
  const postMinCommission = (await client.api.query.staking.minCommission()).toNumber()
  const postMaxStakedRewards = (await client.api.query.staking.maxStakedRewards()).unwrap().toNumber()

  const [setStakingConfigsSuccess] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicSuccess'
  })

  await check(setStakingConfigsSuccess).redact({ number: 2 }).toMatchSnapshot('set staking configs event')

  expect(postMinNominatorBond).toBe(preMinNominatorBond + inc)
  expect(postMinValidatorBond).toBe(preMinValidatorBond + inc)
  expect(postMaxNominatorsCount).toBe(preMaxNominatorsCount + inc)
  expect(postMaxValidatorsCount).toBe(preMaxValidatorsCount + inc)
  expect(postChillThreshold).toBe(preChillThreshold + inc)
  expect(postMinCommission).toBe(preMinCommission + inc)
  expect(postMaxStakedRewards).toBe(preMaxStakedRewards + inc)
}

/**
 * Test for `setStakingConfigs + force_apply_min_commission`.
 *
 * Test that
 *
 * 1. setting a global minimum validator commission, and then
 * 2. forcefully updating a validator's commission as an aritrary account
 *
 * works.
 */
async function forceApplyValidatorCommissionTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  /// Create some Sr25519 accounts and fund them

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[bob.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  const minCommission = await client.api.query.staking.minCommission()

  ///
  /// Create validator with the current minimum commission
  ///

  const bondTx = client.api.tx.staking.bond(10000e10, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))

  await client.dev.newBlock()

  const validateTx = client.api.tx.staking.validate({ commission: minCommission, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))

  await client.dev.newBlock()

  const validatorPrefs = await client.api.query.staking.validators(alice.address)
  await check(validatorPrefs).toMatchObject({
    commission: minCommission.toNumber(),
    blocked: false,
  })

  ///
  /// Set the new commission
  ///

  const newCommission = minCommission.add(new BN(10e6))

  const setStakingConfigsTx = client.api.tx.staking.setStakingConfigs(
    { Noop: null },
    { Noop: null },
    { Noop: null },
    { Noop: null },
    { Noop: null },
    { Set: newCommission },
    { Noop: null },
  )

  scheduleInlineCallWithOrigin(client, setStakingConfigsTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  ///

  ///
  /// Forcefully update the validator's commission
  ///

  const forceApplyMinCommissionTx = client.api.tx.staking.forceApplyMinCommission(alice.address)
  const forceApplyMinCommissionEvents = await sendTransaction(forceApplyMinCommissionTx.signAsync(bob))

  await client.dev.newBlock()

  // TODO: `force_apply_min_commission` does not emit events at this point.
  await checkEvents(forceApplyMinCommissionEvents, 'staking', 'system').toMatchSnapshot(
    'force apply min commission events',
  )

  const validatorPrefsPost: PalletStakingValidatorPrefs = await client.api.query.staking.validators(alice.address)
  expect(validatorPrefsPost.commission.toNumber()).toBe(newCommission.toNumber())
  expect(validatorPrefsPost.blocked.isFalse).toBeTruthy()
}

/**
 * Test system extrinsics regulating validator count:
 * 1. `set_validator_count`
 * 2. `increase_validator_count`
 * 3. `scale_validator_count`
 */
async function modifyValidatorCountTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  ///
  /// `setValidatorCount`
  ///

  const setValidatorCountCall = (count: number) => client.api.tx.staking.setValidatorCount(count)

  /// Run the call with a signed origin - it MUST fail.

  await sendTransaction(setValidatorCountCall(0).signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'set validator count bad origin events',
  )
  let events = await client.api.query.system.events()

  /// Run the call with a `Root` origin

  await scheduleInlineCallWithOrigin(client, setValidatorCountCall(100).method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  const stakingEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'staking'
  })
  // None of these validator count setting extrinsics emit events.
  expect(stakingEvents.length).toBe(0)

  let validatorCount = await client.api.query.staking.validatorCount()
  expect(validatorCount.toNumber()).toBe(100)

  ///
  /// `increaseValidatorCount`
  ///

  const increaseValidatorCountCall = (inc: number) => client.api.tx.staking.increaseValidatorCount(inc)

  /// Run the call with a signed origin - it MUST fail.

  await sendTransaction(increaseValidatorCountCall(0).signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'increase validator count bad origin events',
  )

  /// Run the call with a `Root` origin

  scheduleInlineCallWithOrigin(client, increaseValidatorCountCall(100).method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  expect(stakingEvents.length).toBe(0)

  validatorCount = await client.api.query.staking.validatorCount()
  expect(validatorCount.toNumber()).toBe(200)

  ///
  /// `scaleValidatorCount`
  ///

  const scaleValidatorCountCall = (factor: number) => client.api.tx.staking.scaleValidatorCount(factor)

  /// Run the call with a signed origin - it MUST fail.

  await sendTransaction(scaleValidatorCountCall(0).signAsync(alice))

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'scale validator count bad origin events',
  )

  /// Run the call with a `Root` origin

  scheduleInlineCallWithOrigin(client, scaleValidatorCountCall(10).method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  expect(stakingEvents.length).toBe(0)

  validatorCount = await client.api.query.staking.validatorCount()
  expect(validatorCount.toNumber()).toBe(220)
}

/**
 * Test the `chill_other` mechanism, used to remove nominators/validators from the system when:
 *
 * 1. a minimum bond amount has been set (for nominators/validators resp.)
 * 2. A limit of nominators/validators has been set
 * 3. A chilling threshold has been set - a percentage of the nominator/validator limits beyond which
 *    users can begin calling `chill_other` on others.
 *
 * This test checks that if any of these are missing, `chill_other` cannot succeed, and it only succeeds
 * when all are met.
 */
async function chillOtherTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  /// Rquired information for this test, to set appropriate thresholds later

  const minNominatorBond = await client.api.query.staking.minNominatorBond()
  const minValidatorBond = await client.api.query.staking.minValidatorBond()

  const minValidatorCommission = await client.api.query.staking.minCommission()

  const currentNominatorCount = await client.api.query.staking.counterForNominators()
  const currentValidatorCount = await client.api.query.staking.counterForValidators()

  /// Disregard staking configs pre-test-execution, excluding minumum validator/nominator bonds, which are not
  /// optional, and whose pre-test values can be used in the test.

  const setStakingConfigsCall = client.api.tx.staking.setStakingConfigs(
    { Noop: null },
    { Noop: null },
    { Remove: null },
    { Remove: null },
    { Remove: null },
    { Noop: null },
    { Noop: null },
  )

  scheduleInlineCallWithOrigin(client, setStakingConfigsCall.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  /// Setup a validator and a nominator, as the account that'll be calling `chill_other`

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: 100000e10 } }],
        [[bob.address], { providers: 1, data: { free: 100000e10 } }],
        [[charlie.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  /// Alice and Bob bond funds according to their desired roles.

  const nomBondTx = client.api.tx.staking.bond(minNominatorBond, { Staked: null })
  const valBondTx = client.api.tx.staking.bond(minValidatorBond, { Staked: null })
  await sendTransaction(valBondTx.signAsync(alice))
  await sendTransaction(nomBondTx.signAsync(bob))

  await client.dev.newBlock()

  /// Alice becomes a validator

  const validateTx = client.api.tx.staking.validate({ commission: minValidatorCommission, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))

  await client.dev.newBlock()

  /// Bob becomes a nominator, and nominates Alice

  const nominateTx = client.api.tx.staking.nominate([alice.address])
  await sendTransaction(nominateTx.signAsync(bob))

  await client.dev.newBlock()

  /// Generate all possible combinations of `set_staking_configs` calls, to test the `chill_other` mechanism.
  /// 1. No limits set at all (1 such call)
  /// 2. Only some of the limits set (6 such calls)
  /// 3. All limits set (1 such call)

  const noop = { Noop: null }
  const remove = { Remove: null }
  const setNominatorBond = { Set: minNominatorBond.toNumber() + 1 }
  const setValidatorBond = { Set: minValidatorBond.toNumber() + 1 }

  // Nominator/validator limits can be set to the current count; since the chill threshold will be set to 75%,
  // this will allow the use of `chill_other`.
  const setNominatorCount = { Set: currentNominatorCount }
  const setValidatorCount = { Set: currentValidatorCount }

  // Chill threshold of 75% - which, when setting nominator/validator count limits to the current count, will be
  // enough to allow the use of `chill_other`.
  const chillThresholdSet = { Set: 75 }

  const setStakingConfigsCalls: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const bondLimits of [
    [remove, remove],
    [setNominatorBond, setValidatorBond],
  ]) {
    for (const countLimits of [
      [remove, remove],
      [setNominatorCount, setValidatorCount],
    ]) {
      for (const chillThreshold of [remove, chillThresholdSet]) {
        const [a, b, c, d, e, f, g] = [...bondLimits, ...countLimits, chillThreshold, ...Array(2).fill(noop)]

        setStakingConfigsCalls.push(client.api.tx.staking.setStakingConfigs(a, b, c, d, e, f, g))
      }
    }
  }

  expect(setStakingConfigsCalls.length).toBe(8)

  // Extract the last call, which should be the only one with which `chill_other` can succeed.
  const successfulCall = setStakingConfigsCalls.pop()

  for (const call of setStakingConfigsCalls) {
    scheduleInlineCallWithOrigin(client, call.method.toHex(), { system: 'Root' })

    await client.dev.newBlock()

    const chillOtherTx = client.api.tx.staking.chillOther(bob.address)
    await sendTransaction(chillOtherTx.signAsync(charlie))

    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'chill other bad origin events',
    )

    // Inspect the error - it needs to be `CannotChillOther`
    const events = await client.api.query.system.events()

    const [ev] = events.filter((record) => {
      const { event } = record
      return event.section === 'system' && event.method === 'ExtrinsicFailed'
    })

    assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
    const dispatchError = ev.event.data.dispatchError
    expect(dispatchError.isModule).toBe(true)
    assert(client.api.errors.staking.CannotChillOther.is(dispatchError.asModule))
  }

  /// To end the test, sucessfully run `chill_other` with the appropriate staking configuration limits all set,
  /// and observe that Bob is forcibly chilled.

  scheduleInlineCallWithOrigin(client, successfulCall!.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  const chillOtherTx = client.api.tx.staking.chillOther(bob.address)
  const chillOtherEvents = await sendTransaction(chillOtherTx.signAsync(charlie))

  await client.dev.newBlock()

  await checkEvents(chillOtherEvents, 'staking').toMatchSnapshot('chill other events')

  const nominatorPrefs = await client.api.query.staking.nominators(bob.address)
  expect(nominatorPrefs.isNone).toBe(true)
}

/// --------------
/// Slashing tests
/// --------------

/**
 * Test that an unapplied slash to valid validators/nominators, scheduled for a certain era `n + 1`, is applied
 * when transitioning from era `n` to `n + 1`.
 *
 * 1. Calculate the block number at which the era will change.
 * 2. Go to the block just before that one, and modify the staking ledger to include the accounts that will be slashed.
 * 3. Bond funds from each of the accounts that will be slashed.
 * 4. Insert a slash into storage, with the accounts that will be slashed.
 * 5. Advance to the block in which the era changes.
 * 6. Observe that the slash is applied.
 */
async function unappliedSlashTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.keyring.createFromUri('//fresh_alice')
  const bob = defaultAccountsSr25519.keyring.createFromUri('//fresh_bob')
  const charlie = defaultAccountsSr25519.keyring.createFromUri('//fresh_charlie')
  const dave = defaultAccountsSr25519.keyring.createFromUri('//fresh_dave')

  const eraChangeBlock = await locateEraChange(client)
  if (eraChangeBlock === undefined) {
    // This test only makes sense to run if there's an active era.
    console.warn('Unable to find era change block, skipping unapplied slash test')
    return
  }

  // Go to the block just before the one in which the era changes, in order to modify the staking ledger with the
  // accounts that will be slashed.
  // If this isn't done, the slash will not be applied.
  await client.dev.setHead(eraChangeBlock - 1)

  const balances = 10000e10
  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: balances } }],
        [[bob.address], { providers: 1, data: { free: balances } }],
        [[charlie.address], { providers: 1, data: { free: balances } }],
      ],
    },
  })

  const bondAmount = balances / 10
  const slashAmount = bondAmount / 2

  const bondTx = client.api.tx.staking.bond(bondAmount, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()

  // Insert a slash into storage. The accounts named here as validators/nominators need not have called
  // `validate`/`nominate` - they must only exist in the staking ledger as having bonded funds.
  await client.dev.setStorage({
    Staking: {
      UnappliedSlashes: [
        [
          [activeEra + 1],
          [
            {
              validator: alice.address,
              // Less than the bonded funds.
              own: slashAmount,
              others: [
                // Exactly the bonded funds.
                [bob.address, slashAmount * 2],
                // More than the bonded funds.
                [charlie.address, slashAmount * 3],
              ],
              reporters: [dave.address],
              payout: bondAmount,
            },
          ],
        ],
      ],
    },
  })

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  expect(aliceFundsPreSlash.data.toJSON()).toMatchSnapshot('alice funds pre slash')
  expect(bobFundsPreSlash.data.toJSON()).toMatchSnapshot('bob funds pre slash')
  expect(charlieFundsPreSlash.data.toJSON()).toMatchSnapshot('charlie funds pre slash')

  await client.dev.setStorage({
    ParasDisputes: {
      $removePrefix: ['disputes', 'included'],
    },
    Dmp: {
      $removePrefix: ['downwardMessageQueues'],
    },
    Staking: {
      $removePrefix: ['erasStakersOverview', 'erasStakersPaged', 'erasStakers'],
    },
    Session: {
      $removePrefix: ['nextKeys'],
    },
  })

  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'staking', method: 'Slashed' }).toMatchSnapshot('staking slash events')
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' }).toMatchSnapshot('balances slash events')

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  // First, verify that all acounts' reserved funds have been slashed
  // Recall that `bondAmount - slashAmount * 2` is zero.
  // Note that `bondAmount - slashAmount * 3` is negative, and an account's slashable funds are limited
  // to what it bonded.
  // Thus, also zero.
  expect(aliceFundsPostSlash.data.toJSON()).toMatchSnapshot('alice funds post slash')
  expect(bobFundsPostSlash.data.toJSON()).toMatchSnapshot('bob funds post slash')
  expect(charlieFundsPostSlash.data.toJSON()).toMatchSnapshot('charlie funds post slash')

  expect(aliceFundsPostSlash.data.reserved.toNumber()).toBe(aliceFundsPreSlash.data.reserved.toNumber() - slashAmount)
  expect(bobFundsPostSlash.data.reserved.toNumber()).toBe(bobFundsPreSlash.data.reserved.toNumber() - bondAmount)
  // Recall again that even though Charlie's slash is 1.5 times his bond, the slash can, at most, tax all he has
  // bonded, and not one unit more.
  expect(charlieFundsPostSlash.data.reserved.toNumber()).toBe(
    charlieFundsPreSlash.data.reserved.toNumber() - bondAmount,
  )
}

/**
 * Test cancelling unapplied slashes, using different origins.
 */
async function cancelDeferredSlashTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, origin: any) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  const eraChangeBlock = await locateEraChange(client)
  if (eraChangeBlock === undefined) {
    // This test only makes sense to run if there's an active era.
    return
  }

  // Go to a block before the one in which the era changes. In the two blocks before it changes,
  // 1. the call to `cancel_deferred_slash` will be scheduled
  // 2. the stakers in question will call `bond`
  await client.dev.setHead(eraChangeBlock - 2)

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()
  const bondAmount = 1000e10
  const slashAmount = bondAmount / 2

  // Insert a slash into storage.
  await client.dev.setStorage({
    Staking: {
      UnappliedSlashes: [
        [
          [activeEra + 1],
          [
            {
              validator: alice.address,
              own: slashAmount,
              others: [
                [bob.address, slashAmount],
                [charlie.address, slashAmount],
              ],
              reporters: [dave.address],
              payout: bondAmount,
            },
          ],
        ],
      ],
    },
  })

  // Fund validators

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: 10000e10 } }],
        [[bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[charlie.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const bondTx = client.api.tx.staking.bond(bondAmount, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  // Two blocks away from the era change.

  let slash = await client.api.query.staking.unappliedSlashes(activeEra + 1)
  expect(slash.length).toBe(1)

  const cancelDeferredSlashTx = client.api.tx.staking.cancelDeferredSlash(activeEra + 1, [0])
  scheduleInlineCallWithOrigin(client, cancelDeferredSlashTx.method.toHex(), origin)

  // Check stakers' bonded funds before the slash would be applied.

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  expect(aliceFundsPreSlash.data.toJSON()).toMatchSnapshot('alice funds pre slash')
  expect(bobFundsPreSlash.data.toJSON()).toMatchSnapshot('bob funds pre slash')
  expect(charlieFundsPreSlash.data.toJSON()).toMatchSnapshot('charlie funds pre slash')

  await client.dev.newBlock()

  // And the slash should have been cancelled.

  slash = await client.api.query.staking.unappliedSlashes(activeEra + 1)
  expect(slash.length).toBe(0)

  // Era-boundary block creation tends to be slow.
  await client.dev.setStorage({
    ParasDisputes: {
      $removePrefix: ['disputes', 'included'],
    },
    Dmp: {
      $removePrefix: ['downwardMessageQueues'],
    },
    Staking: {
      $removePrefix: ['erasStakersOverview', 'erasStakersPaged', 'erasStakers'],
    },
    Session: {
      $removePrefix: ['nextKeys'],
    },
  })

  // This new block marks the start of the new era.
  await client.dev.newBlock()

  // The era should have changed.

  const newActiveEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()
  expect(newActiveEra).toBe(activeEra + 1)

  // None of the validators' funds should have been slashed.

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  expectPjsEqual(aliceFundsPostSlash, aliceFundsPreSlash)
  expectPjsEqual(bobFundsPostSlash, bobFundsPreSlash)
  expectPjsEqual(charlieFundsPostSlash, charlieFundsPreSlash)
}

/**
 * Test the cancellation of a slash with an incorrect origin.
 */
async function cancelDeferredSlashTestBadOrigin<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice

  const cancelDeferredSlashTx = client.api.tx.staking.cancelDeferredSlash(0, [0])
  const cancelDeferredSlashEvents = await sendTransaction(cancelDeferredSlashTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(cancelDeferredSlashEvents, 'staking', {
    section: 'system',
    method: 'ExtrinsicFailed',
  }).toMatchSnapshot('cancel deferred slash events with bad origin')

  // Scrutinize events

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  expect(dispatchError.isBadOrigin).toBeTruthy()
}

/**
 * Test that when cancelling an unapplied slash scheduled for a certain era `n + 1`, is *not* applied
 * when transitioning from era `n` to `n + 1`.
 *
 * Use a `Root` origin to call `cancel_deferred_slash`.
 *
 * 1. Calculate the block number at which the era will change.
 * 2. Go to a block before that one, and modify the staking ledger to include the accounts that will be slashed.
 * 3. Insert a slash into storage.
 * 4. Bond funds from each of the accounts that will be slashed.
 * 5. Advance to the block in which the era changes.
 * 6. Observe that the slash is *not* applied.
 */
async function cancelDeferredSlashTestAsRoot<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  await cancelDeferredSlashTest(chain, { system: 'Root' })
}

/**
 * Test that when cancelling an unapplied slash scheduled for a certain era `n + 1`, is *not* applied
 * when transitioning from era `n` to `n + 1`.
 *
 * Use a `StakingAdmin` origin to call `cancel_deferred_slash`.
 *
 * 1. Calculate the block number at which the era will change.
 * 2. Go to a block before that one, and modify the staking ledger to include the accounts that will be slashed.
 * 3. Insert a slash into storage.
 * 4. Bond funds from each of the accounts that will be slashed.
 * 5. Advance to the block in which the era changes.
 * 6. Observe that the slash is *not* applied.
 */
async function cancelDeferredSlashTestAsAdmin<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  await cancelDeferredSlashTest(chain, { Origins: 'StakingAdmin' })
}

/**
 * Test setting invulnerables with a bad, `StakingAdmin` origin.
 */
async function setInvulnerablesTestBadOrigin<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const alice = defaultAccountsSr25519.alice

  const setInvulnerablesTx = client.api.tx.staking.setInvulnerables([alice.address])
  const setInvulnerablesEvents = await sendTransaction(setInvulnerablesTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(setInvulnerablesEvents, 'staking', {
    section: 'system',
    method: 'ExtrinsicFailed',
  }).toMatchSnapshot('set invulnerables events with bad signed origin')

  let events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  expect(dispatchError.isBadOrigin).toBeTruthy()

  // Try it with `StakingAdmin` origin, which is still not enough on Polkadot/Kusama.

  scheduleInlineCallWithOrigin(client, setInvulnerablesTx.method.toHex(), { Origins: 'StakingAdmin' })

  await client.dev.newBlock()

  await checkSystemEvents(client, 'scheduler')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('events when setting invulnerables with bad staking admin origin')

  events = await client.api.query.system.events()

  const [ev_] = events.filter((record) => {
    const { event } = record
    return event.section === 'scheduler'
  })

  assert(client.api.events.scheduler.Dispatched.is(ev_.event))
  const e = ev_.event.data
  expect(e.result.isErr).toBeTruthy()
  expect(e.result.asErr.isBadOrigin).toBeTruthy()
}

/**
 * Test setting invulnerables with the correct Root origin.
 *
 * 1. Travel to a few blocks before the last era change
 * 2. Fund accounts, bund said funds, and express intent to validate
 * 3. Set them as invulnerables
 * 4. Insert a slash into storage
 * 5. Advance to the block in which the era changes
 * 6. Observe that the slash is applied
 *
 * Invulnerable validators are slashed, because being invulnerable does not protect against slashes that have
 * already been scheduled.
 */
async function setInvulnerablesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  //
  // Locate era change
  //

  const eraChangeBlock = await locateEraChange(client)
  if (eraChangeBlock === undefined) {
    // This test only makes sense to run if there's an active era.
    console.warn('Unable to find era change block, skipping unapplied slash test')
    return
  }

  // Go to a block before the era change - accounts need to bond, start validating, and invulnerables still need to be
  // set.
  await client.dev.setHead(eraChangeBlock - 3)

  //
  // Fund accounts
  //

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  const balances = 10000e10
  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: balances } }],
        [[bob.address], { providers: 1, data: { free: balances } }],
        [[charlie.address], { providers: 1, data: { free: balances } }],
      ],
    },
  })

  // Bond funds for each validator
  const bondAmount = balances / 10
  const bondTx = client.api.tx.staking.bond(bondAmount, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  // Set them as validators
  const minCommission = await client.api.query.staking.minCommission()
  const validateTx = client.api.tx.staking.validate({ commission: minCommission, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))
  await sendTransaction(validateTx.signAsync(bob))
  await sendTransaction(validateTx.signAsync(charlie))

  await client.dev.newBlock()

  // Sort the addresses to make the test simpler.

  const invulnerables = [alice.address, bob.address, charlie.address].map((addr) =>
    encodeAddress(addr.toString(), addressEncoding),
  )
  invulnerables.sort()

  // Set them as invulnerable using Root origin
  const setInvulnerablesTx = client.api.tx.staking.setInvulnerables(invulnerables)
  scheduleInlineCallWithOrigin(client, setInvulnerablesTx.method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  // Verify the invulnerables were set correctly
  const queriedInvulnerables = (await client.api.query.staking.invulnerables()).map((addr) =>
    encodeAddress(addr.toString(), addressEncoding),
  )

  expect(queriedInvulnerables).toEqual(invulnerables)

  //
  // Slash the invulnerable accounts
  //

  // Insert the slash

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()

  const slashAmount = bondAmount / 2

  // Insert a slash into storage. The accounts named here as validators/nominators need not have called
  // `validate`/`nominate` - they must only exist in the staking ledger as having bonded funds.
  await client.dev.setStorage({
    ParasDisputes: {
      $removePrefix: ['disputes', 'included'],
    },
    Dmp: {
      $removePrefix: ['downwardMessageQueues'],
    },
    Staking: {
      $removePrefix: ['erasStakersOverview', 'erasStakersPaged', 'erasStakers'],
      UnappliedSlashes: [
        [
          [activeEra + 1],
          [
            {
              validator: alice.address,
              // Less than the bonded funds.
              own: slashAmount,
              others: [
                // Exactly the bonded funds.
                [bob.address, slashAmount * 2],
                // More than the bonded funds.
                [charlie.address, slashAmount * 3],
              ],
              reporters: [dave.address],
              payout: bondAmount,
            },
          ],
        ],
      ],
    },
    Session: {
      $removePrefix: ['nextKeys'],
    },
  })

  // Pre-slash balance checks

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  expect(aliceFundsPreSlash.data.toJSON()).toMatchSnapshot('alice funds pre slash')
  expect(bobFundsPreSlash.data.toJSON()).toMatchSnapshot('bob funds pre slash')
  expect(charlieFundsPreSlash.data.toJSON()).toMatchSnapshot('charlie funds pre slash')

  // With this block, the slash will have been applied.
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'staking', method: 'Slashed' }).toMatchSnapshot('staking slash events')
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' }).toMatchSnapshot('balances slash events')

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  expect(aliceFundsPostSlash.data.toJSON()).toMatchSnapshot('alice funds post slash')
  expect(bobFundsPostSlash.data.toJSON()).toMatchSnapshot('bob funds post slash')
  expect(charlieFundsPostSlash.data.toJSON()).toMatchSnapshot('charlie funds post slash')

  expect(aliceFundsPostSlash.data.reserved.toNumber()).toBe(aliceFundsPreSlash.data.reserved.toNumber() - slashAmount)
  expect(bobFundsPostSlash.data.reserved.toNumber()).toBe(bobFundsPreSlash.data.reserved.toNumber() - bondAmount)
  expect(charlieFundsPostSlash.data.reserved.toNumber()).toBe(
    charlieFundsPreSlash.data.reserved.toNumber() - bondAmount,
  )
}

/// --------------
/// --------------
/// --------------

export function slashingTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'slashing tests',
    children: [
      {
        kind: 'test',
        label: 'unapplied slash',
        testFn: async () => await unappliedSlashTest(chain),
      },
      {
        kind: 'test',
        label: 'cancel deferred slash with bad origin',
        testFn: async () => await cancelDeferredSlashTestBadOrigin(chain),
      },
      {
        kind: 'test',
        label: 'cancel deferred slash as root',
        testFn: async () => await cancelDeferredSlashTestAsRoot(chain),
      },
      {
        kind: 'test',
        label: 'cancel deferred slash as admin',
        testFn: async () => await cancelDeferredSlashTestAsAdmin(chain),
      },
    ],
  }
}

export function baseStakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: 'base staking tests',
    children: [
      {
        kind: 'test' as const,
        label: 'trying to become a validator with no bonded funds fails',
        testFn: async () => await validateNoBondedFundsFailureTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'trying to nominate with no bonded funds fails',
        testFn: async () => await nominateNoBondedFundsFailureTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'staking lifecycle',
        testFn: async () => await stakingLifecycleTest(chain, testConfig.addressEncoding),
      },
      {
        kind: 'test' as const,
        label: 'test force unstaking of nominator',
        testFn: async () => await forceUnstakeTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'test fast unstake',
        testFn: async () => await fastUnstakeTest(chain, testConfig.addressEncoding),
      },
      {
        kind: 'test' as const,
        label: 'set minimum validator commission',
        testFn: async () => await setMinCommission(chain),
      },
      {
        kind: 'test' as const,
        label: 'set staking configs',
        testFn: async () => await setStakingConfigsTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'force apply validator commission',
        testFn: async () => await forceApplyValidatorCommissionTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'modify validator count',
        testFn: async () => await modifyValidatorCountTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'chill other',
        testFn: async () => await chillOtherTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'set invulnerables with bad origin',
        testFn: async () => await setInvulnerablesTestBadOrigin(chain),
      },
      {
        kind: 'test' as const,
        label: 'set invulnerables with root origin',
        testFn: async () => await setInvulnerablesTest(chain, testConfig.addressEncoding),
      },
    ],
  }
}

export function fullStakingTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  const basalTestTree = baseStakingE2ETests(chain, testConfig)
  const slashingTestTree = slashingTests(chain)

  return {
    kind: 'describe' as const,
    label: testConfig.testSuiteName,
    children: [basalTestTree, slashingTestTree],
  }
}
