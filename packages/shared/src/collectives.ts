/**
 * Utilities for collectives chain tests - both Polkadot and Kusama.
 *
 * Tests are defined here, parametrized over relay/parachain datatypes, and each corresponding
 * implementing module can then instantiates tests with the appropriate chains inside a `describe`.
 *
 * Also contains helpers used in those tests.
 * @module
 */

import { assert, describe, test } from 'vitest'

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { Chain, Client, defaultAccounts } from '@e2e-test/networks'

import { checkEvents } from './helpers/index.js'
import { Codec } from '@polkadot/types/types'
import { setupNetworks } from './setup.js'

/**
 * Test the process of whitelisting a call
 *
 * It uses the parachain's relay to send an XCM message forcing execution of the normally gated
 * `addRegistrar` call as `SuperUser`.
 *
 * @param relayClient Relay chain on which the test will be run: Polkadot or Kusama.
 * Must have `xcmpPallet` available.
 * @param collectivesClient Collectives parachain
 */
export async function fellowshipWhitelistCall(
  relayClient: Client,
  collectivesClient: Client,
) {

  await collectivesClient.dev.setStorage({
    System: {
      account: [[[defaultAccounts.charlie.address], { providers: 1, data: { free: 1e10 } }]],
    },
  })

  /**
   * Example 32 byte call hash; value is not important for the test
   */
  const encodedCallToWhitelist = "0x0101010101010101010101010101010101010101010101010101010101010101"

  const parachainEvents = await sendXcmFromPara(relayClient, collectivesClient, encodedCallToWhitelist, { proofSize: '10000', refTime: '1000000000' })
  await collectivesClient.dev.newBlock()
  await checkEvents(parachainEvents, 'polkadotXcm').toMatchSnapshot("xcm events")
  
 
  await relayClient.dev.newBlock()
  const events = await relayClient.api.query.system.events()

  events.forEach((record) => {
    const { event } = record
    console.log(event)
  })

  const whitelistEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'whitelist'
  })

  const msgQueueEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'messageQueue'
  })

  assert(whitelistEvents.length === 1, 'whitelisting should emit 1 whitelist events on relay chain')
  assert(msgQueueEvents.length === 1, 'whitelisting should emit 1 message queue events on relay chain')

  const whitelistEvent = whitelistEvents[0]
  const msgQueueEvent = msgQueueEvents[0]

  assert(relayClient.api.events.messageQueue.CallWhitelisted.is(whitelistEvent.event))
  assert(relayClient.api.events.messageQueue.Processed.is(msgQueueEvent.event))
}

/**
 * Send an XCM message containing an extrinsic to be executed in the collective chain, as `Root`
 *
 * @param relayClient Relay chain client form which to execute `xcmPallet.send`
 * @param encodedChainCallData Hex-encoded call extrinsic
 * @param requireWeightAtMost Optional reftime/proof size parameters that the extrinsic may require
 */
async function sendXcmFromPara(
  relayChainClient: Client,
  parachainClient: Client,
  encodedChainCallData: `0x${string}`,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
): Promise<{
  events: Promise<Codec[]>;
}> {
  // Destination of the XCM message sent from the parachain to the relay chain`
  const dest = {
    V4: {
      parents: 1,
      interior: "Here"
    },
  }

  // The message being sent to the relay chain
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
            encoded: relayChainClient.api.tx.whitelist.whitelistCall(encodedChainCallData).method.toHex(),
          },
          originKind: 'Xcm',
          requireWeightAtMost,
        },
      },
    ],
  }

  const xcmTx = parachainClient.api.tx.polkadotXcm.send(dest, message)

  const result = await sendTransaction(xcmTx.signAsync(defaultAccounts.alice))
  return result;
}

/**
 * Test runner for collectives chains' E2E tests.
 *
 * Tests that are meant to be run in a collectives chain *must* be added to as a `vitest.test` to the
 * `describe` runner this function creates.
 *
 * @param topLevelDescription A description of this test runner e.g. "Polkadot Collectives E2E tests"
 * @param relayClient The relay chain to be used by these tests
 * @param collectivesClient The collectives's chain associated to the previous `relayChain`
 */
export function collectivesChainE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  collectivesChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string },
) {
  describe(testConfig.testSuiteName, async () => {
    const [relayClient, collectivesClient] = await setupNetworks(relayChain, collectivesChain)

    test('whitelisting a call by fellowship', async () => {
      await fellowshipWhitelistCall(relayClient, collectivesClient)
    })
  })
}
