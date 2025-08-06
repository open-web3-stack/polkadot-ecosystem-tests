import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, type Client, defaultAccounts } from '@e2e-test/networks'
import { sendWhitelistCallViaXcmTransact } from '@e2e-test/shared'

import type { HexString } from '@polkadot/util/types'

import { assert } from 'vitest'

import { checkEvents, checkSystemEvents, createXcmTransactSend, scheduleInlineCallWithOrigin } from './helpers/index.js'

/**
 * Computes the XCM `MultiLocation` route from a source chain to a destination chain.
 *
 * @param from - The source chain (the chain initiating the XCM message).
 * @param to - The destination chain (the chain intended to receive and execute the XCM message).
 */
function getXcmRoute(from: Chain, to: Chain) {
  let parents: number
  let interior: any

  if (from.isRelayChain) {
    parents = 0
  } else {
    parents = 1
  }

  if (to.isRelayChain) {
    interior = 'Here'
  } else {
    interior = { X1: [{ Parachain: to.paraId }] }
  }

  return { parents, interior }
}

/**
 * Constructs an XCM forceBatch transaction that authorizes a runtime upgrade on a destination chain.
 *
 *
 * @param codeHash - The code hash of the new runtime to be authorized.
 * @param sourceClient - The client instance representing the source chain (where the XCM is sent from).
 * @param destClient - The client instance representing the destination chain (where the upgrade is authorized).
 */
export function createXcmAuthorizeUpgradeBatch(codeHash: HexString, sourceClient: Client, destClient: Client) {
  const authorizeUpgradeCall = destClient.api.tx.system.authorizeUpgrade(codeHash)
  const dest = getXcmRoute(sourceClient.config, destClient.config)

  const xcmTx = createXcmTransactSend(sourceClient, dest, authorizeUpgradeCall.method.toHex(), 'Superuser', {
    refTime: '5000000000',
    proofSize: '500000',
  })

  return sourceClient.api.tx.utility.forceBatch([xcmTx])
}

/**
 * Simulates and executes the full governance workflow to authorize a runtime upgrade
 * on a target chain, optionally across chains using collectives and XCM.
 *
 * - Considering any existing authorized upgrade
 * - Submitting the upgrade call preimage
 * - Attempt to dispatch when call is not yet whitelisted
 * - Whitelisting the call via a Collectives chain
 * - Attempting to dispatch with both valid and invalid origins.
 * - Validating that the upgrade was correctly authorized on the target chain.
 *
 * @param governingChain - The chain where the governance is running, allowed to execute as superuser on other chains
 * @param chainToUpgrade - The chain whose runtime is being upgraded.
 * @param collectivesChain - The chain that hosts the collective body which will whitelist the upgrade call.
 */
export async function authorizeUpgradeViaCollectives(
  governingChain: Client,
  chainToUpgrade: Client,
  collectivesChain: Client,
) {
  // NOTE: Since the test is run against some live chain data, it may happen that at some moment some upgrade
  //       is already authorized - expected result is that the authorized hash will be overriden by this test
  //
  // specific value of codeHash is not important for the test
  const codeHash = '0x0101010101010101010101010101010101010101010101010101010101010101'
  const assertAuthorizedUpgradeUnchanged = async () => {
    const currentAuthorizedUpgrade = await chainToUpgrade.api.query.system.authorizedUpgrade()
    assert(currentAuthorizedUpgrade.isNone || currentAuthorizedUpgrade.value.codeHash.toHex() !== codeHash)
  }
  await assertAuthorizedUpgradeUnchanged()

  const authorizeUpgradeCall =
    governingChain.url === chainToUpgrade.url
      ? chainToUpgrade.api.tx.system.authorizeUpgrade(codeHash)
      : createXcmAuthorizeUpgradeBatch(codeHash, governingChain, chainToUpgrade)

  const whiteListCall = governingChain.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(
    authorizeUpgradeCall.method.toHex(),
  )

  const notePreimageTx = governingChain.api.tx.preimage.notePreimage(authorizeUpgradeCall.method.toHex())

  const okOrigin = { Origins: 'WhitelistedCaller' }
  // some existing but not allowed to dispatch whitelisted call origin
  const badOrigin = { Origins: 'StakingAdmin' }

  // it does not matter who is the origin which notes the preimage
  const noteEvents = await sendTransaction(notePreimageTx.signAsync(defaultAccounts.alice))
  await governingChain.dev.newBlock()
  await checkEvents(noteEvents, 'preimage').toMatchSnapshot('events after notePreimge')

  // try to dispatch a call that has not yet been whitelisted - should result in dispatching error
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), okOrigin)
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'scheduler')
    .redact({ hash: false, redactKeys: /task/ })
    .toMatchSnapshot('events when dispatching non-whitelisted call')
  await assertAuthorizedUpgradeUnchanged()

  // collectives whitelisting a call
  await sendWhitelistCallViaXcmTransact(governingChain, collectivesChain, authorizeUpgradeCall.method.hash.toHex(), {
    proofSize: '10000',
    refTime: '500000000',
  })
  await collectivesChain.dev.newBlock()
  await checkSystemEvents(collectivesChain, 'polkadotXcm')
    .redact({ hash: false, redactKeys: /messageId/ })
    .toMatchSnapshot('collectives events emitted when sending xcm')
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'whitelist', 'messageQueue')
    .redact({ hash: false, redactKeys: /id/ })
    .toMatchSnapshot('governing chain events emitted on receiving xcm from collectives')

  // trying to dispatch whitelisted call using bad origin - should result in error
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), badOrigin)
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'scheduler')
    .redact({ hash: false, redactKeys: /task/ })
    .toMatchSnapshot('events when dispatching whitelisted call with bad origin')
  await assertAuthorizedUpgradeUnchanged()

  // call is whitelisted, origin is ok - success expected
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), okOrigin)
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'whitelist')
    .redact({ hash: false })
    .toMatchSnapshot('governing chain events about dispatching whitelisted call')

  if (governingChain.url === chainToUpgrade.url) {
    await checkSystemEvents(chainToUpgrade, { section: 'system', method: 'UpgradeAuthorized' })
      .redact({ hash: false })
      .toMatchSnapshot('to-be-upgraded chain events to confirm authorized upgrade')
  } else {
    await chainToUpgrade.dev.newBlock()
    await checkSystemEvents(chainToUpgrade, 'messageQueue', { section: 'system', method: 'UpgradeAuthorized' })
      .redact({ hash: false, redactKeys: /id/ })
      .toMatchSnapshot('to-be-upgraded chain events to confirm authorized upgrade')
  }

  assert.equal((await chainToUpgrade.api.query.system.authorizedUpgrade()).value.codeHash.toHex(), codeHash)
}
