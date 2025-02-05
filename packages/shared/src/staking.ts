import { encodeAddress } from '@polkadot/util-crypto'

import { type Chain, defaultAccounts, defaultAccountsSr25199 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { checkEvents } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import type { KeyringPair } from '@polkadot/keyring/types'
import { assert, describe, test } from 'vitest'

/// -------
/// Helpers
/// -------

/// -------
/// -------
/// -------

/**
 * Test that it is not possible to validate before bonding funds.
 */
async function validateNoBondedFundsFailureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  // 10e6 is 1% commission
  const validateTx = client.api.tx.staking.validate({ commission: 10e6, blocked: false })
  const validateEvents = await sendTransaction(validateTx.signAsync(defaultAccounts.alice))

  client.dev.newBlock()

  await checkEvents(validateEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
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
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  // The empty list of targets is only checked *after* the extrinsic's origin, as it should,
  // so anything can be given here.
  const nominateTx = client.api.tx.staking.nominate([defaultAccounts.alice.address])
  const nominateEvents = await sendTransaction(nominateTx.signAsync(defaultAccounts.alice))

  client.dev.newBlock()

  await checkEvents(nominateEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
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
 * Stages:
 *
 * 1. account keypairs (Ed25519) are generated and funded
 * 2. these accounts bond their funds
 * 3. they then choose to become validators
 * 4. another account bonds funds
 * 5. this account nominates the validators
 * 6. one of the validators chills itself
 * 7. this validator forcibly removes its nomination
 * 8. this validator sets its preferences so that it is blocked
 */
async function stakingLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  const [client] = await setupNetworks(chain)

  /// Generate validators, and fund them.

  const validatorCount = 3

  const validators: KeyringPair[] = []

  for (let i = 0; i < validatorCount; i++) {
    const validator = defaultAccounts.keyring.addFromUri(`//Validator_${i}`)
    validators.push(validator)
  }

  await client.dev.setStorage({
    System: {
      account: validators.map((v) => [[v.address], { providers: 1, data: { free: 10000e10 } }]),
    },
  })

  /// Bond each validator's funds

  for (const [index, validator] of validators.entries()) {
    const bondTx = client.api.tx.staking.bond(5000e10, { Staked: null })
    const bondEvents = await sendTransaction(bondTx.signAsync(validator))

    client.dev.newBlock()

    await checkEvents(bondEvents, 'staking').toMatchSnapshot(`validator ${index} bond events`)
  }

  for (const [index, validator] of validators.entries()) {
    // 10e6 is 0.1% commission
    const validateTx = client.api.tx.staking.validate({ commission: 10e6, blocked: false })
    const validateEvents = await sendTransaction(validateTx.signAsync(validator))

    client.dev.newBlock()

    await checkEvents(validateEvents, 'staking').toMatchSnapshot(`validator ${index} validate events`)
  }

  /// Bond another account's funds

  const alice = (await defaultAccountsSr25199).keyring.createFromUri('//Alice')

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000e10 } }]],
    },
  })

  const bondTx = client.api.tx.staking.bond(10000e10, { Staked: null })
  const bondEvents = await sendTransaction(bondTx.signAsync(alice))

  client.dev.newBlock()

  await checkEvents(bondEvents, 'staking').toMatchSnapshot('nominator bond events')

  /// Nominate the validators

  const eraNumberOpt = await client.api.query.staking.currentEra()
  assert(eraNumberOpt.isSome)
  const eraNumber = eraNumberOpt.unwrap()

  // Necessary to avoid `ResponseError: {"invalid":{"stale":null}}` errors
  const nonce = await client.api.rpc.system.accountNextIndex(alice.address)

  const nominateTx = client.api.tx.staking.nominate(validators.map((v) => v.address))
  const nominateEvents = await sendTransaction(nominateTx.signAsync(alice, { nonce }))

  client.dev.newBlock()

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

  /// Chill one of the validators

  const chillTx = client.api.tx.staking.chill()
  const chillEvents = await sendTransaction(chillTx.signAsync(validators[0]))

  client.dev.newBlock()

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

  /// Chilled validator wishes to remove all its nominations

  const validatorZeroNonce = await client.api.rpc.system.accountNextIndex(validators[0].address)

  const kickTx = client.api.tx.staking.kick([alice.address])
  const kickEvents = await sendTransaction(kickTx.signAsync(validators[0], { nonce: validatorZeroNonce }))

  client.dev.newBlock()

  await checkEvents(kickEvents, 'staking').toMatchSnapshot('kick events')

  /// Check the nominator's nominations once again

  nominationsOpt = await client.api.query.staking.nominators(alice.address)
  assert(nominationsOpt.isSome)
  const nominationsPostKick = nominationsOpt.unwrap()

  assert(nominationsPostKick.submittedIn.eq(eraNumber))
  assert(nominationsPostKick.suppressed.isFalse)
  assert(nominationsPostKick.targets.length === validators.length - 1)

  // Check that the kicked validator is *not* in the nominations.
  const targetsPostKick = nominationsPostKick.targets.map((t) => encodeAddress(t.toString(), addressEncoding))
  assert(!targetsPostKick.includes(encodeAddress(validators[0].address, addressEncoding)))
}

export function stakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, () => {
    test('trying to become a validator with no bonded funds fails', async () => {
      await validateNoBondedFundsFailureTest(chain)
    })

    test('trying to nominate with no bonded funds fails', async () => {
      await nominateNoBondedFundsFailureTest(chain)
    })

    test('staking lifecycle', async () => {
      await stakingLifecycleTest(chain, testConfig.addressEncoding)
    })
  })
}
