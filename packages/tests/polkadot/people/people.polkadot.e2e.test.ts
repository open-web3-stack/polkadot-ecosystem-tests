import { assert, describe } from 'vitest'

import { PalletIdentityLegacyIdentityInfo, PalletIdentityRegistration } from '@polkadot/types/lookup'
import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

describe('Setting on-chain identity and requesting judgement should work', async () => {
  const [peopleClient] = await setupNetworks(peoplePolkadot)

  const identity = {
    email: { raw: 'test_address@test.io' },
    legal: { raw: 'FirstName LastName' },
    riot: { raw: '@test:test_server.io' },
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
  const rpc = peopleClient.api.rpc

  /**
   * Set Alice's on-chain identity
   */

  const setIdTx = txApi.identity.setIdentity(identity)
  await setIdTx.signAndSend(defaultAccounts.alice)

  await rpc('dev_newBlock', { count: 1 })

  const identityInfoReply = await querier.identity.identityOf(defaultAccounts.alice.address)
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

  const reqJudgTx = txApi.identity.requestJudgement(0, 0)
  await reqJudgTx.signAndSend(defaultAccounts.alice)

  await rpc('dev_newBlock', { count: 1 })

  /**
   * Compare pre and post-request identity information
   */

  const provisionalIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.alice.address)
  assert(provisionalIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const provisionalRegistrationInfo = provisionalIdentityInfoReply.unwrap()[0]
  const provisionalIdentityInfo: PalletIdentityLegacyIdentityInfo = provisionalRegistrationInfo.info

  console.log(provisionalRegistrationInfo.judgements[0].toHuman())

  assert(identityInfo.eq(provisionalIdentityInfo), 'Identity information changed after judgement request')

  /**
   * Provide a judgement on the previous request
   */

  const provJudgTx = txApi.identity.provideJudgement(
    0,
    defaultAccounts.alice.address,
    'Reasonable',
    identityInfo.hash.toString(),
  )
  await provJudgTx.signAndSend(defaultAccounts.alice)

  await rpc('dev_newBlock', { count: 1 })

  /**
   * Compare pre and post-judgement identity information.
   */

  const judgedIdentityInfoReply = await querier.identity.identityOf(defaultAccounts.alice.address)
  assert(judgedIdentityInfoReply.isSome, 'Failed to query identity after judgement')
  const judgedRegistrationInfo = judgedIdentityInfoReply.unwrap()[0]
  const judgedIdentityInfo: PalletIdentityLegacyIdentityInfo = judgedRegistrationInfo.info
  const judgment = judgedRegistrationInfo.judgements[0]

  console.log(judgment.toHuman())

  assert(identityInfo.eq(judgedIdentityInfo), 'Identity information changed after judgement')
})
