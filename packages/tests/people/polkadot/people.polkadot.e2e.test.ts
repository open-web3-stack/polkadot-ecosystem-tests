import { describe } from 'vitest'

import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'

import {
  addRegistrarViaRelayAsRoot,
  setIdentityThenAddSubsThenRemove,
  setIdentityThenRequesThenCancelThenClear,
  setIdentityThenRequestAndProvideJudgement,
} from '../shared.js'

describe('Polkadot people chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
})

describe('Polkadot people chain: setting on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
  await setIdentityThenRequesThenCancelThenClear(peoplePolkadot)
})

describe('Polkadot people chain: setting on-chain identity, adding sub-identities removing one, and having another remove itself should work', async () => {
  await setIdentityThenAddSubsThenRemove(peoplePolkadot)
})

describe('Polkadot people chain: Adding a registrar as root from the relay chain works', async () => {
  await addRegistrarViaRelayAsRoot(polkadot, peoplePolkadot)
})
