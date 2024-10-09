import { assert, describe } from 'vitest'

import { PalletIdentityRegistration } from '@polkadot/types/lookup'
import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

describe('Setting on-chain identity and requesting judgement should work', async () => {
  const [peopleClient] = await setupNetworks(peoplePolkadot)

  const riot = '@test:test_server.io'

  const identity = {
    riot: { raw: riot },
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

  assert(!identityInfo.riot)
  assert(identityInfo.matrix.eq(riot), '`riot` field in set identity is missing!')
})
