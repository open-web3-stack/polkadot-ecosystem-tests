/**
 * Utilities for people chain tests - both Polkadot and Kusama.
 *
 * Tests are defined here, parametrized over relay/parachain datatypes, and each corresponding
 * implementing module can then instantiates tests with the appropriate chains inside a `describe`.
 *
 * Also contains helpers used in those tests.
 * @module
 */

import { assert, describe, test } from 'vitest'

import type { StorageValues } from '@acala-network/chopsticks'
import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25199 } from '@e2e-test/networks'

import type { ApiPromise } from '@polkadot/api'
import type { u128 } from '@polkadot/types'
import type { PalletIdentityLegacyIdentityInfo, PalletIdentityRegistration } from '@polkadot/types/lookup'
import { encodeAddress } from '@polkadot/util-crypto'
import type { HexString } from '@polkadot/util/types'

import { type Client, setupNetworks } from '@e2e-test/shared'
import { check, checkEvents, checkSystemEvents, xcmSendTransact } from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Example identity to be used in tests.
 */
const identity = {
  email: { Raw: 'test_address@test.io' },
  legal: { Raw: 'FirstName LastName' },
  matrix: { Raw: '@test:test_server.io' },
  twitter: { Raw: '@test_twitter' },
  github: { Raw: 'test_github' },
  discord: { Raw: 'test_discord' },
  web: { Raw: 'http://test.te/me' },
  image: { Raw: 'test' },
  display: { Raw: 'Test Display' },
  pgpFingerprint: 'a1b2c3d4e5f6g7h8i9j1',
}

/**
 * Send an XCM message from the relay chain to the people parachain.
 * This message contains a `Transact` with an extrinsic to be executed in the parachain, with a `Root` origin.
 */
async function sendXcmFromRelayToPeople(
  relayClient: {
    api: ApiPromise
    dev: { setStorage: (values: StorageValues, blockHash?: string) => Promise<any> }
  },
  call: HexString,
  requireWeightAtMost?: { proofSize: string; refTime: string },
): Promise<any> {
  await xcmSendTransact(
    relayClient,
    {
      parents: 0,
      interior: {
        X1: [
          {
            Parachain: 1004,
          },
        ],
      },
    },
    call,
    { origin: { system: 'Root' }, originKind: 'SuperUser' },
    requireWeightAtMost,
  )
}

/// -------
/// -------
/// -------

/**
 * Test the process of
 * 1. setting an identity,
 * 2. requesting a judgement,
 * 3. providing it from the previously queried registrar
 * 4. verifying the state of on-chain data
 *
 * @param peopleChain People parachain where the entire process is run.
 */
export async function setIdentityThenRequestAndProvideJudgement<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleClient: Client<TCustom, TInitStorages>) {
  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Bob's on-chain identity
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  const setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  const identityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(identityInfoReply.isSome, 'Failed to query set identity')
  const registrationInfo: PalletIdentityRegistration = identityInfoReply.unwrap()[0]
  const registrationIdentityInfo: PalletIdentityLegacyIdentityInfo = registrationInfo.info

  check(registrationIdentityInfo).toMatchSnapshot('identity right after set identity')

  // Quick sanity check - in the previous line, the fetched identity is compared versus the previous
  // test run's snapshot, whereas now it is compared to the actual JS object defined above.
  check(registrationIdentityInfo.toHuman()).toMatchObject(identity)
  check(registrationInfo.judgements).toMatchObject([])

  /**
   * Request a judgement on identity that was just set
   */

  // Recall that, in the people chain's test storage, Alice is the 0th registrar.
  const reqJudgTx = txApi.identity.requestJudgement(0, 1)
  const reqJudgEvents = await sendTransaction(reqJudgTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-request identity information
   */

  await checkEvents(reqJudgEvents, 'identity').toMatchSnapshot('judgement request events')

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(provisionalIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const provisionalRegistrationInfo = provisionalIdentityInfoReply.unwrap()[0]

  const provisionalIdentityInfo: PalletIdentityLegacyIdentityInfo = provisionalRegistrationInfo.info

  // The only identity object compared versus the origin `const identity` is the one queried
  // after registration.
  // That is also the only identity written to the test's snapshot.
  // At the point of judgement request and beyond, the latest identity fetched from chain can be
  // compared with the previously fetched identity, establishing a chain of equalities.
  check(provisionalIdentityInfo.toJSON()).toMatchObject(registrationIdentityInfo.toJSON())
  check(provisionalRegistrationInfo.judgements).toMatchObject([
    [
      0,
      {
        feePaid: 1,
      },
    ],
  ])

  /**
   * Provide a judgement on the previous request
   */

  const provJudgTx = txApi.identity.provideJudgement(
    0,
    defaultAccountsSr25199.bob.address,
    'Reasonable',
    registrationIdentityInfo.hash.toHex(),
  )
  const provJudgEvents = await sendTransaction(provJudgTx.signAsync(defaultAccountsSr25199.alice))

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-judgement identity information.
   */

  await checkEvents(provJudgEvents, 'identity').toMatchSnapshot('judgement provision events')

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(judgedIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const judgedRegistrationInfo = judgedIdentityInfoReply.unwrap()[0]

  const judgedIdentityInfo: PalletIdentityLegacyIdentityInfo = judgedRegistrationInfo.info
  await check(judgedIdentityInfo.toJSON()).toMatchObject(provisionalIdentityInfo.toJSON())
  check(judgedRegistrationInfo.judgements).toMatchObject([
    [
      0,
      {
        reasonable: null,
      },
    ],
  ])
}

/**
 * Test the process of
 * 1. setting an identity,
 * 2. requesting a judgement to one registrar, and have it provided as Reasonable
 * 3. requesting a judgement from another registrar, without it being provided
 * 4. reset one's identity
 * 5. check that the only the pending judgement remains
 *
 * @param peopleChain People parachain where the entire process is run.
 */
export async function setIdentityRequestJudgementTwiceThenResetIdentity<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleClient: Client<TCustom, TInitStorages>) {
  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Eve's on-chain identity
   */

  await peopleClient.dev.setStorage({
    System: {
      account: [[[defaultAccountsSr25199.eve.address], { providers: 1, data: { free: 1e10 } }]],
    },
  })

  let setIdTx = txApi.identity.setIdentity(identity)
  let setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccountsSr25199.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  const identityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.eve.address)
  assert(identityInfoReply.isSome, 'Failed to query set identity')
  const registrationInfo: PalletIdentityRegistration = identityInfoReply.unwrap()[0]

  const identityInfo = registrationInfo.info
  await check(registrationInfo.info).toMatchSnapshot('identity right after set identity')

  /**
   * Request judgements on identity that was just set
   */

  // Recall that, in the people chain's test storage, Alice is the 0th registrar, and Bob is the
  // 1st. Alice has a fee of 1 unit, Bob of 0.
  const reqJudgAliceTx = txApi.identity.requestJudgement(0, 1)
  const reqJudgBobTx = txApi.identity.requestJudgement(1, 0)

  // Batch txs to request 2 judgements in 1 tx
  const batchedTx = peopleClient.api.tx.utility.batchAll([reqJudgAliceTx.method.toHex(), reqJudgBobTx.method.toHex()])
  const batchedEvents = await sendTransaction(batchedTx.signAsync(defaultAccountsSr25199.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(batchedEvents, 'identity').toMatchSnapshot('double judgment request events')

  /**
   * Provide a judgement on Eve's request
   */

  const provJudgTx = txApi.identity.provideJudgement(
    0,
    defaultAccountsSr25199.eve.address,
    'Reasonable',
    identityInfo.hash.toHex(),
  )
  const provJudgEvents = await sendTransaction(provJudgTx.signAsync(defaultAccountsSr25199.alice))

  await peopleClient.chain.newBlock()

  checkEvents(provJudgEvents, 'identity').toMatchSnapshot('judgement provision events')

  /**
   * Compare pre and post-judgement identity information.
   */

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.eve.address)
  assert(judgedIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const judgedRegistrationInfo = judgedIdentityInfoReply.unwrap()[0]
  const judgedIdentityInfo: PalletIdentityLegacyIdentityInfo = judgedRegistrationInfo.info

  await check(judgedIdentityInfo.toHuman()).toMatchObject(identity)

  assert(identityInfo.eq(judgedIdentityInfo), 'Identity information changed after judgement')
  check(judgedRegistrationInfo.judgements).toMatchSnapshot("eve's judgements after one has been provided")
  check(judgedRegistrationInfo.judgements.sort()).toMatchObject([
    [
      0,
      {
        reasonable: null,
      },
    ],
    [
      1,
      {
        feePaid: 0,
      },
    ],
  ])

  /**
   * Reset Eve's identity
   */

  // It is acceptable to use the same identity as before - what matters is the submission of an
  // `set_identity` extrinsic.
  setIdTx = txApi.identity.setIdentity(identity)
  setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccountsSr25199.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity twice events')

  /**
   * Requery judgement data
   */

  const resetIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.eve.address)
  assert(resetIdentityInfoReply.isSome, 'Failed to query identity after new identity request')
  const resetRegistrationInfo = resetIdentityInfoReply.unwrap()[0]
  const resetIdentityInfo: PalletIdentityLegacyIdentityInfo = resetRegistrationInfo.info

  await check(resetIdentityInfo.toJSON()).toMatchObject(judgedIdentityInfo.toJSON())

  await check(resetRegistrationInfo.judgements).toMatchObject([
    [
      1,
      {
        feePaid: 0,
      },
    ],
  ])
}

/**
 * Test the process of
 * 1. setting an identity,
 * 2. requesting a judgement,
 * 3. cancelling the previous request, and
 * 4. clearing the identity
 *
 * @param peopleChain People parachain where the entire process is run.
 */
export async function setIdentityThenRequesThenCancelThenClear<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleClient: Client<TCustom, TInitStorages>) {
  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Bob's on-chain identity
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  const setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  const identityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(identityInfoReply.isSome, 'Failed to query set identity')
  const registrationInfo: PalletIdentityRegistration = identityInfoReply.unwrap()[0]

  await check(registrationInfo.judgements).toMatchObject([])

  /**
   * Request a judgement on identity that was just set
   */

  const reqJudgTx = txApi.identity.requestJudgement(0, 1)
  const reqJudgEvents = await sendTransaction(reqJudgTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(reqJudgEvents, 'identity').toMatchSnapshot('judgement request events')

  /**
   * Check post-request identity state
   */

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(provisionalIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const provisionalRegistrationInfo = provisionalIdentityInfoReply.unwrap()[0]

  // Recall that Alice is the 0th registrar, with a minimum fee of 1.
  await check(provisionalRegistrationInfo.judgements.toJSON()).toMatchObject([
    [
      0,
      {
        feePaid: 1,
      },
    ],
  ])

  /**
   * Cancel the previous judgement request
   */

  const cancelJudgTx = txApi.identity.cancelRequest(0)
  const cancelJudgEvents = await sendTransaction(cancelJudgTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(cancelJudgEvents, 'identity').toMatchSnapshot('cancel judgement events')

  const newIdentityInfoReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(newIdentityInfoReply.isSome, 'Failed to query identity after judgement cancellation')
  const newRegistrationInfo: PalletIdentityRegistration = newIdentityInfoReply.unwrap()[0]

  await check(newRegistrationInfo.judgements.toJSON()).toMatchObject([])

  /**
   * Clear the tentatively set identity
   */

  const clearIdTx = txApi.identity.clearIdentity()
  const clearIdEvents = await sendTransaction(clearIdTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(clearIdEvents, 'identity').toMatchSnapshot('clear identity events')

  const identityInfoNullReply = await querier.identity.identityOf(defaultAccountsSr25199.bob.address)
  assert(identityInfoNullReply.isNone, "Bob's identity should be empty after it is cleared")
}

/**
 * Test the process of
 * 1. setting an identity,
 * 2. having 2 other identities become that identity's subidentities,
 * 3. removing one identity through the supraidentity
 * 4. having another subidentity remove itself
 *
 * @param peopleChain People parachain where the entire process is run.
 * @param addressEncoding The network's required address encoding. See https://github.com/paritytech/ss58-registry/blob/main/ss58-registry.json
 */
export async function setIdentityThenAddSubsThenRemove<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleClient: Client<TCustom, TInitStorages>, addressEncoding: number) {
  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Alice and Bob's on-chain identites
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  const setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccountsSr25199.alice))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  /**
   * Add Bob and Charlie as subidentities of Alice
   */

  const setSubsTx = txApi.identity.setSubs([
    [defaultAccountsSr25199.bob.address, { Raw: 'bob' }],
    [defaultAccountsSr25199.charlie.address, { Raw: 'charlie' }],
  ])
  const setSubsEvents = await sendTransaction(setSubsTx.signAsync(defaultAccountsSr25199.alice))

  // Withouth a second block being mined, the `setSubs` extrinsic will not take effect.
  await peopleClient.dev.newBlock({ count: 1 })

  // `pallet_identity::set_subs` does not emit any events at the moment (Oct 2024), so this will
  // be empty in the snapshot.
  await checkEvents(setSubsEvents, 'identity').toMatchSnapshot('set subidentities events')

  /**
   * Check Alice, Bob and Charlie's statuses regarding sub/super identities
   */

  let aliceSubData = await querier.identity.subsOf(defaultAccountsSr25199.alice.address)
  const doubleIdDepositAmnt: u128 = aliceSubData[0]

  await check(aliceSubData).redact({ number: 10 }).toMatchSnapshot("alice's two subidentities")
  await check(aliceSubData[1]).toMatchObject([
    encodeAddress(defaultAccountsSr25199.bob.address, addressEncoding),
    encodeAddress(defaultAccountsSr25199.charlie.address, addressEncoding),
  ])

  let bobSuperData = await querier.identity.superOf(defaultAccountsSr25199.bob.address)
  await check(bobSuperData).toMatchSnapshot("bob's superaccount data")
  assert(bobSuperData.isSome)
  await check(bobSuperData.unwrap().toJSON()).toMatchObject([
    encodeAddress(defaultAccountsSr25199.alice.publicKey, addressEncoding),
    // 'bob' in hex
    { raw: '0x626f62' },
  ])

  let charlieSuperData = await querier.identity.superOf(defaultAccountsSr25199.charlie.address)
  await check(charlieSuperData).toMatchSnapshot("charlie's superaccount data")
  assert(charlieSuperData.isSome)
  await check(charlieSuperData.unwrap().toJSON()).toMatchObject([
    encodeAddress(defaultAccountsSr25199.alice.publicKey, addressEncoding),
    // 'charlie' in hex
    { raw: '0x636861726c6965' },
  ])

  /**
   * Rename Charles' subidentity (as Alice)
   */

  const renameSubTx = txApi.identity.renameSub(defaultAccountsSr25199.charlie.address, { Raw: 'carolus' })
  const renameSubEvents = await sendTransaction(renameSubTx.signAsync(defaultAccountsSr25199.alice))

  await peopleClient.dev.newBlock({ count: 1 })

  await checkEvents(renameSubEvents, 'identity').toMatchSnapshot('rename subidentity events')

  charlieSuperData = await querier.identity.superOf(defaultAccountsSr25199.charlie.address)
  // `pallet_identity::rename_sub` does not emit any events at the moment (Oct 2024), so this will
  // be empty in the snapshot.
  await check(charlieSuperData).toMatchSnapshot("carolus' superaccount data")

  assert(charlieSuperData.isSome)
  await check(charlieSuperData.unwrap().toJSON()).toMatchObject([
    encodeAddress(defaultAccountsSr25199.alice.publicKey, addressEncoding),
    // 'carolus' in hex
    { raw: '0x6361726f6c7573' },
  ])

  /**
   * As Alice, remove Charlie as a subidentity
   */

  const removeSubTx = txApi.identity.removeSub(defaultAccountsSr25199.charlie.address)
  const removeSubEvents = await sendTransaction(removeSubTx.signAsync(defaultAccountsSr25199.alice))

  await peopleClient.dev.newBlock({ count: 1 })

  await checkEvents(removeSubEvents, 'identity').toMatchSnapshot('remove subidentity events')

  aliceSubData = await querier.identity.subsOf(defaultAccountsSr25199.alice.address)
  await check(aliceSubData).redact({ number: 10 }).toMatchSnapshot('subidentity data after 1st subid removal')
  assert(aliceSubData[0].lt(doubleIdDepositAmnt), "After removing one subidentity, the other's deposit should remain")
  await check(aliceSubData[1]).toMatchObject([encodeAddress(defaultAccountsSr25199.bob.address, addressEncoding)])

  charlieSuperData = await querier.identity.superOf(defaultAccountsSr25199.charlie.address)
  assert(charlieSuperData.isNone, 'Charlie should no longer have a supraidentity')

  /**
   * As Bob, remove oneself from Alice's subidentities
   */

  const quitSubTx = txApi.identity.quitSub()
  const quitSubEvents = await sendTransaction(quitSubTx.signAsync(defaultAccountsSr25199.bob))

  await peopleClient.dev.newBlock({ count: 1 })

  await checkEvents(quitSubEvents, 'identity').toMatchSnapshot('quit subidentity events')

  aliceSubData = await querier.identity.subsOf(defaultAccountsSr25199.alice.address)
  await check(aliceSubData).toMatchObject([0, []])

  bobSuperData = await querier.identity.superOf(defaultAccountsSr25199.bob.address)
  await check(bobSuperData.toJSON()).toMatchObject(null, 'Bob should no longer have a supraidentity')
}

/**
 * Test the process of adding a registrar to a people's parachain.
 *
 * It uses the parachain's relay to send an XCM message forcing execution of the normally gated
 * `addRegistrar` call as `SuperUser`.
 *
 * @param relayChain Relay chain on which the test will be run: Polkadot or Kusama.
 * Must have `xcmpPallet` available.
 * @param peopleChain People parachain whose registrars will be modified and asserted upon.
 */
export async function addRegistrarViaRelayAsRoot<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayClient: Client<TCustom, TInitStoragesRelay>,
  peopleClient: Client<TCustom, TInitStoragesPara>,
  addressEncoding: number,
) {
  /**
   * Executing extrinsic with wrong origin
   */

  await peopleClient.dev.setStorage({
    System: {
      account: [[[defaultAccountsSr25199.charlie.address], { providers: 1, data: { free: 1e10 } }]],
    },
  })

  const addRegistrarTx = peopleClient.api.tx.identity.addRegistrar(defaultAccountsSr25199.charlie.address)
  await sendTransaction(addRegistrarTx.signAsync(defaultAccountsSr25199.charlie))

  // First, try sending the `add_registrar` call without the proper origin: just as `Signed`,
  // which is insufficient.
  await peopleClient.dev.newBlock()

  // The recorded event should be `ExtrinsicFailed` with a `BadOrigin`.
  await checkSystemEvents(peopleClient, 'system')
    .redact({ number: 1 })
    .toMatchSnapshot('call add registrar with wrong origin')

  let events = await peopleClient.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(peopleClient.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError
  assert(dispatchError.isBadOrigin)

  /**
   * XCM from relay chain
   */

  const encodedPeopleChainCalldata: HexString = addRegistrarTx.method.toHex()

  await sendXcmFromRelayToPeople(relayClient, encodedPeopleChainCalldata, { proofSize: '10000', refTime: '1000000000' })

  /**
   * Checks to people parachain's registrar list at several points of interest.
   */

  // Recall that, in the people chain used for tests, 2 initial test registrars exist.
  const registrars = [
    {
      account: encodeAddress(defaultAccountsSr25199.alice.address, addressEncoding),
      fee: 1,
      fields: 0,
    },

    {
      account: encodeAddress(defaultAccountsSr25199.bob.address, addressEncoding),
      fee: 0,
      fields: 0,
    },
  ]

  const registrarsBeforeRelayBlock = await peopleClient.api.query.identity.registrars()

  await check(registrarsBeforeRelayBlock).toMatchSnapshot('registrars before relay block')
  await check(registrarsBeforeRelayBlock).toMatchObject(
    registrars,
    'Registrars before relay chain block differ from expected',
  )

  // Create a new block in the relay chain so that the previous XCM call can take effect in the
  // parachain.
  await relayClient.dev.newBlock()

  const registrarsAfterRelayBlock = await peopleClient.api.query.identity.registrars()

  await check(registrarsAfterRelayBlock).toMatchSnapshot('registrars after relay block')
  await check(registrarsAfterRelayBlock).toMatchObject(
    registrars,
    'Registrars after relay chain block differ from expected',
  )

  // Also advance a block in the parachain - otherwise, the XCM call's effect would not be visible.
  await peopleClient.dev.newBlock()

  // Check that, in the people chain, the single event emitted in the last block was for the registrar addition.

  events = await peopleClient.api.query.system.events()

  const peopleEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'identity'
  })

  assert(peopleEvents.length === 1, 'adding a registrar should emit 1 event')

  const registrarEvent = peopleEvents[0]
  assert(peopleClient.api.events.identity.RegistrarAdded.is(registrarEvent.event))

  const [registrarIndex] = registrarEvent.event.data
  assert(registrarIndex.eq(2), 'new registrar index should be 2')

  registrars.push({
    account: encodeAddress(defaultAccountsSr25199.charlie.address, addressEncoding),
    fee: 0,
    fields: 0,
  })

  const registrarsAfterParaBlock = await peopleClient.api.query.identity.registrars()

  await check(registrarsAfterParaBlock).toMatchSnapshot('registrars after parachain block')
  await check(registrarsAfterParaBlock).toMatchObject(
    registrars,
    'Registrars after parachain chain block differ from expected',
  )
}

/**
 * Test runner for people chains' E2E tests.
 *
 * Tests that are meant to be run in a people chain *must* be added to as a `vitest.test` to the
 * `describe` runner this function creates.
 *
 * @param topLevelDescription A description of this test runner e.g. "Polkadot People E2E tests"
 * @param relayChain The relay chain to be used by these tests
 * @param peopleChain The people's chain associated to the previous `relayChain`
 */
export function peopleChainE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  peopleChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string; addressEncoding: number },
) {
  describe(testConfig.testSuiteName, async () => {
    const [relayClient, peopleClient] = await setupNetworks(relayChain, peopleChain)

    test('setting on-chain identity and requesting judgement should work', async () => {
      await setIdentityThenRequestAndProvideJudgement(peopleClient)
    })

    test('setting an on-chain identity, requesting 2 judgements, having 1 provided, and then resetting the identity should work', async () => {
      await setIdentityRequestJudgementTwiceThenResetIdentity(peopleClient)
    })

    test('setting on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
      await setIdentityThenRequesThenCancelThenClear(peopleClient)
    })

    test('setting on-chain identity, adding sub-identities, removing one, and having another remove itself should work', async () => {
      await setIdentityThenAddSubsThenRemove(peopleClient, testConfig.addressEncoding)
    })

    test('adding a registrar as root from the relay chain works', async () => {
      await addRegistrarViaRelayAsRoot(relayClient, peopleClient, testConfig.addressEncoding)
    })
  })
}
