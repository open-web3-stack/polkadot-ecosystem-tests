/**
 * Helpers for collectives chain tests, shared across Polkadot and Kusama.
 * @module
 */

import { createXcmTransactSend, getXcmRoute, scheduleInlineCallWithOrigin } from './helpers/index.js'
import type { Client } from './types.js'

/**
 * Send an XCM message containing an extrinsic to be executed in the destination chain as a
 * whitelist call authorised by the Fellowship voice.
 *
 * This fakes the `Fellows` origin by injecting the call into the scheduler; for a real,
 * referendum-driven whitelist see `passFellowshipReferendum` in `fellowship.ts` and the
 * `fellowshipReferendaE2ETests` suite. It remains here as a lightweight setup step for the runtime
 * upgrade tests.
 *
 * @param destClient Destination chain client form which to execute xcm send
 * @param encodedChainCallData Hex-encoded call extrinsic to be executed at the destination
 * @param requireWeightAtMost Optional reftime/proof size parameters that the extrinsic may require
 */
export async function sendWhitelistCallViaXcmTransact(
  destClient: Client<any, any>,
  collectivesClient: Client<any, any>,
  encodedChainCallData: `0x${string}`,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
): Promise<any> {
  const dest = getXcmRoute(collectivesClient.config, destClient.config)

  const xcmTx = createXcmTransactSend(
    collectivesClient,
    dest,
    destClient.api.tx.whitelist.whitelistCall(encodedChainCallData).method.toHex(),
    'Xcm',
    requireWeightAtMost,
  )

  let origin: { Origins: 'Fellows' } | { FellowshipOrigins: 'Fellows' }
  if (collectivesClient.config.name === 'kusama') {
    origin = { Origins: 'Fellows' }
  } else {
    origin = { FellowshipOrigins: 'Fellows' }
  }

  await scheduleInlineCallWithOrigin(collectivesClient, xcmTx.method.toHex(), origin)
}
