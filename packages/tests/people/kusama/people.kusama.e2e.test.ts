import { describe } from 'vitest'

import { kusama, peopleKusama } from '@e2e-test/networks/chains'

import { addRegistrarViaRelayAsRoot, setIdentityThenRequestAndProvideJudgement } from '../shared.js'

describe('Kusama people chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peopleKusama)
})

describe('Kusama people chain: Adding a registrar as root from the relay chain works', async () => {
  await addRegistrarViaRelayAsRoot(kusama, peopleKusama)
})
