import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { BlockHash } from '@polkadot/types/interfaces'
import type { PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import BN from 'bn.js'
import { match } from 'ts-pattern'
import {
  check,
  checkEvents,
  checkSystemEvents,
  expectPjsEqual,
  scheduleInlineCallWithOrigin,
  type TestConfig,
  updateCumulativeFees,
} from './helpers/index.js'

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
  await sendTransaction(validateTx.signAsync(testAccounts.alice))

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
  const nominateTx = client.api.tx.staking.nominate([testAccounts.alice.address])
  await sendTransaction(nominateTx.signAsync(testAccounts.alice))

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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  ///
  /// Generate validators, and fund them.
  ///

  const validatorCount = 3

  const validators: KeyringPair[] = []

  for (let i = 0; i < validatorCount; i++) {
    const validator = testAccounts.keyring.addFromUri(`//Validator_${i}`)
    validators.push(validator)
  }

  let minValBond = (await client.api.query.staking.minValidatorBond()).toBigInt()
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  if (minValBond === 0n) {
    minValBond = ed * 10n ** 5n
  }

  await client.dev.setStorage({
    System: {
      // Min val bond + 1000 EDs for fees (to be safe)
      account: validators.map((v) => [[v.address], { providers: 1, data: { free: minValBond + ed * 1000n } }]),
    },
  })

  ///
  /// Bond each validator's funds
  ///

  for (const [index, validator] of validators.entries()) {
    const bondTx = client.api.tx.staking.bond(minValBond, { Staked: null })
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

  const alice = testAccounts.alice

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

  const targets = nominations.targets.map((t) => encodeAddress(t.toString(), chain.properties.addressEncoding))
  expect(validators.every((v) => targets.includes(encodeAddress(v.address, chain.properties.addressEncoding)))).toBe(
    true,
  )

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
  const targetsPostChill = nominations.targets.map((t) => encodeAddress(t.toString(), chain.properties.addressEncoding))
  expect(targetsPostChill.every((v) => targets.includes(encodeAddress(v, chain.properties.addressEncoding)))).toBe(true)

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
  const targetsPostKick = nominationsPostKick.targets.map((t) =>
    encodeAddress(t.toString(), chain.properties.addressEncoding),
  )
  expect(targetsPostKick.includes(encodeAddress(validators[0].address, chain.properties.addressEncoding))).toBe(false)

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
  const alice = testAccounts.alice
  const bob = testAccounts.bob

  const minNominatorBond = (await client.api.query.staking.minNominatorBond()).toBigInt()
  let minValidatorBond = (await client.api.query.staking.minValidatorBond()).toBigInt()
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  if (minValidatorBond === 0n) {
    minValidatorBond = ed * 10n ** 5n
  }
  const minValidatorCommission = (await client.api.query.staking.minCommission()).toBigInt()

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: minValidatorBond + minValidatorBond / 10n } }],
        [[bob.address], { providers: 1, data: { free: minNominatorBond + minNominatorBond / 10n } }],
      ],
    },
  })

  ///
  /// Bond funds for both Alice and Bob
  ///

  const bondTx1 = client.api.tx.staking.bond(minValidatorBond, { Staked: null })
  await sendTransaction(bondTx1.signAsync(alice))
  const bondTx2 = client.api.tx.staking.bond(minNominatorBond, { Staked: null })
  await sendTransaction(bondTx2.signAsync(bob))

  await client.dev.newBlock()

  /// Express intent to validate as Alice, and nominate as Bob

  const validateTx = client.api.tx.staking.validate({ commission: minValidatorCommission, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))

  await client.dev.newBlock()

  const nominateTx = client.api.tx.staking.nominate([alice.address])
  await sendTransaction(nominateTx.signAsync(bob))

  await client.dev.newBlock()

  ///
  /// Force unstake Bob, first with a signed origin (which *must* fail), and then a `Root` origin.
  ///

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

  await scheduleInlineCallWithOrigin(
    client,
    forceUnstakeTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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
  const kr = testAccounts
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
  const alice = testAccounts.alice

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
    await scheduleInlineCallWithOrigin(
      client,
      setMinCommissionCall(inc).method.toHex(),
      origin,
      chain.properties.schedulerBlockProvider,
    )

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
  const alice = testAccounts.alice

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
  const preAreNominatorsSlashable = (await client.api.query.staking.areNominatorsSlashable()).toPrimitive() as boolean

  const setStakingConfigsCall = (inc: number) =>
    client.api.tx.staking.setStakingConfigs(
      { Set: preMinNominatorBond + inc },
      { Set: preMinValidatorBond + inc },
      { Set: preMaxNominatorsCount + inc },
      { Set: preMaxValidatorsCount + inc },
      { Set: preChillThreshold + inc },
      { Set: preMinCommission + inc },
      { Set: preMaxStakedRewards + inc },
      { Set: !preAreNominatorsSlashable },
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

  await scheduleInlineCallWithOrigin(
    client,
    setStakingConfigsCall(inc).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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
  const postAreNominatorsSlashable = (await client.api.query.staking.areNominatorsSlashable()).toPrimitive() as boolean

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
  expect(postAreNominatorsSlashable).toBe(!preAreNominatorsSlashable)
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

  const alice = testAccounts.alice
  const bob = testAccounts.bob

  let minValidatorBond = (await client.api.query.staking.minValidatorBond()).toBigInt()
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  if (minValidatorBond === 0n) {
    minValidatorBond = ed * 10n ** 5n
  }

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: (minValidatorBond * 15n) / 10n } }],
        [[bob.address], { providers: 1, data: { free: 100e10 } }],
      ],
    },
  })

  const minCommission = await client.api.query.staking.minCommission()

  ///
  /// Create validator with the current minimum commission
  ///

  const bondTx = client.api.tx.staking.bond(minValidatorBond, { Staked: null })
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
    { Noop: null },
  )

  await scheduleInlineCallWithOrigin(
    client,
    setStakingConfigsTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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
  const alice = testAccounts.alice

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

  await scheduleInlineCallWithOrigin(
    client,
    setValidatorCountCall(100).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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

  await scheduleInlineCallWithOrigin(
    client,
    increaseValidatorCountCall(100).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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

  await scheduleInlineCallWithOrigin(
    client,
    scaleValidatorCountCall(10).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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

  const minNominatorBond = (await client.api.query.staking.minNominatorBond()).toBigInt()
  let minValidatorBond = (await client.api.query.staking.minValidatorBond()).toBigInt()
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  if (minValidatorBond === 0n) {
    minValidatorBond = ed * 10n ** 5n
  }

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
    { Noop: null },
  )

  await scheduleInlineCallWithOrigin(
    client,
    setStakingConfigsCall.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  /// Setup a validator and a nominator, as the account that'll be calling `chill_other`

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: minValidatorBond + minValidatorBond / 10n } }],
        [[bob.address], { providers: 1, data: { free: 100000e10 } }],
        [[charlie.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  /// Alice and Bob bond funds according to their desired roles.

  const nomBondTx = client.api.tx.staking.bond(minNominatorBond, { Staked: null })
  await sendTransaction(nomBondTx.signAsync(bob))
  const valBondTx = client.api.tx.staking.bond(minValidatorBond, { Staked: null })
  await sendTransaction(valBondTx.signAsync(alice))

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
  const setNominatorBond = { Set: minNominatorBond + 1n }
  const setValidatorBond = { Set: minValidatorBond + 1n }

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
        const [a, b, c, d, e, f, g, h] = [...bondLimits, ...countLimits, chillThreshold, ...Array(3).fill(noop)]

        setStakingConfigsCalls.push(client.api.tx.staking.setStakingConfigs(a, b, c, d, e, f, g, h))
      }
    }
  }

  expect(setStakingConfigsCalls.length).toBe(8)

  // Extract the last call, which should be the only one with which `chill_other` can succeed.
  const successfulCall = setStakingConfigsCalls.pop()

  for (const call of setStakingConfigsCalls) {
    await scheduleInlineCallWithOrigin(
      client,
      call.method.toHex(),
      { system: 'Root' },
      chain.properties.schedulerBlockProvider,
    )

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

  await scheduleInlineCallWithOrigin(
    client,
    successfulCall!.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

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
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  let eraChangeBlock: number | undefined
  // Only move to era change if running on a relay chain. If not, this is running on a post-migration Asset Hub,
  // in which this is unnecessary.
  if (chain.properties.schedulerBlockProvider === 'Local') {
    eraChangeBlock = await locateEraChange(client)
    if (eraChangeBlock === undefined) {
      // This test only makes sense to run if there's an active era.
      console.warn('Unable to find era change block, skipping unapplied slash test')
      return
    }

    // Go to the block just before the one in which the era changes, in order to modify the staking ledger with the
    // accounts that will be slashed.
    // If this isn't done, the slash will not be applied.
    await client.dev.setHead(eraChangeBlock - 1)
  }

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalances = existentialDeposit * 10n ** 5n
  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: initialBalances } }],
        [[bob.address], { providers: 1, data: { free: initialBalances } }],
        [[charlie.address], { providers: 1, data: { free: initialBalances } }],
      ],
    },
  })

  const bondAmount = (await client.api.query.staking.minNominatorBond()).toBigInt()
  const slashAmount = bondAmount / 2n

  // Initialize fee tracking map for the 3 stakers
  const stakerFees = new Map<string, bigint>()

  const bondTx = client.api.tx.staking.bond(bondAmount, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  // Track transaction fees for each staker.
  // Ths is needed to keep accurate track of each account's free balance, which should not be affected by this test.
  await updateCumulativeFees(client.api, stakerFees, chain.properties.addressEncoding, chain.properties.feeExtractor)

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()
  let slashKey: any
  let slashValue: any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      slashKey = [activeEra + 1]

      slashValue = [
        {
          validator: alice.address,
          // Less than the bonded funds.
          own: slashAmount,
          others: [
            // Exactly the bonded funds.
            [bob.address, slashAmount * 2n],
            // More than the bonded funds.
            [charlie.address, slashAmount * 3n],
          ],
          reporters: [dave.address],
          payout: bondAmount,
        },
      ]
    })
    .with('NonLocal', () => {
      const slashKeyNewComponent = [
        alice.address,
        // perbill, not relevant for the test
        0,
        // page index, not relevant either
        0,
      ]

      slashKey = [activeEra, slashKeyNewComponent]

      slashValue = {
        validator: alice.address,
        // Less than the bonded funds.
        own: slashAmount,
        others: [
          // Exactly the bonded funds.
          [bob.address, slashAmount * 2n],
          // More than the bonded funds.
          [charlie.address, slashAmount * 3n],
        ],
        reporter: dave.address,
        payout: bondAmount,
      }
    })
    .exhaustive()

  // Insert a slash into storage. The accounts named here as validators/nominators need not have called
  // `validate`/`nominate` - they must only exist in the staking ledger as having bonded funds.
  await client.dev.setStorage({
    Staking: {
      UnappliedSlashes: [[slashKey, slashValue]],
    },
  })

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  await check(aliceFundsPreSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('alice funds pre slash')
  await check(bobFundsPreSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('bob funds pre slash')
  await check(charlieFundsPreSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('charlie funds pre slash')

  // If on an post-migration Asset Hub, `applySlash` can be called, instead of having to move to era change.
  if (client.api.tx.staking.applySlash) {
    // Manually apply the slash.
    const applySlashTx = client.api.tx.staking.applySlash(...slashKey)
    await scheduleInlineCallWithOrigin(
      client,
      applySlashTx.method.toHex(),
      { system: 'Root' },
      chain.properties.schedulerBlockProvider,
    )
  } else {
    // If `applySlash` is not available, the era change method is being used (pre-AHM relay chains).
    // Era-boundary block creation tends to be slow, so these storages are removed.
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
  }

  // With this block, the slash will have been applied.
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'staking', method: 'Slashed' }).toMatchSnapshot('staking slash events')
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' }).toMatchSnapshot('balances slash events')

  // Check free balances specifically
  expect(aliceFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalances - bondAmount - stakerFees.get(encodeAddress(alice.address, chain.properties.addressEncoding))!,
  )
  expect(bobFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalances - bondAmount - stakerFees.get(encodeAddress(bob.address, chain.properties.addressEncoding))!,
  )
  expect(charlieFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalances - bondAmount - stakerFees.get(encodeAddress(charlie.address, chain.properties.addressEncoding))!,
  )

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  // First, verify that all acounts' free funds are untouched.
  // Then, that reserved funds have been slashed.
  // Recall that `bondAmount - slashAmount * 2` is zero.
  // Note that `bondAmount - slashAmount * 3` is negative, and an account's slashable funds are limited
  // to what it bonded.
  // Thus, also zero.

  expect(aliceFundsPostSlash.data.free.toBigInt()).toBe(aliceFundsPostSlash.data.free.toBigInt())
  expect(bobFundsPostSlash.data.free.toBigInt()).toBe(bobFundsPostSlash.data.free.toBigInt())
  expect(charlieFundsPostSlash.data.free.toBigInt()).toBe(charlieFundsPostSlash.data.free.toBigInt())

  await check(aliceFundsPostSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('alice funds post slash')
  await check(bobFundsPostSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('bob funds post slash')
  await check(charlieFundsPostSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('charlie funds post slash')

  expect(aliceFundsPostSlash.data.reserved.toBigInt()).toBe(aliceFundsPreSlash.data.reserved.toBigInt() - slashAmount)
  expect(bobFundsPostSlash.data.reserved.toBigInt()).toBe(bobFundsPreSlash.data.reserved.toBigInt() - bondAmount)
  // Recall again that even though Charlie's slash is 1.5 times his bond, the slash can, at most, tax all he has
  // bonded, and not one unit more.
  expect(charlieFundsPostSlash.data.reserved.toBigInt()).toBe(
    charlieFundsPreSlash.data.reserved.toBigInt() - bondAmount,
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
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  let eraChangeBlock: number | undefined
  if (chain.properties.schedulerBlockProvider === 'Local') {
    eraChangeBlock = await locateEraChange(client)
    if (eraChangeBlock === undefined) {
      // This test only makes sense to run if there's an active era.
      return
    }

    // Go to a block before the one in which the era changes. In the two blocks before it changes,
    // 1. the call to `cancel_deferred_slash` will be scheduled
    // 2. the stakers in question will call `bond`
    await client.dev.setHead(eraChangeBlock - 2)
  }

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const bondAmount = existentialDeposit * 10n ** 5n
  const balance = bondAmount + bondAmount / 10n
  const slashAmount = bondAmount / 2n

  let slashKey: any
  let slashKeyNewComponent: any | undefined
  let slashValue: any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      slashKey = [activeEra + 1]
      slashValue = [
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
      ]
    })
    .with('NonLocal', () => {
      slashKeyNewComponent = [alice.address, 0, 0]
      slashKey = [activeEra, slashKeyNewComponent]
      slashValue = {
        validator: alice.address,
        own: slashAmount,
        others: [
          [bob.address, slashAmount],
          [charlie.address, slashAmount],
        ],
        reporter: dave.address,
        payout: bondAmount,
      }
    })
    .exhaustive()

  // Insert a slash into storage.
  await client.dev.setStorage({
    Staking: {
      UnappliedSlashes: [[slashKey, slashValue]],
    },
  })

  // Fund validators

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: balance } }],
        [[bob.address], { providers: 1, data: { free: balance } }],
        [[charlie.address], { providers: 1, data: { free: balance } }],
      ],
    },
  })

  const bondTx = client.api.tx.staking.bond(bondAmount, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  // Two blocks away from the era change.

  let slash = (await client.api.query.staking.unappliedSlashes(...slashKey)) as any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      expect(slash.length).toBe(1)
    })
    .with('NonLocal', () => {
      expect(slash.toJSON()).toBeDefined()
    })
    .exhaustive()

  let cancelDeferredSlashTx: any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      cancelDeferredSlashTx = client.api.tx.staking.cancelDeferredSlash(activeEra + 1, [0])
    })
    .with('NonLocal', () => {
      cancelDeferredSlashTx = client.api.tx.staking.cancelDeferredSlash(activeEra, [slashKeyNewComponent])
    })
    .exhaustive()
  await scheduleInlineCallWithOrigin(
    client,
    cancelDeferredSlashTx.method.toHex(),
    origin,
    chain.properties.schedulerBlockProvider,
  )

  // Check stakers' bonded funds before the slash would be applied.

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  await check(aliceFundsPreSlash.data.toJSON()).redact({ number: 3 }).toMatchSnapshot('alice funds pre slash')
  await check(bobFundsPreSlash.data.toJSON()).redact({ number: 3 }).toMatchSnapshot('bob funds pre slash')
  await check(charlieFundsPreSlash.data.toJSON()).redact({ number: 3 }).toMatchSnapshot('charlie funds pre slash')

  await client.dev.newBlock()

  // And the slash should have been cancelled.

  slash = (await client.api.query.staking.unappliedSlashes(...slashKey)) as any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      expect(slash.length).toBe(0)
    })
    .with('NonLocal', () => {
      expect(slash.toJSON()).toBeNull()
    })
    .exhaustive()

  // Era-boundary block creation tends to be slow.
  if (chain.properties.schedulerBlockProvider === 'Local') {
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
  }

  // This new block marks the start of the new era.

  // If on an post-migration Asset Hub, `applySlash` can be called, instead of having to move to era change.
  if (chain.properties.schedulerBlockProvider === 'NonLocal') {
    // Manually apply the slash.
    const applySlashTx = client.api.tx.staking.applySlash(...slashKey)
    await scheduleInlineCallWithOrigin(
      client,
      applySlashTx.method.toHex(),
      { system: 'Root' },
      chain.properties.schedulerBlockProvider,
    )
  }

  await client.dev.newBlock()

  // The era should have changed.

  if (chain.properties.schedulerBlockProvider === 'Local') {
    const newActiveEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()
    expect(newActiveEra).toBe(activeEra + 1)
  }

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
  const alice = testAccounts.alice

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
  const alice = testAccounts.alice

  const invulnerables = (await client.api.query.staking.invulnerables())
    .toArray()
    .map((addr) => encodeAddress(addr.toString(), chain.properties.addressEncoding))

  assert(!invulnerables.includes(alice.address))

  const setInvulnerablesTx = client.api.tx.staking.setInvulnerables([alice.address])
  const setInvulnerablesEvents = await sendTransaction(setInvulnerablesTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(setInvulnerablesEvents, 'staking', {
    section: 'system',
    method: 'ExtrinsicFailed',
  }).toMatchSnapshot('set invulnerables events with bad signed origin')

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  expect(dispatchError.isBadOrigin).toBeTruthy()

  // Try it with `StakingAdmin` origin, which is still not enough on Polkadot/Kusama.

  await scheduleInlineCallWithOrigin(
    client,
    setInvulnerablesTx.method.toHex(),
    { Origins: 'StakingAdmin' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  await checkSystemEvents(client, 'scheduler')
    .redact({ redactKeys: /task/ })
    .toMatchSnapshot('events when setting invulnerables with bad staking admin origin')

  const invulnerables2 = (await client.api.query.staking.invulnerables())
    .toArray()
    .map((addr) => encodeAddress(addr.toString(), chain.properties.addressEncoding))

  expect(invulnerables2).toEqual(invulnerables)
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
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  //
  // Locate era change
  //

  let eraChangeBlock: number | undefined
  if (chain.properties.schedulerBlockProvider === 'Local') {
    eraChangeBlock = await locateEraChange(client)
    if (eraChangeBlock === undefined) {
      // This test only makes sense to run if there's an active era.
      console.warn('Unable to find era change block, skipping unapplied slash test')
      return
    }

    // Go to a block before the era change - accounts need to bond, start validating, and invulnerables still need to be
    // set.
    await client.dev.setHead(eraChangeBlock - 3)
  }

  //
  // Fund accounts
  //

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  let minValidatorBond = (await client.api.query.staking.minValidatorBond()).toBigInt()
  const ed = client.api.consts.balances.existentialDeposit.toBigInt()
  if (minValidatorBond === 0n) {
    minValidatorBond = ed * 10n ** 5n
  }
  const initialBalance = minValidatorBond + minValidatorBond / 10n

  await client.dev.setStorage({
    System: {
      account: [
        [[alice.address], { providers: 1, data: { free: initialBalance } }],
        [[bob.address], { providers: 1, data: { free: initialBalance } }],
        [[charlie.address], { providers: 1, data: { free: initialBalance } }],
      ],
    },
  })

  // Bond funds for each validator
  const bondTx = client.api.tx.staking.bond(minValidatorBond, { Staked: null })
  await sendTransaction(bondTx.signAsync(alice))
  await sendTransaction(bondTx.signAsync(bob))
  await sendTransaction(bondTx.signAsync(charlie))

  await client.dev.newBlock()

  // Initialize fee tracking map for the 3 stakers
  const stakerFees = new Map<string, bigint>()

  await updateCumulativeFees(client.api, stakerFees, chain.properties.addressEncoding, chain.properties.feeExtractor)

  // Set them as validators
  const minCommission = await client.api.query.staking.minCommission()
  const validateTx = client.api.tx.staking.validate({ commission: minCommission, blocked: false })
  await sendTransaction(validateTx.signAsync(alice))
  await sendTransaction(validateTx.signAsync(bob))
  await sendTransaction(validateTx.signAsync(charlie))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, stakerFees, chain.properties.addressEncoding, chain.properties.feeExtractor)

  // Sort the addresses to make the test simpler.

  const invulnerables = [alice.address, bob.address, charlie.address].map((addr) =>
    encodeAddress(addr.toString(), chain.properties.addressEncoding),
  )
  invulnerables.sort()

  // Set them as invulnerable using Root origin
  const setInvulnerablesTx = client.api.tx.staking.setInvulnerables(invulnerables)
  await scheduleInlineCallWithOrigin(
    client,
    setInvulnerablesTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  // Verify the invulnerables were set correctly
  const queriedInvulnerables = (await client.api.query.staking.invulnerables()).map((addr) =>
    encodeAddress(addr.toString(), chain.properties.addressEncoding),
  )

  expect(queriedInvulnerables).toEqual(invulnerables)

  //
  // Slash the invulnerable accounts
  //

  // Insert the slash

  const activeEra = (await client.api.query.staking.activeEra()).unwrap().index.toNumber()

  const slashAmount = minValidatorBond / 2n

  let slashKey: any
  let slashValue: any
  match(chain.properties.schedulerBlockProvider)
    .with('Local', () => {
      slashKey = [activeEra + 1]
      slashValue = [
        {
          validator: alice.address,
          own: slashAmount,
          others: [
            [bob.address, slashAmount * 2n],
            [charlie.address, slashAmount * 3n],
          ],
          reporters: [dave.address],
          payout: minValidatorBond,
        },
      ]
    })
    .with('NonLocal', () => {
      const slashKeyNewComponent = [alice.address, 0, 0]
      slashKey = [activeEra, slashKeyNewComponent]
      slashValue = {
        validator: alice.address,
        own: slashAmount,
        others: [
          [bob.address, slashAmount * 2n],
          [charlie.address, slashAmount * 3n],
        ],
        reporter: dave.address,
        payout: minValidatorBond,
      }
    })
    .exhaustive()

  if (chain.properties.schedulerBlockProvider === 'Local') {
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
  }

  // Insert a slash into storage. The accounts named here as validators/nominators need not have called
  // `validate`/`nominate` - they must only exist in the staking ledger as having bonded funds.
  await client.dev.setStorage({
    Staking: {
      UnappliedSlashes: [[slashKey, slashValue]],
    },
  })

  // Pre-slash balance checks

  const aliceFundsPreSlash = await client.api.query.system.account(alice.address)
  const bobFundsPreSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPreSlash = await client.api.query.system.account(charlie.address)

  await check(aliceFundsPreSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('alice funds pre slash')
  await check(bobFundsPreSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('bob funds pre slash')
  await check(charlieFundsPreSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('charlie funds pre slash')

  if (chain.properties.schedulerBlockProvider === 'NonLocal') {
    // Manually apply the slash.
    const applySlashTx = client.api.tx.staking.applySlash(...slashKey)
    await scheduleInlineCallWithOrigin(
      client,
      applySlashTx.method.toHex(),
      { system: 'Root' },
      chain.properties.schedulerBlockProvider,
    )
  }

  // With this block, the slash will have been applied.
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'staking', method: 'Slashed' }).toMatchSnapshot('staking slash events')
  await checkSystemEvents(client, { section: 'balances', method: 'Slashed' }).toMatchSnapshot('balances slash events')

  expect(aliceFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalance - minValidatorBond - stakerFees.get(encodeAddress(alice.address, chain.properties.addressEncoding))!,
  )
  expect(bobFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalance - minValidatorBond - stakerFees.get(encodeAddress(bob.address, chain.properties.addressEncoding))!,
  )
  expect(charlieFundsPreSlash.data.free.toBigInt()).toBe(
    initialBalance -
      minValidatorBond -
      stakerFees.get(encodeAddress(charlie.address, chain.properties.addressEncoding))!,
  )

  const aliceFundsPostSlash = await client.api.query.system.account(alice.address)
  const bobFundsPostSlash = await client.api.query.system.account(bob.address)
  const charlieFundsPostSlash = await client.api.query.system.account(charlie.address)

  await check(aliceFundsPostSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('alice funds post slash')
  await check(bobFundsPostSlash.data.toJSON()).redact({ redactKeys: /free/ }).toMatchSnapshot('bob funds post slash')
  await check(charlieFundsPostSlash.data.toJSON())
    .redact({ redactKeys: /free/ })
    .toMatchSnapshot('charlie funds post slash')

  // Free funds are unaffected by the slash - should be the same, net of fees from bonding and validating.
  expect(aliceFundsPostSlash.data.free.toBigInt()).toBe(
    initialBalance - minValidatorBond - stakerFees.get(encodeAddress(alice.address, chain.properties.addressEncoding))!,
  )
  expect(bobFundsPostSlash.data.free.toBigInt()).toBe(
    initialBalance - minValidatorBond - stakerFees.get(encodeAddress(bob.address, chain.properties.addressEncoding))!,
  )
  expect(charlieFundsPostSlash.data.free.toBigInt()).toBe(
    initialBalance -
      minValidatorBond -
      stakerFees.get(encodeAddress(charlie.address, chain.properties.addressEncoding))!,
  )

  expect(aliceFundsPostSlash.data.reserved.toBigInt()).toBe(aliceFundsPreSlash.data.reserved.toBigInt() - slashAmount)
  expect(bobFundsPostSlash.data.reserved.toBigInt()).toBe(bobFundsPreSlash.data.reserved.toBigInt() - slashAmount * 2n)
  expect(bobFundsPostSlash.data.reserved.toBigInt()).toBe(0n)
  expect(charlieFundsPostSlash.data.reserved.toBigInt()).toBe(
    charlieFundsPreSlash.data.reserved.toBigInt() - slashAmount * 2n,
  )
  expect(charlieFundsPostSlash.data.reserved.toBigInt()).toBe(0n)
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
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
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
        testFn: async () => await stakingLifecycleTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'test force unstaking of nominator',
        testFn: async () => await forceUnstakeTest(chain),
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
        testFn: async () => await setInvulnerablesTest(chain),
      },
    ],
  }
}

/**
 * Tests to fast unstake pallet.
 */
export function fastUnstakeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'fast unstake',
    children: [
      {
        kind: 'test',
        label: 'test fast unstake',
        testFn: async () => await fastUnstakeTest(chain, chain.properties.addressEncoding),
      },
    ],
  }
}

/**
 * Staking E2E test tree - contains base tests to pallet functionality, as well as slashing tests.
 */
export function fullStakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  const basalTestTree = baseStakingE2ETests(chain)
  const slashingTestTree = slashingTests(chain)

  return {
    kind: 'describe' as const,
    label: testConfig.testSuiteName,
    children: [basalTestTree, slashingTestTree],
  }
}

/**
 * Complete staking E2E test tree; contains
 * 1. base tests
 * 2. slashing tests
 * 3. fast unstake tests
 */
export function completeStakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  const basalTestTree = baseStakingE2ETests(chain)
  const slashingTestTree = slashingTests(chain)
  const fastUnstakeTestTree = fastUnstakeTests(chain)

  return {
    kind: 'describe' as const,
    label: testConfig.testSuiteName,
    children: [basalTestTree, slashingTestTree, fastUnstakeTestTree],
  }
}
