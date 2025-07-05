import { assert, describe, expect, test } from 'vitest'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './helpers/index.js'

/**
 * Test that a foreign asset spend from the Relay treasury is reflected on the AssetHub.
 *
 * 1. Approve a spend from the Relay treasury
 * 2. Payout the spend from the Relay treasury
 * 3. Check that the spend shows in the AssetHub
 */
export async function treasurySpendForeignAssetTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, ahChain: Chain<TCustom, TInitStoragesPara>) {
  const [relayClient, assetHubClient] = await setupNetworks(relayChain, ahChain)

  await relayClient.dev.setStorage({
    System: {
      account: [
        // give Alice some DOTs so that she can sign a payout transaction.
        [[devAccounts.alice.address], { providers: 1, data: { free: 10000e10 } }],
      ],
    },
  })
  const USDT_ID = 1984
  const balanceBefore = await assetHubClient.api.query.assets.account(USDT_ID, devAccounts.alice.address)

  // amount is encoded into the call
  const amount = 123123123123n
  const treasurySpendCall =
    '0x130504000100a10f0002043205011f07b3c3b5aa1c0400010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d00'
  await scheduleInlineCallWithOrigin(relayClient, treasurySpendCall, { system: 'Root' })
  await relayClient.dev.newBlock()
  await checkSystemEvents(relayClient, { section: 'treasury', method: 'AssetSpendApproved' })
    // values (e.g. index) inside data increase over time,
    // PET framework often rounds them.
    // Tests will be flaky if we don't redact them.
    .redact({
      redactKeys: /expireAt|validFrom|index/,
      number: false,
    })
    .toMatchSnapshot('treasury spend approval events')

  // filter events to find an index to payout
  const [assetSpendApprovedEvent] = (await relayClient.api.query.system.events()).filter(
    ({ event }) => event.section === 'treasury' && event.method === 'AssetSpendApproved',
  )
  expect(assetSpendApprovedEvent).toBeDefined()
  assert(relayClient.api.events.treasury.AssetSpendApproved.is(assetSpendApprovedEvent.event))
  const spendIndex = assetSpendApprovedEvent.event.data.index.toNumber()

  // payout
  const payoutEvents = await sendTransaction(
    relayClient.api.tx.treasury.payout(spendIndex).signAsync(devAccounts.alice),
  )

  // create blocks on RC and AH to ensure that payout is properly processed
  await relayClient.dev.newBlock()
  await checkEvents(payoutEvents, { section: 'treasury', method: 'Paid' })
    .redact({ redactKeys: /paymentId|index/ })
    .toMatchSnapshot('payout events')
  const [paidEvent] = (await relayClient.api.query.system.events()).filter(
    ({ event }) => event.section === 'treasury' && event.method === 'Paid',
  )
  expect(paidEvent).toBeDefined()
  assert(relayClient.api.events.treasury.Paid.is(paidEvent.event))
  const payoutIndex = paidEvent.event.data.index.toNumber()
  expect(payoutIndex).toBe(spendIndex)

  // treasury spend does not emit any event on AH so we need to check that Alice's balance is increased by the `amount` directly
  await assetHubClient.dev.newBlock()
  const balanceAfter = await assetHubClient.api.query.assets.account(USDT_ID, devAccounts.alice.address)
  const balanceAfterAmount = balanceAfter.isNone ? 0n : balanceAfter.unwrap().balance.toBigInt()
  const balanceBeforeAmount = balanceBefore.isNone ? 0n : balanceBefore.unwrap().balance.toBigInt()
  expect(balanceAfterAmount - balanceBeforeAmount).toBe(amount)
}

export function treasuryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  ahChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string; addressEncoding: number },
) {
  describe(testConfig.testSuiteName, () => {
    test('Foreign asset spend from Relay treasury is reflected on AssetHub', async () => {
      await treasurySpendForeignAssetTest(relayChain, ahChain)
    })
  })
}
