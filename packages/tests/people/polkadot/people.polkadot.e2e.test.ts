import { describe, it } from 'vitest'

import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'

import {
  addRegistrarViaRelayAsRoot,
  setIdentityRequestJudgementTwiceThenResetIdentity,
  setIdentityThenAddSubsThenRemove,
  setIdentityThenRequesThenCancelThenClear,
  setIdentityThenRequestAndProvideJudgement,
} from '../shared.js'

describe('Polkadot people chain', function () {
  it('setting an on-chain identity and requesting judgement should work', async () => {
    await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
  })

  it('setting an on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
    await setIdentityThenRequesThenCancelThenClear(peoplePolkadot)
  })

  it('setting an on-chain identity, requesting 2 judgements, having 1 provided, and then resetting the identity should work', async () => {
    await setIdentityRequestJudgementTwiceThenResetIdentity(peoplePolkadot)
  })

  it('setting on-chain identity, adding sub-identities removing one, and having another remove itself should work', async () => {
    await setIdentityThenAddSubsThenRemove(peoplePolkadot)
  })

  it('Adding a registrar as root from the relay chain works', async () => {
    await addRegistrarViaRelayAsRoot(polkadot, peoplePolkadot)
  })
})
