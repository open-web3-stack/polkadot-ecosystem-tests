import { describe } from 'vitest'

import { peoplePolkadot } from '@e2e-test/networks/chains'

import { setIdentityThenRequestAndProvideJudgement } from '../shared.js'

describe('Polkadot People chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
})
