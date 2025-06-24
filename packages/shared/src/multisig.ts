import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import { assert, describe, test } from 'vitest'
import { checkEvents } from './helpers/index.js'

import BN from 'bn.js'

/// -------
/// Helpers
/// -------

/// -------
/// -------
/// -------

/**
 * Test basic multisig creation and execution.
 *
 * 1. Alice creates a multisig with Bob and Charlie as other signatories
 * 2. Alice calls as_multi to create the multisig operation
 * 3. Verify the multisig is created and events are emitted
 */
async function basicMultisigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie

  // Fund test accounts
  await client.dev.setStorage({
    System: {
      account: [
        [[bob.address], { providers: 1, data: { free: 1000e10 } }],
        [[charlie.address], { providers: 1, data: { free: 1000e10 } }],
      ],
    },
  })

  // Create a simple call to transfer funds to Charlie
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, charlie.address]
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's deposit was reserved
  const aliceAccount = await client.api.query.system.account(alice.address)
  assert(aliceAccount.data.reserved.gt(new BN(0)), 'Alice should have reserved funds for multisig deposit')
}

export function multisigE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, async () => {
    test('basic multisig creation', async () => {
      await basicMultisigTest(chain)
    })
  })
}
