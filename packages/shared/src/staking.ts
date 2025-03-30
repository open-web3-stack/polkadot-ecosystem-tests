import { encodeAddress } from '@polkadot/util-crypto'
import BN from 'bn.js'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import { check, checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { FrameSystemEventRecord, PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { assert, describe, expect, test } from 'vitest'

/// -------
/// Helpers
/// -------

/**
 * Locate the block number at which the current era ends.
 *
 * This is done by searching through blocks and their eventsuntil the `staking.EraPaid` event is found.
 *
 * Complexity: in essence, `O(1)` since `MAX` and the number of events per block are fixed, but in practice,
 * it can perform `MAX * MAX_EVENTS` checks, with at least `MAX` network roundtrips.
 */
async function locateEraChange(client: Client<any, any>): Promise<number | undefined> {
  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  const progress = client.api.derive.session.progress()
  const p = await progress
  console.log(p.eraProgress.toHuman())
  await client.dev.setHead(currBlockNumber - p.eraProgress.toNumber() - 1)

  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  console.log(currBlockNumber)

  // Search through blocks until `staking.EraPaid` event is found
  const MAX = 100

  let i = 0
  let stakingEvents: FrameSystemEventRecord[]

  while (i < MAX) {
    const events = await client.api.query.system.events()
    stakingEvents = events.filter((record) => {
      const { event } = record
      return event.section === 'staking' && event.method === 'EraPaid'
    })
    if (stakingEvents.length > 0) {
      break
    }

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
    i++
  }

  if (stakingEvents!.length === 0) {
    return undefined
  }

  return currBlockNumber + i - 1
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>) {
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
>(client: Client<TCustom, TInitStorages>, addressEncoding: number) {
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

    assert(commission.eq(minValidatorCommission))
    assert(blocked.isFalse)
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
  const nominateEvents = await sendTransaction(nominateTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  await checkEvents(nominateEvents, 'staking').toMatchSnapshot('nominate events')

  /// Check the nominator's nominations

  let nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominations = nominationsOpt.unwrap()
  assert(nominations.submittedIn.eq(eraNumber))
  assert(nominations.suppressed.isFalse)
  assert(nominations.targets.length === validators.length)

  const targets = nominations.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  assert(validators.every((v) => targets.includes(encodeAddress(v.address, addressEncoding))))

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

  assert(nominationsPostChill.submittedIn.eq(eraNumber))
  assert(nominationsPostChill.suppressed.isFalse)
  assert(nominationsPostChill.targets.length === validators.length)

  // Check that the chilled validator is *still* in the nominations.
  // Its previous call to `validate` would only have taken effect in the next era, as will the
  // posterior call to `chill`.
  const targetsPostChill = nominations.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  assert(targetsPostChill.every((v) => targets.includes(encodeAddress(v, addressEncoding))))

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

  assert(nominationsPostKick.submittedIn.eq(eraNumber))
  assert(nominationsPostKick.suppressed.isFalse)
  assert(nominationsPostKick.targets.length === validators.length - 1)

  // Check that the kicked nominator's nominations *no longer* include the validator who kicked them.
  const targetsPostKick = nominationsPostKick.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  assert(!targetsPostKick.includes(encodeAddress(validators[0].address, addressEncoding)))

  ///
  /// Chilled validator wishes to validate again, but this time it blocks itself
  ///

  const blockTx = client.api.tx.staking.validate({ commission: minValidatorCommission, blocked: true })
  const blockEvents = await sendTransaction(blockTx.signAsync(validators[0], { nonce: validatorZeroNonce++ }))

  await client.dev.newBlock()

  await checkEvents(blockEvents, 'staking').toMatchSnapshot('validate (blocked) events')

  const prefs: PalletStakingValidatorPrefs = await client.api.query.staking.validators(validators[0].address)
  const { commission, blocked } = prefs

  assert(commission.eq(minValidatorCommission))
  assert(blocked.isTrue)

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
  const events = await client.api.query.system.events()

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
>(client: Client<TCustom, TInitStorages>) {
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
  assert(slashingSpans.isNone)

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
  assert(nominatorPrefs.isNone)
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
>(client: Client<TCustom, TInitStorages>, addressEncoding: number) {
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
  const nominateEvents = await sendTransaction(nominateTx.signAsync(alice, { nonce: aliceNonce++ }))

  await client.dev.newBlock()

  await checkEvents(nominateEvents, 'staking').toMatchSnapshot('nominate events')

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
  const registerFastUnstakeEvents = await sendTransaction(
    registerFastUnstakeTx.signAsync(alice, { nonce: aliceNonce++ }),
  )

  await client.dev.newBlock()

  // `register_fast_unstake` emits no events as of Jan. 2025
  await checkEvents(registerFastUnstakeEvents, 'fastUnstake').toMatchSnapshot('register fast unstake events')

  // Check that Alice's tentative nominations have been removed
  nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isNone)
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
>(client: Client<TCustom, TInitStorages>) {
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
  assert(dispatchError.isBadOrigin)

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
    assert(stakingEvents.length === 0, 'setting global nomination pool configs should emit 1 event')

    const postMinCommission = (await client.api.query.staking.minCommission()).toNumber()

    assert(postMinCommission === preMinCommission + inc)
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
>(client: Client<TCustom, TInitStorages>) {
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
  assert(dispatchError.isBadOrigin)

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
  assert(stakingEvents.length === 0, 'setting staking configs should emit 1 event')

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

  assert(postMinNominatorBond === preMinNominatorBond + inc)
  assert(postMinValidatorBond === preMinValidatorBond + inc)
  assert(postMaxNominatorsCount === preMaxNominatorsCount + inc)
  assert(postMaxValidatorsCount === preMaxValidatorsCount + inc)
  assert(postChillThreshold === preChillThreshold + inc)
  assert(postMinCommission === preMinCommission + inc)
  assert(postMaxStakedRewards === preMaxStakedRewards + inc)
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
>(client: Client<TCustom, TInitStorages>) {
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
  assert(validatorPrefsPost.commission.eq(newCommission))
  assert(validatorPrefsPost.blocked.isFalse)
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
>(client: Client<TCustom, TInitStorages>) {
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

  scheduleInlineCallWithOrigin(client, setValidatorCountCall(100).method.toHex(), { system: 'Root' })

  await client.dev.newBlock()

  events = await client.api.query.system.events()

  const stakingEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'staking'
  })
  // None of these validator count setting extrinsics emit events.
  assert(stakingEvents.length === 0)

  let validatorCount = await client.api.query.staking.validatorCount()
  assert(validatorCount.eq(new BN(100)))

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

  assert(stakingEvents.length === 0)

  validatorCount = await client.api.query.staking.validatorCount()
  assert(validatorCount.eq(new BN(200)))

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

  assert(stakingEvents.length === 0)

  validatorCount = await client.api.query.staking.validatorCount()
  assert(validatorCount.eq(new BN(220)))
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
>(client: Client<TCustom, TInitStorages>) {
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

  assert(setStakingConfigsCalls.length === 8)

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
    assert(dispatchError.isModule)
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
  assert(nominatorPrefs.isNone)
}

/**
 * Test that an unapplied slash to valid validators/nominators, scheduled for a certain era `n + 1`, is applied
 * when transitioning from era `n` to `n + 1`.
 *
 * 1. Calculate the block number at which the era will change.
 * 2. Go to the block just before that one, and modify the staking ledger to include the accounts that will be slashed.
 * 3. Bond funds from each of the accounts that will be slashed.
 * 4. Insert a slash into storage, for the accounts that will be slashed.
 * 5. Advance to the block in which the era changes.
 * 6. Observe that the slash is applied.
 */
async function unappliedSlashTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  const eraChangeBlock = await locateEraChange(client)
  assert(eraChangeBlock !== undefined)

  console.log(eraChangeBlock)

  // Go to the block just before the one in which the era changes, in order to modify the staking ledger with the
  // accounts that will be slashed.
  // If this isn't done, the slash will not be applied.
  await client.dev.setHead(eraChangeBlock - 1)

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: 10000e10 } }],
        [[bob.address], { providers: 1, data: { free: 10000e10 } }],
        [[charlie.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })

  const bondAmount = 1000e10
  const slashAmount = bondAmount / 2

  const bondTx = client.api.tx.staking.bond(1000e10, { Staked: null })
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
              own: slashAmount,
              others: [
                [bob.address, slashAmount * 2],
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

  assert(aliceFundsPreSlash.data.frozen.eq(bondAmount))
  assert(bobFundsPreSlash.data.frozen.eq(bondAmount))
  assert(charlieFundsPreSlash.data.frozen.eq(bondAmount))

  await client.dev.newBlock()

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  // First, verify that all acounts' frozen funds have been slashed

  expect(aliceFundsPostSlash.data.frozen.toNumber()).toBe(bondAmount - slashAmount)
  // Recall that `bondAmount - slashAmount * 2` is zero.
  expect(bobFundsPostSlash.data.frozen.toNumber()).toBe(0)
  // Note that `bondAmount - slashAmount * 3` is negative, and an account's slashable funds are limited
  // to what it bonded.
  // Thus, also zero.
  expect(charlieFundsPreSlash.data.frozen.toNumber()).toBe(0)

  expect(aliceFundsPostSlash.data.free.toNumber()).toBe(aliceFundsPreSlash.data.free.toNumber() - slashAmount)
  expect(bobFundsPostSlash.data.free.toNumber()).toBe(bobFundsPreSlash.data.free.toNumber() - bondAmount)
  // Recall again that even though Charlie's slash is 1.5 times his bond, the slash can at msot tax all he has
  // bonded, and not one unit more.
  expect(charlieFundsPostSlash.data.free.toNumber()).toBe(charlieFundsPreSlash.data.free.toNumber() - bondAmount)
}

export function stakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
    const [client] = await setupNetworks(chain)

    test('trying to become a validator with no bonded funds fails', async () => {
      await validateNoBondedFundsFailureTest(client)
    })

    test('trying to nominate with no bonded funds fails', async () => {
      await nominateNoBondedFundsFailureTest(client)
    })

    test('staking lifecycle', async () => {
      await stakingLifecycleTest(client, testConfig.addressEncoding)
    })

    test('test force unstaking of nominator', async () => {
      await forceUnstakeTest(client)
    })

    test('test fast unstake', async () => {
      await fastUnstakeTest(client, testConfig.addressEncoding)
    })

    test('set minimum validator commission', async () => {
      await setMinCommission(client)
    })

    test('set staking configs', async () => {
      await setStakingConfigsTest(client)
    })

    test('force apply validator commission', async () => {
      await forceApplyValidatorCommissionTest(client)
    })

    test('modify validator count', async () => {
      await modifyValidatorCountTest(client)
    })

    test('chill other', async () => {
      await chillOtherTest(client)
    })

    test('unapplied slash', async () => {
      await unappliedSlashTest(client)
    })
  })
}
