import { describe, it } from 'vitest'

import { kusama, peopleKusama } from '@e2e-test/networks/chains'

import {
  addRegistrarViaRelayAsRoot,
  setIdentityRequestJudgementTwiceThenResetIdentity,
  setIdentityThenAddSubsThenRemove,
  setIdentityThenRequesThenCancelThenClear,
  setIdentityThenRequestAndProvideJudgement,
} from '../shared.js'

describe('Kusama people chain', function () {
  it('Kusama people chain: setting on-chain identity and requesting judgement should work', async () => {
    await setIdentityThenRequestAndProvideJudgement(peopleKusama)
  })

  it('Kusama people chain: setting on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
    await setIdentityThenRequesThenCancelThenClear(peopleKusama)
  })

  it('setting an on-chain identity, requesting 2 judgements, having 1 provided, and then resetting the identity should work', async () => {
    await setIdentityRequestJudgementTwiceThenResetIdentity(peopleKusama)
  })

  it('Kusama people chain: setting on-chain identity, adding sub-identities removing one, and having another remove itself should work', async () => {
    await setIdentityThenAddSubsThenRemove(peopleKusama)
  })

  it('Kusama people chain: Adding a registrar as root from the relay chain works', async () => {
    await addRegistrarViaRelayAsRoot(kusama, peopleKusama)
  })
})
