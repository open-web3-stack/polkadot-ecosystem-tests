import { assert, describe, test } from 'vitest'

import type { Client } from '@e2e-test/networks'
import { assetHubPolkadot, collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import { sendWhitelistCallViaXcmTransact, setupNetworks } from '@e2e-test/shared'
import { scheduleCallWithOrigin } from '@e2e-test/shared/helpers'
import type { HexString } from '@polkadot/util/types'

function createXcmAuthorizeUpgradeBatch(codeHash: HexString, sourceClient: Client, destClient: Client) {
  let parents: number
  let interior: any

  if (sourceClient.config.isRelayChain) {
    parents = 0
  } else {
    parents = 1
  }

  if (destClient.config.isRelayChain) {
    interior = 'Here'
  } else {
    interior = { X1: [{ Parachain: destClient.config.paraId }] }
  }

  const authorizeUpgradeCall = destClient.api.tx.system.authorizeUpgrade(codeHash)

  const callData = authorizeUpgradeCall.method.toU8a()

  const xcmMessage = [
    {
      UnpaidExecution: {
        weightLimit: 'Unlimited',
        checkOrigin: null,
      },
    },
    {
      Transact: {
        originKind: 'Superuser',
        requireWeightAtMost: {
          refTime: '5000000000',
          proofSize: '500000',
        },
        call: callData,
      },
    },
  ]

  const xcmSend = (sourceClient.api.tx.xcmPallet || sourceClient.api.tx.polkadotXcm).send(
    {
      V4: {
        parents: parents,
        interior: interior,
      },
    },
    { V4: xcmMessage },
  )

  return sourceClient.api.tx.utility.forceBatch([xcmSend])
}

describe('polkadot & asset hub & collectives', async () => {
  const [polkadotClient, ahClient, collectivesClient] = await setupNetworks(
    polkadot,
    assetHubPolkadot,
    collectivesPolkadot,
  )

  test('Relay authorizes AssetHub upgrade', async () => {
    const codeHash = '0x0101010101010101010101010101010101010101010101010101010101010101'

    const batchCall = createXcmAuthorizeUpgradeBatch(codeHash, polkadotClient, ahClient)

    assert((await ahClient.api.query.system.authorizedUpgrade()).isNone)

    const notePreimageTx = polkadotClient.api.tx.preimage.notePreimage(batchCall.method.toHex())
    const batchCallHash = batchCall.hash.toHex()

    await scheduleCallWithOrigin(polkadotClient, { Inline: notePreimageTx.method.toHex() }, { System: 'Root' })

    await polkadotClient.dev.newBlock()

    await sendWhitelistCallViaXcmTransact(polkadotClient, collectivesClient, batchCallHash, {
      proofSize: '10000',
      refTime: '500000000',
    })

    await collectivesClient.dev.newBlock()
    await polkadotClient.dev.newBlock()

    const whiteListCall = polkadotClient.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(batchCall.method.toHex())

    await scheduleCallWithOrigin(
      polkadotClient,
      { Inline: whiteListCall.method.toHex() },
      { Origins: 'WhitelistedCaller' },
    )

    await polkadotClient.dev.newBlock()
    await ahClient.dev.newBlock()

    assert.equal((await ahClient.api.query.system.authorizedUpgrade()).value.codeHash.toHex(), codeHash)
  })
})
