import { describe } from 'vitest'

import { peopleKusama } from '@e2e-test/networks/chains'

import { setIdentityThenRequestAndProvideJudgement } from '../shared.js'

describe('Kusama People chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peopleKusama)
})
