import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, type Client, defaultAccounts, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { type RootTestTree, sendWhitelistCallViaXcmTransact, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { IU8a } from '@polkadot/types/types'
import { bufferToU8a, compactAddLength } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'

import { assert } from 'vitest'

import {
  assertExpectedEvents,
  type BlockProvider,
  checkEvents,
  checkSystemEvents,
  createXcmTransactSend,
  getBlockNumber,
  getXcmRoute,
  nextSchedulableBlockNum,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'

type AuthorizeUpgradeFn = (codeHash: string | Uint8Array<ArrayBufferLike>) => SubmittableExtrinsic<'promise'>
type ExpectedEvents = Parameters<typeof assertExpectedEvents>[1]

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
 * @param fellowshipChain - The chain that hosts the collective body which will whitelist the upgrade call.
 */
export async function authorizeUpgradeViaCollectives(
  governingChain: Client,
  chainToUpgrade: Client,
  fellowshipChain: Client,
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
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), okOrigin, 'NonLocal')
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'scheduler')
    .redact({ hash: false, redactKeys: /task/ })
    .toMatchSnapshot('events when dispatching non-whitelisted call')
  await assertAuthorizedUpgradeUnchanged()

  // collectives whitelisting a call
  await sendWhitelistCallViaXcmTransact(governingChain, fellowshipChain, authorizeUpgradeCall.method.hash.toHex(), {
    proofSize: '10000',
    refTime: '500000000',
  })
  await fellowshipChain.dev.newBlock()
  await checkSystemEvents(fellowshipChain, 'polkadotXcm')
    .redact({ hash: false, redactKeys: /messageId/ })
    .toMatchSnapshot('collectives events emitted when sending xcm')
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'whitelist', 'messageQueue')
    .redact({ hash: false, redactKeys: /id/ })
    .toMatchSnapshot('governing chain events emitted on receiving xcm from collectives')

  // trying to dispatch whitelisted call using bad origin - should result in error
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), badOrigin, 'NonLocal')
  await governingChain.dev.newBlock()
  await checkSystemEvents(governingChain, 'scheduler')
    .redact({ hash: false, redactKeys: /task/ })
    .toMatchSnapshot('events when dispatching whitelisted call with bad origin')
  await assertAuthorizedUpgradeUnchanged()

  // call is whitelisted, origin is ok - success expected
  await scheduleInlineCallWithOrigin(governingChain, whiteListCall.method.toHex(), okOrigin, 'NonLocal')
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

/**
 * Helper function to create and fast-track a referendum for testing purposes.
 *
 * This simulates the full governance flow by:
 * 1. Submitting a preimage with the call
 * 2. Creating a referendum on the specified track
 * 3. Placing the decision deposit to move it to the decision phase
 * 4. Fast-tracking approval by manipulating storage to simulate voting
 * 5. Waiting for the referendum to execute
 *
 * @param client - The client instance for the chain
 * @param call - The call to be executed via referendum
 * @param track - The origin track (e.g., { system: 'Root' } or { Origins: 'WhitelistedCaller' })
 * @returns The referendum index
 */
async function createAndFastTrackReferendum(
  client: Client,
  call: SubmittableExtrinsic<'promise'>,
  track: { system: string } | { Origins: string },
  blockProvider: BlockProvider,
): Promise<number> {
  const alice = devAccounts.alice

  // Fund Alice for preimage and deposits
  await client.dev.setStorage({
    // It may happen that real referendum preimage is still in place and since we are basically
    // upgrading to the same WASM it will yield the same preimage and test can fail due to preimage
    // already noted
    Preimage: {
      $removePrefix: ['preimageFor', 'statusFor', 'requestStatusFor'],
    },
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000 * 1e10 } }]],
    },
  })

  // Step 1: Submit preimage
  const preimageCall = call.method
  const preimageHash = preimageCall.hash
  const preimageTx = client.api.tx.preimage.notePreimage(preimageCall.toHex())
  await sendTransaction(preimageTx.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    { type: client.api.events.preimage.Noted, args: { hash_: preimageHash } },
  ])

  // Step 2: Submit referendum
  const proposalOrigin = track
  const proposal = {
    Lookup: {
      hash: preimageHash,
      len: preimageCall.encodedLength,
    },
  }
  const enactmentMoment = { After: 0 } // Execute immediately after approval

  const submitTx = client.api.tx.referenda.submit(proposalOrigin as any, proposal, enactmentMoment)
  await sendTransaction(submitTx.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  // Get referendum index from events
  const events = await client.api.query.system.events()
  const submittedEvent = events.find((record) => client.api.events.referenda.Submitted.is(record.event))

  if (!submittedEvent || !client.api.events.referenda.Submitted.is(submittedEvent.event)) {
    throw new Error('Referendum submission failed - Submitted event not found')
  }

  const referendumIndex = submittedEvent.event.data.index.toNumber()

  // Step 3: Place decision deposit to move to decision phase
  const placeDecisionDepositTx = client.api.tx.referenda.placeDecisionDeposit(referendumIndex)
  await sendTransaction(placeDecisionDepositTx.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  // Step 4: Fast-track by manipulating referendum storage to simulate approval
  // We set the tally to have overwhelming support
  const referendumInfo = await client.api.query.referenda.referendumInfoFor(referendumIndex)

  if (referendumInfo.isNone) {
    throw new Error(`Referendum ${referendumIndex} not found in storage`)
  }

  const ongoing = referendumInfo.unwrap().asOngoing

  // Get total issuance for realistic tally values
  const totalIssuance = (await client.api.query.balances.totalIssuance()).toBigInt()

  const currentBlock = await getBlockNumber(client.api, blockProvider)

  // Support Lookup, Inline or Legacy proposals
  const callHash = ongoing.proposal.isLookup
    ? ongoing.proposal.asLookup.hash.toHex()
    : ongoing.proposal.isInline
      ? client.api.registry.hash(ongoing.proposal.asInline).toHex()
      : ongoing.proposal.asLegacy.hash.toHex()

  // Create the fast-tracked proposal data
  const fastProposalData = {
    ongoing: {
      ...ongoing.toJSON(),
      enactment: { after: 0 },
      deciding: {
        since: currentBlock - 1,
        confirming: currentBlock - 1,
      },
      tally: {
        ayes: (totalIssuance - 1n).toString(),
        nays: '0',
        support: (totalIssuance - 1n).toString(),
      },
      alarm: [currentBlock + 1, [currentBlock + 1, 0]],
    },
  }

  const refMeta = client.api.query.referenda.referendumInfoFor.creator.meta
  const refValueType = client.api.registry.lookup.getTypeDef(refMeta.type.asMap.value).type
  const fastProposal = client.api.registry.createType(refValueType, fastProposalData)

  const referendumKey = client.api.query.referenda.referendumInfoFor.key(referendumIndex)
  await client.api.rpc('dev_setStorage', [[referendumKey, fastProposal.toHex()]])

  // Helper function to speed up execution of existing scheduled calls (re-scheduled at next block)
  const moveScheduledCallToNextBlock = async (verifier: (call: any) => boolean) => {
    const nextBlockNumber = await nextSchedulableBlockNum(client.api, blockProvider)
    const agenda = await client.api.query.scheduler.agenda.entries()
    let found = false

    for (const agendaEntry of agenda) {
      for (const scheduledEntry of agendaEntry[1]) {
        if (scheduledEntry.isSome && verifier(scheduledEntry.unwrap().call)) {
          found = true

          await client.api.rpc('dev_setStorage', [
            [agendaEntry[0]],
            [await client.api.query.scheduler.agenda.key(nextBlockNumber), agendaEntry[1].toHex()],
          ])

          if (scheduledEntry.unwrap().maybeId.isSome) {
            const id = scheduledEntry.unwrap().maybeId.unwrap().toHex()
            const lookup = await client.api.query.scheduler.lookup(id)

            if (lookup.isSome) {
              const lookupKey = await client.api.query.scheduler.lookup.key(id)
              const lookupMeta = client.api.query.scheduler.lookup.creator.meta
              const lookupValueType = client.api.registry.lookup.getTypeDef(lookupMeta.type.asMap.value).type
              const fastLookup = client.api.registry.createType(lookupValueType, [nextBlockNumber, 0])
              await client.api.rpc('dev_setStorage', [[lookupKey, fastLookup.toHex()]])
            }
          }
        }
      }
    }

    if (!found) {
      throw new Error('No scheduled call found')
    }
  }

  // Move the nudgeReferendum call to the next block
  await moveScheduledCallToNextBlock((call) => {
    if (!call.isInline) {
      return false
    }
    const callData = client.api.createType('Call', call.asInline.toHex())
    return callData.method === 'nudgeReferendum' && (callData.args[0] as any).toNumber() === referendumIndex
  })
  await client.dev.newBlock({ count: 1 })

  // Move the actual proposal call to the next block
  await moveScheduledCallToNextBlock((call) => {
    return call.isLookup
      ? call.asLookup.hash.toHex() === callHash
      : call.isInline
        ? client.api.registry.hash(call.asInline).toHex() === callHash
        : call.asLegacy.hash.toHex() === callHash
  })

  const finalReferendumInfo = await client.api.query.referenda.referendumInfoFor(referendumIndex)
  assert(finalReferendumInfo.unwrap().isApproved)

  // Create another block to execute the proposal
  await client.dev.newBlock({ count: 1 })

  return referendumIndex
}

/**
 * Runs the authorize upgrade + apply authorized upgrade scenario via Root track referendum.
 *
 * This test demonstrates the full governance flow:
 * 1. Fetches current runtime WASM and hashes it
 * 2. Creates a Root track referendum containing the authorizeUpgrade call
 * 3. Fast-tracks the referendum to approval
 * 4. Applies the upgrade with applyAuthorizedUpgrade
 * 5. Verifies expected events
 */
async function runAuthorizeUpgradeViaRootReferendum(
  clientOfGoverningChain: Client,
  clientOfChainToUpgrade: Client,
  params: {
    call: AuthorizeUpgradeFn
    expectedAfterApply: (hash: IU8a) => ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  const currentWasm = bufferToU8a(Buffer.from((await clientOfChainToUpgrade.chain.head.wasm).slice(2), 'hex'))
  const currentWasmHash = clientOfChainToUpgrade.api.registry.hash(currentWasm)

  // Create the authorize upgrade call (could be local or XCM-based)
  const authorizeUpgradeCall =
    clientOfGoverningChain.url === clientOfChainToUpgrade.url
      ? params.call(currentWasmHash)
      : clientOfGoverningChain.api.tx.utility.forceBatch([
          (() => {
            const call = clientOfChainToUpgrade.api.tx.system.authorizeUpgrade(currentWasmHash)
            const dest = getXcmRoute(clientOfGoverningChain.config, clientOfChainToUpgrade.config)
            return createXcmTransactSend(clientOfGoverningChain, dest, call.method.toHex(), 'Superuser', {
              refTime: '5000000000',
              proofSize: '500000',
            })
          })(),
        ])

  // Create and fast-track a Root referendum with the authorize upgrade call
  await createAndFastTrackReferendum(
    clientOfGoverningChain,
    authorizeUpgradeCall,
    { system: 'Root' },
    clientOfGoverningChain.config.properties.schedulerBlockProvider,
  )

  // Apply the authorized upgrade
  const applyCall = clientOfChainToUpgrade.api.tx.system.applyAuthorizedUpgrade(compactAddLength(currentWasm))
  await sendTransaction(applyCall.signAsync(alice))

  await clientOfChainToUpgrade.dev.newBlock({ count: 1 })

  if (clientOfChainToUpgrade.config.isRelayChain) {
    assertExpectedEvents(
      await clientOfChainToUpgrade.api.query.system.events(),
      params.expectedAfterApply(currentWasmHash),
    )
  } else {
    const eventsAfterFirstBlock = await clientOfChainToUpgrade.api.query.system.events()
    await clientOfChainToUpgrade.dev.newBlock({ count: 1 })
    const eventsAfterSecondBlock = await clientOfChainToUpgrade.api.query.system.events()
    assertExpectedEvents(
      eventsAfterFirstBlock.concat(eventsAfterSecondBlock),
      params.expectedAfterApply(currentWasmHash),
    )
  }
}

/**
 * Runs the authorize upgrade + apply authorized upgrade scenario via WhitelistedCaller track referendum.
 *
 * This test demonstrates the full governance flow with collectives integration:
 * 1. Fetches current runtime WASM and hashes it
 * 2. Uses authorizeUpgradeViaCollectives flow to whitelist the upgrade call
 * 3. Creates a WhitelistedCaller track referendum that dispatches the whitelisted call
 * 4. Fast-tracks the referendum to approval
 * 5. The referendum executes the whitelisted call, which authorizes the upgrade
 * 6. Applies the upgrade with applyAuthorizedUpgrade
 * 7. Verifies expected events
 *
 * @param clientOfGoverningChain - The chain where the governance is running
 * @param clientOfChainToUpgrade - The chain whose runtime is being upgraded
 * @param fellowshipClient - The chain that hosts the collective body
 * @param testConfig - Test configuration
 * @param params - Contains the authorizeUpgrade call variant and expected events
 */
async function runAuthorizeUpgradeViaWhitelistedCallerReferendum(
  clientOfGoverningChain: Client,
  clientOfChainToUpgrade: Client,
  fellowshipClient: Client,
  params: {
    call: AuthorizeUpgradeFn
    expectedAfterApply: (hash: IU8a) => ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  const currentWasm = bufferToU8a(Buffer.from((await clientOfChainToUpgrade.chain.head.wasm).slice(2), 'hex'))
  const currentWasmHash = clientOfChainToUpgrade.api.registry.hash(currentWasm)

  // Create the authorize upgrade call (could be local or XCM-based)
  const authorizeUpgradeCall =
    clientOfGoverningChain.url === clientOfChainToUpgrade.url
      ? params.call(currentWasmHash)
      : clientOfGoverningChain.api.tx.utility.forceBatch([
          (() => {
            const call = clientOfChainToUpgrade.api.tx.system.authorizeUpgrade(currentWasmHash)
            const dest = getXcmRoute(clientOfGoverningChain.config, clientOfChainToUpgrade.config)
            return createXcmTransactSend(clientOfGoverningChain, dest, call.method.toHex(), 'Superuser', {
              refTime: '5000000000',
              proofSize: '500000',
            })
          })(),
        ])

  // First, whitelist the authorize upgrade call via collectives (before creating the referendum)
  await sendWhitelistCallViaXcmTransact(
    clientOfGoverningChain,
    fellowshipClient,
    authorizeUpgradeCall.method.hash.toHex(),
    {
      proofSize: '10000',
      refTime: '500000000',
    },
  )
  await fellowshipClient.dev.newBlock()
  await clientOfGoverningChain.dev.newBlock()

  // Now create the whitelisted dispatch call
  const whitelistedDispatchCall = clientOfGoverningChain.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(
    authorizeUpgradeCall.method.toHex(),
  )

  // Create and fast-track a WhitelistedCaller referendum
  await createAndFastTrackReferendum(
    clientOfGoverningChain,
    whitelistedDispatchCall,
    { Origins: 'WhitelistedCaller' },
    clientOfGoverningChain.config.properties.schedulerBlockProvider,
  )

  // Apply the authorized upgrade
  const applyCall = clientOfChainToUpgrade.api.tx.system.applyAuthorizedUpgrade(compactAddLength(currentWasm))
  await sendTransaction(applyCall.signAsync(alice))

  await clientOfChainToUpgrade.dev.newBlock({ count: 1 })

  if (clientOfChainToUpgrade.config.isRelayChain) {
    assertExpectedEvents(
      await clientOfChainToUpgrade.api.query.system.events(),
      params.expectedAfterApply(currentWasmHash),
    )
  } else {
    const eventsAfterFirstBlock = await clientOfChainToUpgrade.api.query.system.events()
    await clientOfChainToUpgrade.dev.newBlock({ count: 1 })
    const eventsAfterSecondBlock = await clientOfChainToUpgrade.api.query.system.events()
    assertExpectedEvents(
      eventsAfterFirstBlock.concat(eventsAfterSecondBlock),
      params.expectedAfterApply(currentWasmHash),
    )
  }
}

/**
 * Tests `authorizeUpgrade` flow via Root track referendum — upgrade to same WASM should fail validation.
 */
export async function authorizeUpgradeViaRootReferendumTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(governanceChain: Chain<TCustom, TInitStoragesRelay>, toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>) {
  let governanceClient: Client
  let toBeUpgradedClient: Client

  if (governanceChain.url === toBeUpgradedChain.url) {
    ;[governanceClient] = await setupNetworks(governanceChain)
    toBeUpgradedClient = governanceClient
  } else {
    ;[governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  }
  return runAuthorizeUpgradeViaRootReferendum(governanceClient, toBeUpgradedClient, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgrade,
    expectedAfterApply: (hash) => [
      {
        type: toBeUpgradedClient.api.events.system.RejectedInvalidAuthorizedUpgrade,
        args: {
          codeHash: hash,
          error: (r: any) => toBeUpgradedClient.api.errors.system.SpecVersionNeedsToIncrease.is(r.asModule),
        },
      },
    ],
  })
}

/**
 * Tests `authorizeUpgradeWithoutChecks` via Root track referendum — upgrade to same WASM should succeed.
 */
export async function authorizeUpgradeWithoutChecksViaRootReferendumTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(governanceChain: Chain<TCustom, TInitStoragesRelay>, toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>) {
  let governanceClient: Client
  let toBeUpgradedClient: Client

  if (governanceChain.url === toBeUpgradedChain.url) {
    ;[governanceClient] = await setupNetworks(governanceChain)
    toBeUpgradedClient = governanceClient
  } else {
    ;[governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  }

  let expectedEvents: ExpectedEvents = []
  if (toBeUpgradedChain.isRelayChain) {
    expectedEvents = [{ type: toBeUpgradedClient.api.events.system.CodeUpdated }]
  } else {
    expectedEvents = [
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionStored },
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionApplied },
      { type: toBeUpgradedClient.api.events.system.CodeUpdated },
    ]
  }

  return runAuthorizeUpgradeViaRootReferendum(governanceClient, toBeUpgradedClient, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgradeWithoutChecks,
    expectedAfterApply: () => expectedEvents,
  })
}

/**
 * Tests `authorizeUpgrade` flow via WhitelistedCaller track referendum with collectives — upgrade to same WASM should fail validation.
 */
export async function authorizeUpgradeViaWhitelistedCallerReferendumTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
  TCustomCollectives extends Record<string, unknown> | undefined,
  TInitStoragesCollectives extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  fellowshipChain: Chain<TCustomCollectives, TInitStoragesCollectives>,
) {
  let governanceClient: Client
  let toBeUpgradedClient: Client
  let fellowshipClient: Client

  if (governanceChain.url === toBeUpgradedChain.url) {
    ;[governanceClient, fellowshipClient] = await setupNetworks(governanceChain, fellowshipChain)
    toBeUpgradedClient = governanceClient
  } else {
    ;[governanceClient, toBeUpgradedClient, fellowshipClient] = await setupNetworks(
      governanceChain,
      toBeUpgradedChain,
      fellowshipChain,
    )
  }
  return runAuthorizeUpgradeViaWhitelistedCallerReferendum(governanceClient, toBeUpgradedClient, fellowshipClient, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgrade,
    expectedAfterApply: (hash) => [
      {
        type: toBeUpgradedClient.api.events.system.RejectedInvalidAuthorizedUpgrade,
        args: {
          codeHash: hash,
          error: (r: any) => toBeUpgradedClient.api.errors.system.SpecVersionNeedsToIncrease.is(r.asModule),
        },
      },
    ],
  })
}

/**
 * Tests `authorizeUpgradeWithoutChecks` via WhitelistedCaller track referendum with collectives — upgrade to same WASM should succeed.
 */
export async function authorizeUpgradeWithoutChecksViaWhitelistedCallerReferendumTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
  TCustomCollectives extends Record<string, unknown> | undefined,
  TInitStoragesCollectives extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  fellowshipChain: Chain<TCustomCollectives, TInitStoragesCollectives>,
) {
  let governanceClient: Client
  let toBeUpgradedClient: Client
  let fellowshipClient: Client

  if (governanceChain.url === toBeUpgradedChain.url) {
    ;[governanceClient, fellowshipClient] = await setupNetworks(governanceChain, fellowshipChain)
    toBeUpgradedClient = governanceClient
  } else {
    ;[governanceClient, toBeUpgradedClient, fellowshipClient] = await setupNetworks(
      governanceChain,
      toBeUpgradedChain,
      fellowshipChain,
    )
  }

  let expectedEvents: ExpectedEvents = []
  if (toBeUpgradedChain.isRelayChain) {
    expectedEvents = [{ type: toBeUpgradedClient.api.events.system.CodeUpdated }]
  } else {
    expectedEvents = [
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionStored },
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionApplied },
      { type: toBeUpgradedClient.api.events.system.CodeUpdated },
    ]
  }

  return runAuthorizeUpgradeViaWhitelistedCallerReferendum(governanceClient, toBeUpgradedClient, fellowshipClient, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgradeWithoutChecks,
    expectedAfterApply: () => expectedEvents,
  })
}

/**
 * Test suite for self-upgrade scenarios via Root track referendum.
 *
 * Tests a governance chain upgrading its own runtime through a fast-tracked Root referendum.
 * The full flow includes:
 * 1. Creating a referendum with an authorize_upgrade call
 * 2. Fast-tracking the referendum to immediate approval
 * 3. Applying the authorized upgrade
 * 4. Verifying the upgrade outcome
 *
 * This suite covers both `authorizeUpgrade` (which validates WASM and should fail for same version)
 * and `authorizeUpgradeWithoutChecks` (which skips validation and should succeed).
 *
 * @param governanceChain - The chain configuration that will upgrade itself
 * @param testConfig - Test configuration including block provider and test suite name
 * @returns A test tree with Root referendum upgrade scenarios
 */
export function governanceChainSelfUpgradeViaRootReferendumSuite<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(governanceChain: Chain<TCustomRelay, TInitStoragesRelay>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows upgrade to the same wasm (via Root referendum)`,
        testFn: async () => await authorizeUpgradeWithoutChecksViaRootReferendumTests(governanceChain, governanceChain),
      },
      {
        kind: 'test',
        label: `authorize_upgrade doesnt allow upgrade to the same wasm (via Root referendum)`,
        testFn: async () => await authorizeUpgradeViaRootReferendumTests(governanceChain, governanceChain),
      },
    ],
  }
}

/**
 * Test suite for cross-chain upgrade scenarios via Root track referendum.
 *
 * Tests a governance chain (e.g., relay chain) upgrading another chain (e.g., system parachain)
 * through a fast-tracked Root referendum. The authorization call is sent via XCM Transact.
 *
 * The full flow includes:
 * 1. Creating a referendum with an XCM message containing authorize_upgrade
 * 2. Fast-tracking the referendum to immediate approval
 * 3. Executing the XCM on the target chain to authorize the upgrade
 * 4. Applying the authorized upgrade on the target chain
 * 5. Verifying the upgrade outcome
 *
 * This suite covers both `authorizeUpgrade` (which validates WASM and should fail for same version)
 * and `authorizeUpgradeWithoutChecks` (which skips validation and should succeed).
 *
 * @param governanceChain - The chain that governs and can execute Root calls (e.g., relay chain)
 * @param toBeUpgradedChain - The chain whose runtime will be upgraded (e.g., system parachain)
 * @param testConfig - Test configuration including block provider and test suite name
 * @returns A test tree with cross-chain Root referendum upgrade scenarios
 */
export function governanceChainUpgradesOtherChainViaRootReferendumSuite<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows upgrade to the same wasm (via Root referendum)`,
        testFn: async () =>
          await authorizeUpgradeWithoutChecksViaRootReferendumTests(governanceChain, toBeUpgradedChain),
      },
      {
        kind: 'test',
        label: `authorize_upgrade doesnt allow upgrade to the same wasm (via Root referendum)`,
        testFn: async () => await authorizeUpgradeViaRootReferendumTests(governanceChain, toBeUpgradedChain),
      },
    ],
  }
}

/**
 * Test suite for self-upgrade scenarios via WhitelistedCaller track referendum with Fellowship approval.
 *
 * Tests a governance chain upgrading its own runtime through a WhitelistedCaller referendum,
 * with the upgrade call whitelisted by the Fellowship collective.
 *
 * The full flow includes:
 * 1. Whitelisting the authorize_upgrade call via Fellowship (XCM from Fellowship to governance chain)
 * 2. Creating a WhitelistedCaller referendum with dispatchWhitelistedCallWithPreimage
 * 3. Fast-tracking the referendum to immediate approval
 * 4. Executing the whitelisted call to authorize the upgrade
 * 5. Applying the authorized upgrade
 * 6. Verifying the upgrade outcome
 *
 * This demonstrates the two-step governance process where:
 * - Fellowship (technical experts) whitelist the upgrade as technically sound
 * - WhitelistedCaller referendum (token holders) approve executing it
 *
 * @param governanceChain - The chain that will upgrade itself (e.g., relay chain)
 * @param fellowshipChain - The Fellowship collective chain that whitelists calls (e.g., Collectives parachain)
 * @param testConfig - Test configuration including block provider and test suite name
 * @returns A test tree with WhitelistedCaller referendum self-upgrade scenarios
 */
export function governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  fellowshipChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows upgrade to the same wasm (via WhitelistedCaller referendum, approved by Fellowship)`,
        testFn: async () =>
          await authorizeUpgradeWithoutChecksViaWhitelistedCallerReferendumTests(
            governanceChain,
            governanceChain,
            fellowshipChain,
          ),
      },
      {
        kind: 'test',
        label: `authorize_upgrade doesnt allow upgrade to the same wasm (via WhitelistedCaller referendum, approved by Fellowship)`,
        testFn: async () =>
          await authorizeUpgradeViaWhitelistedCallerReferendumTests(governanceChain, governanceChain, fellowshipChain),
      },
    ],
  }
}

/**
 * Test suite for cross-chain upgrade scenarios via WhitelistedCaller track referendum with Fellowship approval.
 *
 * Tests a governance chain (e.g., relay chain) upgrading another chain (e.g., system parachain)
 * through a WhitelistedCaller referendum, with the upgrade call whitelisted by the Fellowship collective.
 *
 * The full flow includes:
 * 1. Whitelisting the XCM-wrapped authorize_upgrade call via Fellowship
 * 2. Creating a WhitelistedCaller referendum with dispatchWhitelistedCallWithPreimage
 * 3. Fast-tracking the referendum to immediate approval
 * 4. Executing the whitelisted call which sends XCM to the target chain
 * 5. Authorizing the upgrade on the target chain via XCM Transact
 * 6. Applying the authorized upgrade on the target chain
 * 7. Verifying the upgrade outcome
 *
 * This demonstrates the two-step governance process for cross-chain operations where:
 * - Fellowship (technical experts) whitelist the upgrade as technically sound
 * - WhitelistedCaller referendum (token holders) approve executing it
 * - The upgrade is applied to a different chain via XCM
 *
 * @param governanceChain - The chain that governs and initiates the upgrade (e.g., relay chain)
 * @param toBeUpgradedChain - The chain whose runtime will be upgraded (e.g., system parachain)
 * @param fellowshipChain - The Fellowship collective chain that whitelists calls (e.g., Collectives parachain)
 * @param testConfig - Test configuration including block provider and test suite name
 * @returns A test tree with cross-chain WhitelistedCaller referendum upgrade scenarios
 */
export function governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomChain extends Record<string, unknown> | undefined,
  TInitStoragesChain extends Record<string, Record<string, any>> | undefined,
  TCustomCollectives extends Record<string, unknown> | undefined,
  TInitStoragesCollectives extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomChain, TInitStoragesChain>,
  fellowshipChain: Chain<TCustomCollectives, TInitStoragesCollectives>,
  testConfig: TestConfig,
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows upgrade to the same wasm (via WhitelistedCaller referendum, approved by Fellowship)`,
        testFn: async () =>
          await authorizeUpgradeWithoutChecksViaWhitelistedCallerReferendumTests(
            governanceChain,
            toBeUpgradedChain,
            fellowshipChain,
          ),
      },
      {
        kind: 'test',
        label: `authorize_upgrade doesnt allow upgrade to the same wasm (via WhitelistedCaller referendum, approved by Fellowship)`,
        testFn: async () =>
          await authorizeUpgradeViaWhitelistedCallerReferendumTests(
            governanceChain,
            toBeUpgradedChain,
            fellowshipChain,
          ),
      },
    ],
  }
}
