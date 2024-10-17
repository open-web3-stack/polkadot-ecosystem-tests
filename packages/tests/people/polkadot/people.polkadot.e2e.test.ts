import { describe } from 'vitest'

import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'

import { addRegistrarViaRelayAsRoot, setIdentityThenRequestAndProvideJudgement } from '../shared.js'

describe('Polkadot people chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
})

describe('Polkadot people chain: Adding a registrar as root from the relay chain works', async () => {
  await addRegistrarViaRelayAsRoot(polkadot, peoplePolkadot)
})
