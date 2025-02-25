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

import { Chain, Client } from '@e2e-test/networks'

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
  /**
   * Example 32 byte call hash; value is not important for the test
   */
  const encodedCallToWhitelist = "0x0101010101010101010101010101010101010101010101010101010101010101"

  await sendXcmFromPara(relayClient, collectivesClient, encodedCallToWhitelist, { proofSize: '10000', refTime: '1000000000' })
  await collectivesClient.dev.newBlock()

  const collectivesEvents = await collectivesClient.api.query.system.events()
  const xcmEvents = collectivesEvents.filter((record) => {
    const { event } = record
    return event.section === 'polkadotXcm'
  })
  assert(xcmEvents.length === 2, 'polkadotXcm should emit 2 events')
  // assert(collectivesClient.api.events.polkadotXcm.FeePaid.is(xcmEvents[0].event))
  assert(collectivesClient.api.events.polkadotXcm.Sent.is(xcmEvents[1].event))

  await relayClient.dev.newBlock()
  const relayEvents = await relayClient.api.query.system.events()
  const whitelistEvents = relayEvents.filter((record) => {
    const { event } = record
    return event.section === 'whitelist'
  })
  assert(whitelistEvents.length === 1, 'whitelisting should emit 1 whitelist events on relay chain')
  const whitelistEvent = whitelistEvents[0]
  assert(relayClient.api.events.whitelist.CallWhitelisted.is(whitelistEvent.event))

  const [callHash] = whitelistEvent.event.data
  assert(callHash.eq(encodedCallToWhitelist), 'actually whitelisted hash is different than the one requested to whitelist')
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
): Promise<any> {
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

   /**
   * Execution of XCM call via RPC `dev_setStorage`
   */

  const number = (await parachainClient.api.rpc.chain.getHeader()).number.toNumber()

  await parachainClient.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: xcmTx.method.toHex(),
              },
              origin: {
                fellowshipOrigins: 'Fellows',
              },
            },
          ],
        ],
      ],
    },
  })
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
