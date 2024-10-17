import { assert } from 'vitest'

import { Chain, defaultAccounts } from '@e2e-test/networks'
import { ITuple } from '@polkadot/types/types'
import { Option, Vec, u32 } from '@polkadot/types'
import {
  PalletIdentityJudgement,
  PalletIdentityLegacyIdentityInfo,
  PalletIdentityRegistrarInfo,
  PalletIdentityRegistration,
} from '@polkadot/types/lookup'
import { setupNetworks } from '@e2e-test/shared'

/**
 * Test to the process of
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

  const identity = {
    email: { raw: 'test_address@test.io' },
    legal: { raw: 'FirstName LastName' },
    matrix: { raw: '@test:test_server.io' },
    twitter: { Raw: '@test_twitter' },
    github: { Raw: 'test_github' },
    discord: { Raw: 'test_discord' },
    web: { Raw: 'http://test.te/me' },
    image: { raw: 'test' },
    display: { raw: 'Test Display' },
    pgpFingerprint: 'a1b2c3d4e5f6g7h8i9j1',
  }

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
  const identityInfo = registrationInfo.info

  console.log(identityInfo.toHuman())
  assert(
    registrationInfo.judgements.isEmpty,
    'Error: immediately after `setIdentity`, there should be no judgments on the identity.',
  )

  /**
   * Request a judgement on identity that was just set
   */

  // Recall that, in the people chain's test storage, Alice is the 0th registrar.
  const reqJudgTx = txApi.identity.requestJudgement(0, 1)
  await reqJudgTx.signAndSend(defaultAccounts.bob)

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-request identity information
   */

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
  assert(provisionalIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const provisionalRegistrationInfo = provisionalIdentityInfoReply.unwrap()[0]

  const provisionalIdentityInfo: PalletIdentityLegacyIdentityInfo = provisionalRegistrationInfo.info
  assert(provisionalRegistrationInfo.judgements.length === 1, 'There should only be 1 judgement after requesting it.')

  // Freely indexing into the `Vec` here, as it *should* have 1 element.
  const provisionalJudgement: ITuple<[u32, PalletIdentityJudgement]> = provisionalRegistrationInfo.judgements[0]
  assert(identityInfo.eq(provisionalIdentityInfo), 'Identity information changed after judgement request')
  assert(provisionalJudgement[0].eq('0'), 'Alice, to whom a request was made, should be the 0th registrar')
  assert(provisionalJudgement[1].isFeePaid, 'The judgement immediately after a request should be "FeePaid"')
  assert(provisionalJudgement[1].asFeePaid.eq(1), "Alice's registrar fee should be set to `1`")

  /**
   * Provide a judgement on the previous request
   */

  const provJudgTx = txApi.identity.provideJudgement(
    0,
    defaultAccounts.bob.address,
    'Reasonable',
    identityInfo.hash.toHex(),
  )
  await provJudgTx.signAndSend(defaultAccounts.alice)

  await peopleClient.chain.newBlock()

  /**
   * Compare pre and post-judgement identity information.
   */

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.bob.address)
  assert(judgedIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const judgedRegistrationInfo = judgedIdentityInfoReply.unwrap()[0]
  assert(
    judgedRegistrationInfo.judgements.length === 1,
    'There should only be 1 judgement on the account after one was provided.',
  )

  const judgedIdentityInfo: PalletIdentityLegacyIdentityInfo = judgedRegistrationInfo.info
  assert(identityInfo.eq(judgedIdentityInfo), 'Identity information changed after judgement')

  const judgement: ITuple<[u32, PalletIdentityJudgement]> = judgedRegistrationInfo.judgements[0]
  assert(identityInfo.eq(provisionalIdentityInfo), 'Identity information changed after judgement request')
  assert(judgement[0].eq('0'), 'Alice, from whom a judgement was received, should be the 0th registrar')
  assert(judgement[1].isReasonable, 'The judgement immediately after _this_ judgement should be "Reasonable"')
}

/**
 * Test to the process of
 * 1. setting an identity,
 * 2. requesting a judgement,
 * 3. cancellingi the previous request, and
 * 4. clearing the identity
 *
 * @param peopleChain People parachain where the entire process is run.
 */
export async function setIdentityThenRequesThenCancelThenClear<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(peopleChain: Chain<TCustom, TInitStorages>) {
  const [peopleClient] = await setupNetworks(peopleChain)

  const identity = {
    email: { raw: 'test_address@test.io' },
    legal: { raw: 'FirstName LastName' },
    matrix: { raw: '@test:test_server.io' },
    twitter: { Raw: '@test_twitter' },
    github: { Raw: 'test_github' },
    discord: { Raw: 'test_discord' },
    web: { Raw: 'http://test.te/me' },
    image: { raw: 'test' },
    display: { raw: 'Test Display' },
    pgpFingerprint: 'a1b2c3d4e5f6g7h8i9j1',
  }

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
 * Test to the process of adding a registrar to a people's parachain.
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
            encoded: encodedPeopleChainCalldata,
          },
          originKind: 'SuperUser',
          requireWeightAtMost: {
            proofSize: '3000',
            refTime: '1000000000',
          },
        },
      },
    ],
  }

  const addRegistrarXcm = relayClient.api.tx.xcmPallet.send(dest, message)

  const encodedRelayCallData = addRegistrarXcm.method.toHex()

  /**
   * Execution of XCM call via RPC `dev_setStorage`
   */

  // Get the current block number, to be able to inform the relay chain's scheduler of the
  // appropriate block to inject this call in.
  const number = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  await relayClient.api.rpc('dev_setStorage', {
    scheduler: {
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
