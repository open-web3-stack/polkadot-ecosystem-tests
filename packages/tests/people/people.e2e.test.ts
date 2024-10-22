import { describe, test } from 'vitest'

import { kusama, peopleKusama, peoplePolkadot, polkadot } from '@e2e-test/networks/chains'

import { Chain } from '@e2e-test/networks'
import {
  addRegistrarViaRelayAsRoot,
  setIdentityRequestJudgementTwiceThenResetIdentity,
  setIdentityThenAddSubsThenRemove,
  setIdentityThenRequesThenCancelThenClear,
  setIdentityThenRequestAndProvideJudgement,
} from './shared.js'

function peopleChainE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  topLevelDescription: string,
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  peopleChain: Chain<TCustom, TInitStoragesPara>,
) {
  describe(topLevelDescription, function () {
    test('setting on-chain identity and requesting judgement should work', async () => {
      await setIdentityThenRequestAndProvideJudgement(peopleChain)
    })

    test('setting on-chain identity, requesting judgement, cancelling the request and then clearing the identity should work', async () => {
      await setIdentityThenRequesThenCancelThenClear(peopleChain)
    })

    test('setting an on-chain identity, requesting 2 judgements, having 1 provided, and then resetting the identity should work', async () => {
      await setIdentityRequestJudgementTwiceThenResetIdentity(peopleChain)
    })

    test('setting on-chain identity, adding sub-identities, removing one, and having another remove itself should work', async () => {
      await setIdentityThenAddSubsThenRemove(peopleChain)
    })

    test('adding a registrar as root from the relay chain works', async () => {
      await addRegistrarViaRelayAsRoot(relayChain, peopleChain)
    })
  })
}

describe('People chains E2E tests', () => {
  peopleChainE2ETests('Kusama People', kusama, peopleKusama)
  peopleChainE2ETests('Polkadot People', polkadot, peoplePolkadot)
})
