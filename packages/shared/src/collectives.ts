/**
 * Utilities for collectives chain tests - both Polkadot and Kusama.
 *
 * Tests are defined here, parametrized over relay/parachain datatypes, and each corresponding
 * implementing module can then instantiates tests with the appropriate chains inside a `describe`.
 *
 * Also contains helpers used in those tests.
 * @module
 */

import type { Chain, Client } from '@e2e-test/networks'

import { describe, test } from 'vitest'

import { checkSystemEvents, createXcmTransactSend, scheduleInlineCallWithOrigin } from './helpers/index.js'
import { setupNetworks } from './setup.js'
/**
 * Test the process of whitelisting a call
 *
 * @param destClient The destination chain that is intented to execute whitelist call
 * @param collectivesClient Collectives parachain
 */
export async function fellowshipWhitelistCall(destClient: Client, collectivesClient: Client) {
  /**
   * Example 32 byte call hash; value is not important for the test
   */
  const callHashToWhitelist = '0x0101010101010101010101010101010101010101010101010101010101010101'

  await sendWhitelistCallViaXcmTransact(destClient, collectivesClient, callHashToWhitelist, {
    proofSize: '10000',
    refTime: '1000000000',
  })

  await collectivesClient.dev.newBlock()
  await checkSystemEvents(collectivesClient, 'polkadotXcm')
    .redact({ hash: false, redactKeys: /messageId/ })
    .toMatchSnapshot('source chain events')

  await destClient.dev.newBlock()
  await checkSystemEvents(destClient, 'whitelist', 'messageQueue')
    .redact({ hash: false, redactKeys: /id/ })
    .toMatchSnapshot('destination chain events')
}

/**
 * Send an XCM message containing an extrinsic to be executed in the destination chain as
 *
 * @param destClient Destination chain client form which to execute xcm send
 * @param encodedChainCallData Hex-encoded call extrinsic to be executed at the destination
 * @param requireWeightAtMost Optional reftime/proof size parameters that the extrinsic may require
 */
export async function sendWhitelistCallViaXcmTransact(
  destClient: Client,
  collectivesClient: Client,
  encodedChainCallData: `0x${string}`,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
): Promise<any> {
  let dest: { parents: number; interior: any }

  if (destClient.config.isRelayChain) {
    dest = {
      parents: 1,
      interior: 'Here',
    }
  } else {
    dest = {
      parents: 1,
      interior: { X1: [{ Parachain: destClient.config.paraId }] },
    }
  }

  const xcmTx = createXcmTransactSend(
    collectivesClient,
    dest,
    destClient.api.tx.whitelist.whitelistCall(encodedChainCallData).method.toHex(),
    'Xcm',
    requireWeightAtMost,
  )

  await scheduleInlineCallWithOrigin(collectivesClient, xcmTx.method.toHex(), { FellowshipOrigins: 'Fellows' })
}

/**
 * Test runner for collectives chains' E2E tests.
 *
 * Tests that are meant to be run in a collectives chain *must* be added to as a `vitest.test` to the
 * `describe` runner this function creates.
 *
 * @param topLevelDescription A description of this test runner e.g. "Polkadot Collectives E2E tests"
 * @param destChain The destination chain to where Collectives chain will send whitelist call by xcm
 * @param collectivesClient The collectives's chain associated to the previous `relayChain`
 */
export function collectivesChainE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  destChain: Chain<TCustom, TInitStoragesRelay>,
  collectivesChain: Chain<TCustom, TInitStoragesPara>,
  testConfig: { testSuiteName: string },
) {
  describe(testConfig.testSuiteName, async () => {
    const [targetChainClient, collectivesClient] = await setupNetworks(destChain, collectivesChain)

    test('whitelisting a call by fellowship', async () => {
      await fellowshipWhitelistCall(targetChainClient, collectivesClient)
    })
  })
}
