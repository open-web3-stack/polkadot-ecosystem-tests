import { assert } from 'vitest'

import { Chain, defaultAccounts } from '@e2e-test/networks'
import { ITuple } from '@polkadot/types/types'
import {
  PalletIdentityJudgement,
  PalletIdentityLegacyIdentityInfo,
  PalletIdentityRegistration,
} from '@polkadot/types/lookup'
import { setupNetworks } from '@e2e-test/shared'
import { u32 } from '@polkadot/types'

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
   * Set Alice's on-chain identity
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
    'Error: immediately after setIdentity, there should be no judgments on the identity.',
  )

  /**
   * Request a judgement on identity that was just set
   */

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

  // Freely indexing into the `Vec` here, as it *should? have 1 element.
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
