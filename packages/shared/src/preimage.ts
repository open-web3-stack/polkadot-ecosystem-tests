import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupBalances, setupNetworks } from '@e2e-test/shared'

import type { IsError } from '@polkadot/types/metadata/decorate/types'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  check,
  checkEvents,
  getReservedFunds,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Query the latest list of events, retaining only those with a given section type.
 */
async function getEventsWithType(client: Client<any, any>, eventType: string) {
  const events = await client.api.query.system.events()

  return events.filter((record) => {
    const { event } = record
    return event.section === eventType
  })
}

/**
 * Expect the latest extrinsic to have failed with a given error type.
 */
async function expectFailedExtrinsicWithType(client: Client<any, any>, errorType: IsError) {
  // We expect an "ExtrinsicFailed" preimage event because the preimage has already been noted.
  const events = await client.api.query.system.events()
  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  expect(errorType.is(dispatchError.asModule)).toBeTruthy()
}

const REMARK_DATA = '0xdeadbeef'

/** The preimage pallet's hardcoded maximum preimage size (4 MB). */
const PALLET_MAX_PREIMAGE_SIZE = 4 * 1024 * 1024

/**
 * Test the registering, querying and unregistering a preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 * 2. The preimage is queried to ensure it was stored correctly.
 * 3. Alice unregisters (unnotes) the preimage.
 * 4. The preimage is queried again to ensure it was removed.
 */
export async function preimageSingleNoteUnnoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  // 2. The preimage is queried to ensure it was stored correctly.
  let preimage = await client.api.query.preimage.preimageFor([
    encodedProposal.hash.toHex(),
    encodedProposal.encodedLength,
  ])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // 3. Alice (the same account) unregisters (unnotes) the preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(encodedProposal.hash.toHex())
  const unnotePreImageEvents = await sendTransaction(unnotePreimageTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(unnotePreImageEvents, 'preimage').toMatchSnapshot('unnote preimage events')

  // 4. The preimage is queried again to ensure it was removed.
  preimage = await client.api.query.preimage.preimageFor([encodedProposal.hash.toHex(), encodedProposal.encodedLength])
  assert(preimage.isNone)
}

/**
 * Test the requesting and unrequesting of a preimage and its request status.
 *
 * 1. A root account requests a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it is marked as "Requested".
 * 3. The root account unrequests the preimage.
 * 4. The request status is queried again to ensure the preimage hash was removed.
 */
export async function preimageSingleRequestUnrequestTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // 1. A root account requests a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)

  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 2. The request status is queried to ensure the preimage hash is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 3. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    unrequestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. The request status is queried again to ensure the preimage hash was removed.
  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)
}

/**
 * Test the requesting and multiple unrequesting of a preimage and its request status.
 *
 * 1. A root account requests a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it is marked as "Requested".
 * 3. The root account unrequests the preimage multiple times.
 * 4. The request status is queried again to ensure the preimage hash was removed.
 */
export async function preimageSingleRequestMultipleUnrequestTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // 1. A root account requests a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)

  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)
  expect((await getEventsWithType(client, 'scheduler')).length).toBe(0)

  await client.dev.newBlock()

  // Expect a "Requested" event from the preimage pallet.
  let events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Requested.is(events[0].event))

  // Also expect a "Dispatched" event from the scheduler.
  events = await getEventsWithType(client, 'scheduler')
  expect(events.length).toBe(1)
  assert(client.api.events.scheduler.Dispatched.is(events[0].event))

  events = await getEventsWithType(client, 'balances')

  const hasBalanceEvents = events.length > 0

  // On some chains, a "Transfer" event also occurs.
  if (hasBalanceEvents) {
    expect(events.length).toBe(1)
    assert(client.api.events.balances.Transfer.is(events[0].event))
  }

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 2. The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // Create a new block to reset events.
  await client.dev.newBlock()

  // 3. The root account unrequests the preimage multiple times.
  const numUnrequests = 3
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  const encodedCall = unrequestTx.method.toHex()
  const encodedCallList = Array(numUnrequests).fill(encodedCall)
  await scheduleInlineCallListWithSameOrigin(
    client,
    encodedCallList,
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)
  expect((await getEventsWithType(client, 'scheduler')).length).toBe(0)

  await client.dev.newBlock()

  // No explicit "Unrequest" event from the preimage pallet.
  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)

  // "Dispatched" events do appear from the scheduler.
  events = await getEventsWithType(client, 'scheduler')
  expect(events.length).toBe(numUnrequests)

  events.forEach((eventRecord) => {
    assert(client.api.events.scheduler.Dispatched.is(eventRecord.event))
  })

  events = await getEventsWithType(client, 'balances')

  // If the request generated a "Transfer" event, then so will the unrequest(s).
  if (hasBalanceEvents) {
    expect(events.length).toBe(1)
    assert(client.api.events.balances.Transfer.is(events[0].event))
  } else {
    expect(events.length).toBe(0)
  }

  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)

  // Attempt to unrequest again.
  await scheduleInlineCallWithOrigin(
    client,
    unrequestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)

  events = await getEventsWithType(client, 'scheduler')
  expect(events.length).toBe(1)
  assert(client.api.events.scheduler.Dispatched.is(events[0].event))

  events = await getEventsWithType(client, 'balances')
  if (hasBalanceEvents) {
    expect(events.length).toBe(1)
    assert(client.api.events.balances.Transfer.is(events[0].event))
  } else {
    expect(events.length).toBe(0)
  }

  status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 4. The second unrequest should be a no-op, and the status should remain None.
  assert(status.isNone)
}

/**
 * Test the requesting and unrequesting of a previously-registered preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 *    - The request status is queried to ensure it is marked as "Unrequested".
 * 2. A root account requests the preimage.
 *    - The request status is queried to ensure it is marked as "Requested".
 * 3. The root account unrequests the preimage.
 *    - The request status is queried again to ensure it is marked as "Unrequested".
 * 4. Alice unregisters (unnotes) the preimage.
 * 5. The preimage is queried again to ensure it was removed.
 */
export async function preimageNoteThenRequestTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()

  const notePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  await sendTransaction(notePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  // Some of Alice's funds are now reserved since the preimage was noted without being requested.
  const aliceReservedFundsAfterNote = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterNote).toBeGreaterThan(0)

  // Verify that the preimage was stored correctly.
  let preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // The request status is queried to ensure it is marked as "Unrequested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Unrequested')

  // 2. A root account requests the preimage.
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Alice's previously-reserved funds are still reserved after the preimage has been requested.
  const aliceReservedFundsAfterRequest = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterRequest).toBe(aliceReservedFundsAfterNote)

  status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 3. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    unrequestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Alice's previously-reserved funds are still reserved after the preimage has been unrequested.
  const aliceReservedFundsAfterUnrequest = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterUnrequest).toBe(aliceReservedFundsAfterNote)

  // The request status is queried again to ensure it is marked as "Unrequested".
  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Unrequested')

  // 4. Alice unregisters (unnotes) the preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)
  await sendTransaction(unnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  // 5. The preimage is queried again to ensure it was removed.
  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isNone)

  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)

  // All of Alice's reserved funds have been released after the preimage was unnoted.
  const aliceReservedFundsAfterUnnote = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterUnnote).toBe(0n)
}

/**
 * Test the registering and unregistering of a previously-requested preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 * 2. A root account requests the preimage.
 *    - The request status is queried to ensure it is marked as "Requested".
 * 3. Alice unregisters (unnotes) the preimage.
 *    - The request status is queried again to ensure it is still marked as "Requested".
 * 4. The root account unrequests the preimage.
 * 5. The preimage is queried again to ensure it was removed.
 */
export async function preimageRequestAndUnnoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()

  const notePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  await sendTransaction(notePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  // Some of Alice's funds are now reserved since the preimage was noted without being requested.
  const aliceReservedFundsAfterNote = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterNote).toBeGreaterThan(0)

  // Verify that the preimage was stored correctly.
  let preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // 2. A root account requests the preimage.
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 3. Alice unregisters (unnotes) the preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)
  await sendTransaction(unnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  // The preimage is queried again to ensure it is still present since it was requested earlier.
  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // The request status is queried again to ensure it is still marked as "Requested".
  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  const aliceReservedFundsAfterUnnote = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterUnnote).toBe(0n)

  // 4. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    unrequestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 5. The preimage is queried again to ensure it was removed.
  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isNone)

  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)
}

/**
 * Test the registering (noting) of a preimage after it has been requested.
 *
 * 1. A root account requests a preimage
 * 2. Alice registers (notes) the previously-requested preimage
 *    - No funds should be reserved from Alice's acount since the preimage has already been requested
 * 3. The root account unrequests the preimage
 * 4. Alice also attempts to unregister (unnote) the preimage, but finds it has already been cleared
 */
export async function preimageRequestThenNoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // 1. A root account requests a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)

  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  let events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Requested.is(events[0].event))

  const alice = testAccounts.alice
  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 2. Alice registers (notes) the previously-requested preimage
  const notePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  await sendTransaction(notePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Noted.is(events[0].event))

  // No funds should be reserved from Alice's acount since the preimage has already been requested.
  const aliceReservedFundsAfterNote = await getReservedFunds(client, alice.address)
  expect(aliceReservedFundsAfterNote).toBe(0n)

  let preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isSome)

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isSome)

  // 3. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(
    client,
    unrequestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Following the unrequest, the preimage is cleared.
  events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Cleared.is(events[0].event))

  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isNone)

  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)

  // 4. Alice also attempts to unregister (unnote) the preimage, but finds it has already been cleared.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)
  await sendTransaction(unnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(0)

  events = await getEventsWithType(client, 'system')
  expect(events.length).toBeGreaterThan(0)

  // We expect an "ExtrinsicFailed" preimage event because the preimage is not (considered to be) noted.
  expectFailedExtrinsicWithType(client, client.api.errors.preimage.NotNoted)
}

/**
 * Test the requesting and unrequesting of a preimage by a non-root user.
 *
 * 1. A standard account attempts unsuccessfully to request a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it was not marked as "Requested".
 * 3. A root account requests the preimage.
 * 4. The request status is queried to ensure it is marked as "Requested".
 * 5. The standard account attempts unsuccessfully to unrequest the preimage.
 * 6. The request status is queried again to ensure it is still marked as "Requested".
 */
export async function preimageSingleRequestUnrequestAsNonRootTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. A standard account attempts unsuccessfully to request a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const requestTx = client.api.tx.preimage.requestPreimage(encodedProposal.hash.toHex())

  const requestPreimageEvents = await sendTransaction(requestTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  await checkEvents(requestPreimageEvents, 'preimage').toMatchSnapshot('request preimage events')

  let status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 2. The request status is queried to ensure it was not marked as "Requested".
  assert(status.isNone)

  // 3. A root account requests the preimage.
  await scheduleInlineCallWithOrigin(
    client,
    requestTx.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 4. The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 5. The standard account attempts unsuccessfully to unrequest the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(encodedProposal.hash.toHex())

  const unrequestPreimageEvents = await sendTransaction(unrequestTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()
  await checkEvents(unrequestPreimageEvents, 'preimage').toMatchSnapshot('unrequest preimage events')

  status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 6. The request status is queried again to ensure it is still marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')
}

/**
 * Test the repeated registering (noting) and unregistering (unnoting) of the same preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 * 2. Alice attempts to register (note) the same preimage again, which should fail.
 * 3. Alice unregisters (unnotes) the preimage.
 * 4. Alice attempts to unregister (unnote) the same preimage again, which should fail.
 */
export async function preimageRepeatedNoteUnnoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.system.remarkWithEvent(REMARK_DATA).method
  const proposalHash = encodedProposal.hash.toHex()
  const notePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())

  let notePreimageEvents = await sendTransaction(notePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(notePreimageEvents, 'preimage').toMatchSnapshot('note preimage events')

  let events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Noted.is(events[0].event))

  let preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // 2. Alice attempts to register (note) the same preimage again.
  const repeatNotePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  notePreimageEvents = await sendTransaction(repeatNotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(notePreimageEvents, 'preimage').toMatchSnapshot('repeat note preimage events')

  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)
  expect((await getEventsWithType(client, 'system')).length).toBeGreaterThan(0)

  // We expect an "ExtrinsicFailed" preimage event because the preimage has already been noted.
  expectFailedExtrinsicWithType(client, client.api.errors.preimage.AlreadyNoted)

  // The preimage is queried to ensure it remains stored correctly.
  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // 3. Alice unregisters (unnotes) the preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)
  let unnotePreimageEvents = await sendTransaction(unnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(unnotePreimageEvents, 'preimage').toMatchSnapshot('unnote preimage events')

  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isNone)

  events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Cleared.is(events[0].event))

  // 4. Alice attempts to unregister (unnote) the same preimage again.
  const repeatUnnotePreimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)

  unnotePreimageEvents = await sendTransaction(repeatUnnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(unnotePreimageEvents, 'preimage').toMatchSnapshot('repeat unnote preimage events')

  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])
  assert(preimage.isNone)

  expect((await getEventsWithType(client, 'preimage')).length).toBe(0)
  expect((await getEventsWithType(client, 'system')).length).toBeGreaterThan(0)

  // We expect an "ExtrinsicFailed" preimage event because the preimage is not (considered to be) noted.
  expectFailedExtrinsicWithType(client, client.api.errors.preimage.NotNoted)
}

/**
 * Test the registering (noting) and unregistering (unnoting) of an empty preimage.
 *
 * 1. Alice registers an empty preimage.
 * 2. The registration succeeds, but the stored preimage contains 1 byte of value 0 instead of being empty.
 * 3. Alice suceeds in unregistering (unnoting) the empty preimage.
 */
async function preimageEmptyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  setupBalances(client, [{ address: testAccounts.alice.address, amount: 100_000n * 10n ** 10n }])

  // 1. Alice registers an empty preimage.
  const emptyBytes = new Uint8Array(0)
  const emptyBytesHash = blake2AsHex(emptyBytes, 256)

  const notePreimageTx = client.api.tx.preimage.notePreimage(emptyBytes)
  const notePreimageEvents = await sendTransaction(notePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(notePreimageEvents, 'preimage').toMatchSnapshot('note empty preimage events')

  // 2. The registration succeeds, but the stored preimage contains 1 byte of value 0 instead of being empty.
  const events = await getEventsWithType(client, 'preimage')
  expect(events.length).toBe(1)
  assert(client.api.events.preimage.Noted.is(events[0].event))

  let preimage = await client.api.query.preimage.preimageFor([emptyBytesHash, 0])
  const preimageRaw = preimage.unwrap().toU8a()

  assert(preimage.isSome)
  expect(preimageRaw).not.toStrictEqual(emptyBytes)
  expect(preimageRaw).toStrictEqual(new Uint8Array([0]))

  // 3. Alice suceeds in unregistering (unnoting) the empty preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(emptyBytesHash)
  const unnotePreimageEvents = await sendTransaction(unnotePreimageTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(unnotePreimageEvents, 'preimage').toMatchSnapshot('unnote empty preimage events')

  preimage = await client.api.query.preimage.preimageFor([emptyBytesHash, 0])
  assert(preimage.isNone)
}

/**
 * Test the interaction between the preimage pallet's 4 MB size limit and the chain's block length
 * limit for normal extrinsics. The effective limit depends on whichever is smaller.
 *
 * If the block can fit a 4 MB preimage (e.g. Asset Hubs with ~4.25 MB normal limit):
 * 1. Alice registers a 4 MB preimage. It is stored successfully.
 * 2. Alice registers a 4 MB + 1 byte preimage. It fails with `TooBig`.
 *
 * If the block cannot fit a 4 MB preimage (e.g. relay chains with ~3.75 MB normal limit):
 * 1. Alice registers a preimage just under the block's normal dispatch limit. It is stored.
 * 2. Alice registers a 4 MB preimage. The transaction pool rejects it with `exhaustsResources`.
 */
async function preimageSizeLimitTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  setupBalances(client, [{ address: alice.address, amount: 500_000n * 10n ** 12n }])

  const blockLength = client.api.consts.system.blockLength as any
  const normalBlockLimit: number = blockLength.max.normal.toNumber()
  const palletLimitFitsInBlock = normalBlockLimit > PALLET_MAX_PREIMAGE_SIZE

  if (palletLimitFitsInBlock) {
    // 1. Alice registers a 4 MB preimage. It is stored successfully.
    const maxSizeBytes = client.api.createType('Bytes', Array(PALLET_MAX_PREIMAGE_SIZE).fill(2))
    const maxSizeHash = blake2AsHex(maxSizeBytes, 256)

    const noteMaxSizeTx = client.api.tx.preimage.notePreimage(maxSizeBytes)
    const noteMaxSizeEvents = await sendTransaction(noteMaxSizeTx.signAsync(alice))
    await client.dev.newBlock()

    await checkEvents(noteMaxSizeEvents, 'preimage').toMatchSnapshot(
      'note max size preimage events (pallet limit binds)',
    )

    const storedPreimage = await client.api.query.preimage.preimageFor([maxSizeHash, PALLET_MAX_PREIMAGE_SIZE])
    assert(storedPreimage.isSome, 'Max size preimage should be stored')
    expect(storedPreimage.unwrap().length).toBe(PALLET_MAX_PREIMAGE_SIZE)

    // 2. Alice registers a 4 MB + 1 byte preimage. It fails with `TooBig`.
    const oversizedBytes = client.api.createType('Bytes', Array(PALLET_MAX_PREIMAGE_SIZE + 1).fill(1))
    const oversizedHash = blake2AsHex(oversizedBytes, 256)

    const noteOversizedTx = client.api.tx.preimage.notePreimage(oversizedBytes)
    const noteOversizedEvents = await sendTransaction(noteOversizedTx.signAsync(alice))
    await client.dev.newBlock()

    await checkEvents(noteOversizedEvents, 'preimage').toMatchSnapshot(
      'note oversized preimage events (pallet limit binds)',
    )

    expect((await getEventsWithType(client, 'preimage')).length).toBe(0)
    expect((await getEventsWithType(client, 'system')).length).toBeGreaterThan(0)
    await expectFailedExtrinsicWithType(client, client.api.errors.preimage.TooBig)

    const storedOversized = await client.api.query.preimage.preimageFor([oversizedHash, PALLET_MAX_PREIMAGE_SIZE + 1])
    expect(storedOversized.isNone).toBe(true)
  } else {
    // 1. Alice registers a preimage just under the block's normal dispatch limit. It is stored.
    const maxFittingSize = normalBlockLimit - 256 * 1024
    const fittingBytes = client.api.createType('Bytes', Array(maxFittingSize).fill(3))
    const fittingHash = blake2AsHex(fittingBytes, 256)

    const noteFittingTx = client.api.tx.preimage.notePreimage(fittingBytes)
    const noteFittingEvents = await sendTransaction(noteFittingTx.signAsync(alice))
    await client.dev.newBlock()

    await checkEvents(noteFittingEvents, 'preimage').toMatchSnapshot('note fitting preimage events (block limit binds)')

    const storedFitting = await client.api.query.preimage.preimageFor([fittingHash, maxFittingSize])
    assert(storedFitting.isSome, 'Fitting preimage should be stored')
    expect(storedFitting.unwrap().length).toBe(maxFittingSize)

    // 2. Alice registers a 4 MB preimage. The transaction pool rejects it with `exhaustsResources`.
    const maxSizeBytes = client.api.createType('Bytes', Array(PALLET_MAX_PREIMAGE_SIZE).fill(2))
    const maxSizeHash = blake2AsHex(maxSizeBytes, 256)

    const noteMaxSizeTx = client.api.tx.preimage.notePreimage(maxSizeBytes)
    let rejected = false
    try {
      await sendTransaction(noteMaxSizeTx.signAsync(alice))
    } catch (error: any) {
      const msg = error?.message || String(error)
      assert(
        msg.includes('1010') || msg.includes('exhaustsResources'),
        `Expected exhaustsResources rejection, got: ${msg}`,
      )
      rejected = true
    }

    expect(rejected, '4 MB preimage should be rejected by the transaction pool').toBe(true)

    const storedMaxSize = await client.api.query.preimage.preimageFor([maxSizeHash, PALLET_MAX_PREIMAGE_SIZE])
    expect(storedMaxSize.isNone).toBe(true)
  }
}

/**
 * Test `preimage::ensure_updated`, including the fee waiving.
 *
 * 1. Manually inject a number of preimages into the deprecated `StatusFor` storage.
 * 2. Bob registers a number of unrequested preimages - these will go into the `RequestStatusFor` storage.
 * 3. Ensure that all preimages are in storage.
 * 4. Alice calls "ensure_updated" for all the above preimages.
 * 5. Check that the old preimages moved from `StatusFor` storage to `RequestStatusFor` storage.
 * 6. Check that the new preimages are still in `RequestStatusFor` storage.
 * 7. If more than 90% of the preimages were updated from `StatusFor` to `RequestStatusFor`, check that Alice paid
 *    fees.
 */
async function preimageEnsureUpdatedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, oldPreimagesCount: number, newPreimagesCount: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const addressEncoding = chain.properties.addressEncoding
  setupBalances(client, [
    { address: alice.address, amount: 10_000_000n * 10n ** 10n },
    { address: testAccounts.bob.address, amount: 10_000_000n * 10n ** 10n },
  ])

  const expectFees = oldPreimagesCount / (newPreimagesCount + oldPreimagesCount) < 0.9
  let bobNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  // 1. Simulate a number of pre-deprecation preimages
  const bogusPreimageLength = 3
  const preimageHashes: [string, number][] = Array.from({ length: oldPreimagesCount }, (_, i) => [
    blake2AsHex(new Uint8Array(bogusPreimageLength).fill(i + 1), 256),
    bogusPreimageLength,
  ])

  // Manually insert the obsolete preimages into `StatusFor` storage
  // Half are unrequested, half are requested
  const statusForEntries = preimageHashes.slice(0, oldPreimagesCount).map(([hash, len], i) => {
    const halfwayPoint = Math.floor(oldPreimagesCount / 2)
    if (i < halfwayPoint) {
      // Unrequested variant
      return [
        [hash],
        {
          unrequested: {
            deposit: [alice.address, 1000000],
            len,
          },
        },
      ]
    } else {
      // Requested variant
      return [
        [hash],
        {
          requested: {
            deposit: [alice.address, 1000000],
            count: 1,
            len,
          },
        },
      ]
    }
  })

  await client.dev.setStorage({
    Preimage: {
      statusFor: statusForEntries,
    },
  })

  // 2. Bob registers a number of unrequested preimages
  for (let i = 1; i <= newPreimagesCount; i++) {
    const encodedProposal = client.api.tx.system.remarkWithEvent(
      `${REMARK_DATA}${i.toString(16).padStart(2, '0')}`,
    ).method
    const notePreimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
    await sendTransaction(notePreimageTx.signAsync(testAccounts.bob, { nonce: bobNonce++ }))

    preimageHashes.push([encodedProposal.hash.toHex(), encodedProposal.encodedLength])
  }

  if (newPreimagesCount > 0) {
    await client.dev.newBlock()
  }

  // 3. Ensure that all preimages are in storage.
  const halfwayPoint = Math.floor(oldPreimagesCount / 2)
  for (let i = 0; i < oldPreimagesCount + newPreimagesCount; i++) {
    if (i < oldPreimagesCount) {
      const statusFor = await client.api.query.preimage.statusFor(preimageHashes[i][0])
      assert(statusFor.isSome)

      if (i < halfwayPoint) {
        // Check unrequested variant
        await check(statusFor.unwrap()).toMatchObject({
          unrequested: {
            deposit: [encodeAddress(alice.address, addressEncoding), 1000000],
            len: preimageHashes[i][1],
          },
        })
      } else {
        // Check requested variant
        await check(statusFor.unwrap()).toMatchObject({
          requested: {
            deposit: [encodeAddress(alice.address, addressEncoding), 1000000],
            count: 1,
            len: preimageHashes[i][1],
          },
        })
      }
    } else {
      const requestStatusFor = await client.api.query.preimage.requestStatusFor(preimageHashes[i][0])
      assert(requestStatusFor.isSome)
      const unwrapped = requestStatusFor.unwrap()
      expect(unwrapped.isUnrequested).toBe(true)
      const unrequested = unwrapped.asUnrequested
      expect(unrequested.ticket[0].toString()).toBe(encodeAddress(testAccounts.bob.address, addressEncoding))
      expect(unrequested.len.toNumber()).toBe(preimageHashes[i][1])
    }
  }

  // 4. Alice calls "ensure_updated" for all preimages.
  const ensureUpdatedTx = client.api.tx.preimage.ensureUpdated(preimageHashes.map(([hash]) => hash))
  const ensureUpdatedEvents = await sendTransaction(ensureUpdatedTx.signAsync(alice))
  await client.dev.newBlock()

  await checkEvents(ensureUpdatedEvents, 'preimage').toMatchSnapshot('ensure updated preimage events')

  // 5. Check that the old preimages moved from `StatusFor` storage to `RequestStatusFor` storage.
  for (let i = 0; i < oldPreimagesCount; i++) {
    const statusFor = await client.api.query.preimage.statusFor(preimageHashes[i][0])
    expect(statusFor.isNone).toBe(true)

    const requestStatusFor = await client.api.query.preimage.requestStatusFor(preimageHashes[i][0])
    assert(requestStatusFor.isSome)

    const unwrapped = requestStatusFor.unwrap()

    if (i < halfwayPoint) {
      // Was unrequested, now unrequested in new storage
      expect(unwrapped.isUnrequested).toBe(true)
      const unrequested = unwrapped.asUnrequested
      expect(unrequested.ticket[0].toString()).toBe(encodeAddress(alice.address, addressEncoding))
      expect(unrequested.len.toNumber()).toBe(preimageHashes[i][1])
    } else {
      // Was requested, now requested in new storage
      expect(unwrapped.isRequested).toBe(true)
      const requested = unwrapped.asRequested
      expect(requested.maybeTicket.unwrap()[0].toString()).toBe(encodeAddress(alice.address, addressEncoding))
      expect(requested.count.toNumber()).toBe(1)
      expect(requested.maybeLen.unwrap().toNumber()).toBe(preimageHashes[i][1])
    }
  }

  // 6. Check that the new preimages are still in `RequestStatusFor` storage.
  for (let i = oldPreimagesCount; i < oldPreimagesCount + newPreimagesCount; i++) {
    const requestStatusFor = await client.api.query.preimage.requestStatusFor(preimageHashes[i][0])
    assert(requestStatusFor.isSome)
    const unwrapped = requestStatusFor.unwrap()
    expect(unwrapped.isUnrequested).toBe(true)
    const unrequested = unwrapped.asUnrequested
    expect(unrequested.ticket[0].toString()).toBe(encodeAddress(testAccounts.bob.address, addressEncoding))
    expect(unrequested.len.toNumber()).toBe(preimageHashes[i][1])
  }

  // 7. If more than 90% of the preimages were updated from `StatusFor` to `RequestStatusFor`, check that Alice paid
  //    fees.

  // Get the transaction fee from the payment event.
  const events = await client.api.query.system.events()
  const feeEvents = chain.properties.feeExtractor(events, client.api)
  assert(feeEvents.length === 1, `expected exactly 1 TransactionFeePaid event, got ${feeEvents.length}`)
  const feeInfo = feeEvents[0]
  expect(feeInfo.tip, 'Unexpected extrinsic tip').toBe(0n)
  // If the ratio of old to total preimages is more than 90%, fees are not paid.
  if (expectFees) {
    expect(feeInfo.actualFee).toBeGreaterThan(0n)
  } else {
    expect(feeInfo.actualFee).toBe(0n)
  }
}

export function successPreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'preimage tests',
        children: [
          {
            kind: 'test',
            label: 'preimage single note and unnote test',
            testFn: async () => await preimageSingleNoteUnnoteTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage single request and unrequest test',
            testFn: async () => await preimageSingleRequestUnrequestTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage single request and multiple unrequest test',
            testFn: async () => await preimageSingleRequestMultipleUnrequestTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage note and then request test',
            testFn: async () => await preimageNoteThenRequestTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage request and unnote test',
            testFn: async () => await preimageRequestAndUnnoteTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage request and then note test',
            testFn: async () => await preimageRequestThenNoteTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage empty test',
            testFn: async () => await preimageEmptyTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage ensure updated test (no fees due)',
            testFn: async () => await preimageEnsureUpdatedTest(chain, 10, 1),
          },
          {
            kind: 'test',
            label: 'preimage ensure updated test (fees due)',
            testFn: async () => await preimageEnsureUpdatedTest(chain, 5, 5),
          },
        ],
      },
    ],
  }
}

export function failurePreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>): RootTestTree {
  return {
    kind: 'describe',
    label: 'failure tests',
    children: [
      {
        kind: 'test',
        label: 'preimage single request and unrequest test as non-root',
        testFn: async () => await preimageSingleRequestUnrequestAsNonRootTest(chain),
      },
      {
        kind: 'test',
        label: 'preimage repeated note and unnote test',
        testFn: async () => await preimageRepeatedNoteUnnoteTest(chain),
      },
      {
        kind: 'test',
        label: 'preimage size limit test',
        testFn: async () => await preimageSizeLimitTest(chain),
      },
    ],
  }
}

export function basePreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [successPreimageE2ETests(chain, testConfig), failurePreimageE2ETests(chain)],
  }
}
