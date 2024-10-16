import { describe } from 'vitest'

import { setIdentityThenRequestAndProvideJudgement } from '../shared.js'

import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

describe('Polkadot People chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
})

describe('Adding a registrar as root from the relay chain works', async () => {
  const [polkadotClient, peopleClient] = await setupNetworks(polkadot, peoplePolkadot)

  const addRegistrarTx = peopleClient.api.tx.identity.addRegistrar(defaultAccounts.dave.address)
  const encodedPeopleChainCalldata = addRegistrarTx.method.toHex()

  const dest = {
    V4: {
      parents: 0,
      interior: {
        X1: [
          {
            Parachain: 1004,
          },
        ],
      },
    },
  }

  const message = {
    V4: [
      {
        UnpaidExecution: {
          weightLimit: 'Unlimited',
          checkOrigin: null,
        },
      },
      {
        Transact: {
          call: {
            encoded: encodedPeopleChainCalldata,
          },
          originKind: 'SuperUser',
          requireWeightAtMost: {
            proofSize: '3000',
            refTime: '1000000000',
          },
        },
      },
    ],
  }

  const addRegistrarXcmTx = polkadotClient.api.tx.xcmPallet.send(dest, message)

  const encodedRelayCallData = addRegistrarXcmTx.method.toHex()

  // Get the current block number, to be able to inform the relay chain's scheduler of the
  // appropriate block to inject this call in.
  const number = (await polkadotClient.api.rpc.chain.getHeader()).number.toNumber()

  await polkadotClient.api.rpc('dev_setStorage', {
    scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: encodedRelayCallData,
              },
              origin: {
                system: 'Root',
              },
            },
          ],
        ],
      ],
    },
  })

  // Create a new block in the relay chain so that the above XCM call can be executed in the
  // parachain
  await polkadotClient.chain.newBlock()

  // Also advance a block in the parachain - otherwise, the above call's effect would not be visible.
  await peopleClient.chain.newBlock()

  const registrarsAfterParaBlock = await peopleClient.api.query.identity.registrars()

  registrarsAfterParaBlock.map((registrar) => {
    console.log(registrar.toHuman())
  })
})
