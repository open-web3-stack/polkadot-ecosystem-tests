/**
 * Utilities for people chain tests - both Polkadot and Kusama.
 *
 * Tests are defined here, parametrized over relay/parachain datatypes, and each corresponding
 * implementing module can then instantiates tests with the appropriate chains inside a `describe`.
 *
 * Also contains helpers used in those tests.
 * @module
 */

import { BN } from 'bn.js'
import { assert, describe, test } from 'vitest'

import { StorageValues } from '@acala-network/chopsticks'
import { sendTransaction } from '@acala-network/chopsticks-testing'

import { Chain, defaultAccounts } from '@e2e-test/networks'

import { ApiPromise } from '@polkadot/api'
import { ITuple } from '@polkadot/types/types'
import { Option, Vec, u128, u32 } from '@polkadot/types'
import {
  PalletIdentityJudgement,
  PalletIdentityLegacyIdentityInfo,
  PalletIdentityRegistrarInfo,
  PalletIdentityRegistration,
} from '@polkadot/types/lookup'

import { check, checkEvents } from './helpers/index.js'
import { setupNetworks } from './setup.js'

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
>(peopleChain: Chain<TCustom, TInitStorages>) {
  const [peopleClient] = await setupNetworks(peopleChain)

  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Bob's on-chain identity
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  const setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccounts.bob))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  const identityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
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
  const reqJudgEvents = await sendTransaction(reqJudgTx.signAsync(defaultAccounts.bob))

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-request identity information
   */

  await checkEvents(reqJudgEvents, 'identity').toMatchSnapshot('judgement request events')

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
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
    defaultAccounts.bob.address,
    'Reasonable',
    registrationIdentityInfo.hash.toHex(),
  )
  const provJudgEvents = await sendTransaction(provJudgTx.signAsync(defaultAccounts.alice))

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-judgement identity information.
   */

  await checkEvents(provJudgEvents, 'identity').toMatchSnapshot('judgement provision events')

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
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
>(peopleChain: Chain<TCustom, TInitStorages>) {
  const [peopleClient] = await setupNetworks(peopleChain)

  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Eve's on-chain identity
   */

  let setIdTx = txApi.identity.setIdentity(identity)
  let setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccounts.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity events')

  const identityInfoReply = await querier.identity.identityOf(defaultAccounts.eve.address)
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
  const batchedEvents = await sendTransaction(batchedTx.signAsync(defaultAccounts.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(batchedEvents, 'identity').toMatchSnapshot('double judgment request events')

  /**
   * Provide a judgement on Eve's request
   */

  const provJudgTx = txApi.identity.provideJudgement(
    0,
    defaultAccounts.eve.address,
    'Reasonable',
    identityInfo.hash.toHex(),
  )
  const provJudgEvents = await sendTransaction(provJudgTx.signAsync(defaultAccounts.alice))

  await peopleClient.chain.newBlock()

  checkEvents(provJudgEvents, 'identity').toMatchSnapshot('judgement provision events')

  /**
   * Compare pre and post-judgement identity information.
   */

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.eve.address)
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
  setIdEvents = await sendTransaction(setIdTx.signAsync(defaultAccounts.eve))

  await peopleClient.chain.newBlock()

  await checkEvents(setIdEvents, 'identity').toMatchSnapshot('set identity twice events')

  /**
   * Requery judgement data
   */

  const resetIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.eve.address)
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
>(peopleChain: Chain<TCustom, TInitStorages>) {
  const [peopleClient] = await setupNetworks(peopleChain)

  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Bob's on-chain identity
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  await setIdTx.signAndSend(defaultAccounts.bob)

  await peopleClient.chain.newBlock()

  const identityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
  assert(identityInfoReply.isSome, 'Failed to query set identity')
  const registrationInfo: PalletIdentityRegistration = identityInfoReply.unwrap()[0]

  assert(
    registrationInfo.judgements.isEmpty,
    'Error: immediately after `setIdentity`, there should be no judgments on the identity.',
  )

  /**
   * Request a judgement on identity that was just set
   */

  const reqJudgTx = txApi.identity.requestJudgement(0, 1)
  await reqJudgTx.signAndSend(defaultAccounts.bob)

  await peopleClient.chain.newBlock()

  /**
   * Check post-request identity state
   */

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
  assert(provisionalIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const provisionalRegistrationInfo = provisionalIdentityInfoReply.unwrap()[0]

  assert(provisionalRegistrationInfo.judgements.length === 1, 'There should only be 1 judgement after requesting it.')

  // Freely indexing into the `Vec` here, as it *should* have 1 element.
  const provisionalJudgement: ITuple<[u32, PalletIdentityJudgement]> = provisionalRegistrationInfo.judgements[0]
  assert(provisionalJudgement[0].eq('0'), 'Alice, to whom a request was made, should be the 0th registrar')
  assert(provisionalJudgement[1].isFeePaid, 'The judgement immediately after a request should be "FeePaid"')
  assert(provisionalJudgement[1].asFeePaid.eq(1), "Alice's registrar fee should be set to `1`")

  /**
   * Cancel the previous judgement request
   */

  const cancelJudgTx = txApi.identity.cancelRequest(0)
  await cancelJudgTx.signAndSend(defaultAccounts.bob)

  await peopleClient.chain.newBlock()

  const newIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
  assert(newIdentityInfoReply.isSome, 'Failed to query set identity')
  const newRegistrationInfo: PalletIdentityRegistration = newIdentityInfoReply.unwrap()[0]

  assert(
    newRegistrationInfo.judgements.isEmpty,
    'Error: immediately after `cancelRequest`, there should be no judgments on the identity.',
  )

  /**
   * Clear the tentatively set identity
   */

  const clearIdTx = txApi.identity.clearIdentity()
  await clearIdTx.signAndSend(defaultAccounts.bob)

  await peopleClient.chain.newBlock()

  const identityInfoNullReply = await querier.identity.identityOf(defaultAccounts.bob.address)
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
 */
export async function setIdentityThenAddSubsThenRemove<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleChain: Chain<TCustom, TInitStorages>) {
  const [peopleClient] = await setupNetworks(peopleChain)

  const querier = peopleClient.api.query
  const txApi = peopleClient.api.tx

  /**
   * Set Alice and Bob's on-chain identites
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  await setIdTx.signAndSend(defaultAccounts.alice)

  await peopleClient.chain.newBlock()

  /**
   * Add Bob and Charlie as subidentities of Alice
   */

  const setSubsTx = txApi.identity.setSubs([
    [defaultAccounts.bob.address, { Raw: 'bob' }],
    [defaultAccounts.charlie.address, { Raw: 'charlie' }],
  ])
  setSubsTx.signAndSend(defaultAccounts.alice)

  // Withouth a second block being mined, the `setSubs` extrinsic will not take effect.
  await peopleClient.dev.newBlock({ count: 2 })

  /**
   * Check Alice, Bob and Charlie's statuses regarding sub/super identities
   */

  let aliceSubData = await querier.identity.subsOf(defaultAccounts.alice.address)
  const doubleIdDepositAmnt: u128 = aliceSubData[0]
  assert(
    aliceSubData[0].gt(new BN(0)) && aliceSubData[0].isEven,
    'Alice added two subidentities, so the subaccount deposit should be even',
  )
  assert(
    aliceSubData[1].eq([defaultAccounts.bob.address, defaultAccounts.charlie.address]),
    'Alice should have 2 subidentities',
  )

  let bobSuperData = await querier.identity.superOf(defaultAccounts.bob.address)
  assert(bobSuperData.isSome)
  assert(bobSuperData.unwrap()[0].eq(defaultAccounts.alice.address))
  assert(bobSuperData.unwrap()[1].eq({ Raw: 'bob' }))

  let charlieSuperData = await querier.identity.superOf(defaultAccounts.charlie.address)
  assert(charlieSuperData.isSome)
  assert(charlieSuperData.unwrap()[0].eq(defaultAccounts.alice.address))
  assert(charlieSuperData.unwrap()[1].eq({ Raw: 'charlie' }))

  /**
   * Rename Charles' subidentity (as Alice)
   */

  const renameSubTx = txApi.identity.renameSub(defaultAccounts.charlie.address, { Raw: 'carolus' })
  renameSubTx.signAndSend(defaultAccounts.alice)

  // Withouth a second block being mined, the `renameSub` extrinsic will not take effect.
  await peopleClient.dev.newBlock({ count: 2 })

  charlieSuperData = await querier.identity.superOf(defaultAccounts.charlie.address)
  assert(charlieSuperData.isSome)
  assert(charlieSuperData.unwrap()[0].eq(defaultAccounts.alice.address))
  assert(charlieSuperData.unwrap()[1].eq({ Raw: 'carolus' }), "Subidentity's name remains unchanged")

  /**
   * As Alice, remove Charlie as a subidentity
   */

  const removeSubTx = txApi.identity.removeSub(defaultAccounts.charlie.address)
  removeSubTx.signAndSend(defaultAccounts.alice)

  // Withouth a second block being mined, the `removeSub` extrinsic will not take effect.
  await peopleClient.dev.newBlock({ count: 2 })

  aliceSubData = await querier.identity.subsOf(defaultAccounts.alice.address)
  assert(aliceSubData[0].lt(doubleIdDepositAmnt), "After removing one subidentity, the other's deposit should remain")
  assert(aliceSubData[0].gt(new BN(0)), "After removing one subidentity, the other's deposit should remain")
  assert(aliceSubData[1].eq([defaultAccounts.bob.address]), 'Alice should only have Bob as a subidentity')

  charlieSuperData = await querier.identity.superOf(defaultAccounts.charlie.address)
  assert(charlieSuperData.isNone, 'Charlie should no longer have a supraidentity')

  /**
   * As Bob, remove oneself from Alice's subidentities
   */

  const quitSubTx = txApi.identity.quitSub()
  quitSubTx.signAndSend(defaultAccounts.bob)

  // Withouth a second block being mined, the `quitSub` extrinsic will not take effect.
  await peopleClient.dev.newBlock({ count: 2 })

  aliceSubData = await querier.identity.subsOf(defaultAccounts.alice.address)

  assert(aliceSubData[0].isZero, 'After removal of the second subidentity, no deposits should remain')
  assert(aliceSubData[1].isEmpty, 'Alice should now have no subidentities')

  bobSuperData = await querier.identity.superOf(defaultAccounts.bob.address)
  assert(bobSuperData.isNone, 'Charlie should no longer have a supraidentity')
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
>(relayChain: Chain<TCustom, TInitStoragesRelay>, peopleChain: Chain<TCustom, TInitStoragesPara>) {
  /**
   * Setup relay and parachain clients
   */

  const [relayClient, peopleClient] = await setupNetworks(relayChain, peopleChain)

  const addRegistrarTx = peopleClient.api.tx.identity.addRegistrar(defaultAccounts.charlie.address)
  const encodedPeopleChainCalldata = addRegistrarTx.method.toHex()

  await sendXcmFromRelay(relayClient, encodedPeopleChainCalldata, { proofSize: '10000', refTime: '1000000000' })

  /**
   * Checks to people parachain's registrar list at several points of interest.
   */

  const registrarAddresses = [
    defaultAccounts.alice.address,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address,
  ]

  const registrarsBeforeRelayBlock = await peopleClient.api.query.identity.registrars()

  /**
   * Compare two sets of registrars
   * 1. those defined above, taken from the statically defined test parachain's registrars
   * 2. those obtained via `.api.query.identity.registrars()`
   *
   * @param registrarsAtGivenMoment Data obtained from querying parachain's registrars at a given block
   * @param errMsg Message to be used by failed assertions on expected registrars
   */
  const assertionHelper = (registrarsAtGivenMoment: Vec<Option<PalletIdentityRegistrarInfo>>, errMsg: string) => {
    for (let i = 0; i < registrarsAtGivenMoment.length; i++) {
      const reg = registrarsAtGivenMoment[i].unwrap().account

      const augmentedErrMsg = errMsg + ': ' + reg + 'and ' + registrarAddresses[i]

      assert(reg.eq(registrarAddresses[i]), augmentedErrMsg)
    }
  }

  // Recall that, in the people chain's definition, 2 test registrars exist.
  assert(registrarsBeforeRelayBlock.length === 2)
  assertionHelper(registrarsBeforeRelayBlock, 'Registrars before relay chain block differ from expected')

  // Create a new block in the relay chain so that the above XCM call can be executed in the
  // parachain
  await relayClient.chain.newBlock()

  const registrarsAfterRelayBlock = await peopleClient.api.query.identity.registrars()

  assert(registrarsBeforeRelayBlock.length === 2)
  assertionHelper(registrarsAfterRelayBlock, 'Registrars after relay chain block differ from expected')

  // Also advance a block in the parachain - otherwise, the above call's effect would not be visible.
  await peopleClient.chain.newBlock()

  const registrarsAfterParaBlock = await peopleClient.api.query.identity.registrars()

  assert(registrarsAfterParaBlock.length === 3)
  assertionHelper(registrarsAfterParaBlock, 'Registrars after parachain block differ from expected')
}

/**
 * Send an XCM message containing an extrinsic to be executed in the people chain, as `Root`
 *
 * @param relayClient Relay chain client form which to execute `xcmPallet.send`
 * @param encodedChainCallData Hex-encoded identity pallet extrinsic
 * @param requireWeightAtMost Optional reftime/proof size parameters that the extrinsic may require
 */
async function sendXcmFromRelay(
  relayClient: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  encodedChainCallData: `0x${string}`,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
) {
  // Destination of the XCM message sent from the relay chain to the parachain via `xcmPallet`
  const dest = {
    V4: {
      parents: 0,
      interior: {
        X1: [
          {
            Parachain: 1004,
          },
        ],
      },
    },
  }

  // The message being sent to the parachain, containing a call to be executed in the parachain:
  // an origin-restricted extrinsic from the `identity` pallet, to be executed as a `SuperUser`.
  const message = {
    V4: [
      {
        UnpaidExecution: {
          weightLimit: 'Unlimited',
          checkOrigin: null,
        },
      },
      {
        Transact: {
          call: {
            encoded: encodedChainCallData,
          },
          originKind: 'SuperUser',
          requireWeightAtMost,
        },
      },
    ],
  }

  const xcmTx = relayClient.api.tx.xcmPallet.send(dest, message)
  const encodedRelayCallData = xcmTx.method.toHex()

  /**
   * Execution of XCM call via RPC `dev_setStorage`
   */

  const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  await relayClient.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: encodedRelayCallData,
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
  topLevelDescription: string,
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  peopleChain: Chain<TCustom, TInitStoragesPara>,
) {
  describe(topLevelDescription, function () {
    test('setting on-chain identity and requesting judgement should work', async () => {
      await setIdentityThenRequestAndProvideJudgement(peopleChain)
    })

    test('setting an on-chain identity, requesting 2 judgements, having 1 provided, and then resetting the identity should work', async () => {
      await setIdentityRequestJudgementTwiceThenResetIdentity(peopleChain)
    })

    test('setting on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
      await setIdentityThenRequesThenCancelThenClear(peopleChain)
    })

    test('setting on-chain identity, adding sub-identities, removing one, and having another remove itself should work', async () => {
      await setIdentityThenAddSubsThenRemove(peopleChain)
    })

    test('adding a registrar as root from the relay chain works', async () => {
      await addRegistrarViaRelayAsRoot(relayChain, peopleChain)
    })
  })
}
