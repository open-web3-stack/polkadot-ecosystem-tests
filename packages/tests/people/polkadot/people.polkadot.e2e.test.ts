import { assert, describe } from 'vitest'

import { setIdentityThenRequestAndProvideJudgement } from '../shared.js'

import { Option, Vec } from '@polkadot/types'
import { PalletIdentityRegistrarInfo } from '@polkadot/types/lookup'
import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

describe('Polkadot People chain: setting on-chain identity and requesting judgement should work', async () => {
  await setIdentityThenRequestAndProvideJudgement(peoplePolkadot)
})

describe('Adding a registrar as root from the relay chain works', async () => {
  const [polkadotClient, peopleClient] = await setupNetworks(polkadot, peoplePolkadot)

  const addRegistrarTx = peopleClient.api.tx.identity.addRegistrar(defaultAccounts.charlie.address)
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

  const registrarAddresses = [
    defaultAccounts.alice.address,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address,
  ]

  const registrarsBeforeRelayBlock = await peopleClient.api.query.identity.registrars()

  const assertionHelper = (registrarsAtGivenMoment: Vec<Option<PalletIdentityRegistrarInfo>>, errMsg: string) => {
    for (let i = 0; i < registrarsAtGivenMoment.length; i++) {
      const reg = registrarsAtGivenMoment[i].unwrap().account

      const augmentedErrMsg = errMsg + ': ' + reg + 'and ' + registrarAddresses[i]

      assert(reg.eq(registrarAddresses[i]), augmentedErrMsg)
    }
  }

  // Recall that, in the people chain's definition, 2 test registrars exist.
  assert(registrarsBeforeRelayBlock.length === 2)
  assertionHelper(registrarsBeforeRelayBlock, 'Registrars before relay chain block differ from expected')

  // Create a new block in the relay chain so that the above XCM call can be executed in the
  // parachain
  await polkadotClient.chain.newBlock()

  const registrarsAfterRelayBlock = await peopleClient.api.query.identity.registrars()

  assert(registrarsBeforeRelayBlock.length === 2)
  assertionHelper(registrarsAfterRelayBlock, 'Registrars after relay chain block differ from expected')

  // Also advance a block in the parachain - otherwise, the above call's effect would not be visible.
  await peopleClient.chain.newBlock()

  const registrarsAfterParaBlock = await peopleClient.api.query.identity.registrars()

  assert(registrarsAfterParaBlock.length === 3)
  assertionHelper(registrarsAfterParaBlock, 'Registrars after parachain block differ from expected')
})
