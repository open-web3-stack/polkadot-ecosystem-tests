/**
 * E2E tests for `pallet_whitelist` on the Asset Hubs.
 *
 * The pallet splits a Root-level action between two origins. `WhitelistOrigin` puts the hash of a
 * call on a list with `whitelist_call`, or takes it off with `remove_whitelisted_call`.
 * `DispatchWhitelistedOrigin` dispatches a call whose hash is on the list, and the pallet runs that
 * call as Root. The first dispatch takes the hash off the list, so each listing allows one
 * dispatch. While a hash is listed, the pallet holds one request for its preimage in
 * `pallet_preimage`.
 *
 * Origins: on the Asset Hubs `WhitelistOrigin` is Root or the Technical Fellowship speaking over
 * XCM, and `DispatchWhitelistedOrigin` is Root or `WhitelistedCaller`, the origin of the referendum
 * track of the same name. The tests here dispatch calls as Root and as custom governance origins by
 * writing them into the scheduler's agenda. The Fellowship's XCM path is exercised in
 * `fellowshipReferenda.ts` and `bridge.ts`, and a `WhitelistedCaller` referendum in `upgrade.ts`.
 *
 * Fork caveats: a call the scheduler dispatches never emits `system.ExtrinsicFailed`. Its outcome
 * is the `result` of its `scheduler.Dispatched` event. The fork may also carry hashes that live
 * governance has listed, so each test uses its own hash and first checks that it is not listed.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { EventRecord } from '@polkadot/types/interfaces'
import { u8aConcat, u8aToHex } from '@polkadot/util'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import type { TestContext } from 'vitest'
import { assert, expect } from 'vitest'

import {
  check,
  checkEvents,
  getFreeFunds,
  getReservedFunds,
  nextSchedulableBlockNum,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import { setupBalances } from './setup.js'

/// -------
/// Constants
/// -------

/**
 * Free balance given to each signer, in existential deposits.
 *
 * Signers pay transaction fees and, in one test, the deposit for noting a short preimage. Both are
 * far below this amount on either Asset Hub.
 */
const FUNDS_IN_EXISTENTIAL_DEPOSITS = 100_000n

/**
 * Free balance that the whitelisted call gives its target account, in existential deposits.
 *
 * It is above one existential deposit, so the call sets the balance instead of reaping the account.
 */
const TARGET_BALANCE_IN_EXISTENTIAL_DEPOSITS = 5n

/** The origin of the `whitelisted_caller` referendum track. It may dispatch whitelisted calls. */
const WHITELISTED_CALLER_ORIGIN: any = { Origins: 'WhitelistedCaller' }

/**
 * The origin of the `staking_admin` referendum track.
 *
 * It stands for a governance origin that has nothing to do with the whitelist: it may neither list
 * a hash nor dispatch a whitelisted call.
 */
const STAKING_ADMIN_ORIGIN: any = { Origins: 'StakingAdmin' }

/// -------
/// Helpers
/// -------

/** Give each account `FUNDS_IN_EXISTENTIAL_DEPOSITS` existential deposits of free balance. */
async function fundAccounts(client: Client<any, any>, ...accounts: KeyringPair[]) {
  const amount = client.api.consts.balances.existentialDeposit.toBigInt() * FUNDS_IN_EXISTENTIAL_DEPOSITS
  await setupBalances(
    client,
    accounts.map(({ address }) => ({ address, amount })),
  )
}

/** The free balance that `targetCall` gives its target account. */
function targetBalance(client: Client<any, any>): bigint {
  return client.api.consts.balances.existentialDeposit.toBigInt() * TARGET_BALANCE_IN_EXISTENTIAL_DEPOSITS
}

/**
 * The call the tests whitelist: `balances.force_set_balance`, giving `testAccounts.bob` a fixed
 * balance.
 *
 * It admits only Root, so its success shows which origin the pallet dispatched it with, and it
 * leaves an event and a balance to check.
 */
function targetCall(client: Client<any, any>) {
  return client.api.tx.balances.forceSetBalance(testAccounts.bob.address, targetBalance(client))
}

/**
 * A call that fails when the pallet dispatches it: `system.remark_with_event`.
 *
 * It admits only a signed origin, and the pallet dispatches whitelisted calls as Root, so it fails
 * with `BadOrigin`.
 */
function failingCall(client: Client<any, any>) {
  return client.api.tx.system.remarkWithEvent('whitelist e2e')
}

/** An account's address in the chain's SS58 format, for comparing against account ids in events. */
function addressOf(client: Client<any, any>, account: KeyringPair): string {
  return encodeAddress(account.address, client.config.properties.addressEncoding)
}

/**
 * Skip the running test on a runtime that has deferred dispatch.
 *
 * Deferred dispatch changes two outcomes. When `DispatchWhitelistedOrigin` dispatches a hash that
 * is not listed, the pallet stores a deferred entry instead of failing with `CallIsNotWhitelisted`.
 * When a signed account dispatches, the pallet looks for such an entry and fails with
 * `DeferredDispatchNotFound` instead of `BadOrigin`. Tests of the outcomes without the feature do
 * not apply to such a runtime. A runtime has the feature when it exposes the
 * `whitelist.deferredDispatch` storage map.
 */
function skipOnDeferredDispatch(client: Client<any, any>, ctx: TestContext | undefined) {
  if (client.api.query.whitelist.deferredDispatch === undefined) return
  assert(ctx, 'the test context is needed to skip the test')
  ctx.skip('the runtime has deferred dispatch, which replaces the outcome this test checks')
}

/**
 * The head block's `scheduler.Dispatched` records for tasks from the agenda at `agendaBlock`, in
 * agenda order.
 *
 * Injected calls go into the agenda at the block the scheduler services next. Matching on that
 * block keeps out tasks of live governance, which the same block may also dispatch.
 */
async function dispatchedFromAgenda(client: Client<any, any>, agendaBlock: number) {
  const events = await client.api.query.system.events()
  return events
    .filter(
      ({ event }) => client.api.events.scheduler.Dispatched.is(event) && event.data.task[0].toNumber() === agendaBlock,
    )
    .sort((a, b) => (a.event.data as any).task[1].toNumber() - (b.event.data as any).task[1].toNumber())
}

/** The head block's events from the `whitelist` pallet, in block order. */
async function whitelistEvents(client: Client<any, any>) {
  const events = await client.api.query.system.events()
  return events.filter(({ event }) => event.section === 'whitelist')
}

/** The head block's `balances.BalanceSet` events for `account`, in block order. */
async function balanceSetEvents(client: Client<any, any>, account: KeyringPair) {
  const events = await client.api.query.system.events()
  return events.filter(
    ({ event }) =>
      client.api.events.balances.BalanceSet.is(event) && event.data.who.toString() === addressOf(client, account),
  )
}

/**
 * Number of preimage requests held for `hash`.
 *
 * Zero when `pallet_preimage` has no status for the hash, or when the preimage is noted but nobody
 * requests it.
 */
async function preimageRequestCount(client: Client<any, any>, hash: string): Promise<number> {
  const status = await client.api.query.preimage.requestStatusFor(hash)
  if (status.isNone || !status.unwrap().isRequested) return 0
  return status.unwrap().asRequested.count.toNumber()
}

/** The bytes `pallet_preimage` stores under `hash` and `length`, as hex, or `null` if it stores none. */
async function storedPreimage(client: Client<any, any>, hash: string, length: number): Promise<string | null> {
  const stored = await client.api.query.preimage.preimageFor([hash, length])
  return stored.isSome ? u8aToHex(stored.unwrap().toU8a(true)) : null
}

/**
 * Assert that a `scheduler.Dispatched` record carries a failed result with the named `whitelist`
 * error.
 *
 * The error is looked up in metadata first, so a renamed error fails the test instead of matching
 * nothing.
 */
function expectDispatchedError(client: Client<any, any>, record: { event: any }, errorName: string) {
  const { event } = record
  assert(client.api.events.scheduler.Dispatched.is(event))
  assert(event.data.result.isErr, 'expected the dispatch to fail')
  const dispatchError = event.data.result.asErr
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)

  const whitelistErrors = client.api.errors.whitelist as any
  assert(whitelistErrors[errorName], `runtime has no whitelist error named ${errorName}`)
  expect(whitelistErrors[errorName].is(dispatchError.asModule), `expected whitelist.${errorName}`).toBe(true)
}

/** Assert that a `scheduler.Dispatched` record carries a failed result with `BadOrigin`. */
function expectDispatchedBadOrigin(client: Client<any, any>, record: { event: any }) {
  const { event } = record
  assert(client.api.events.scheduler.Dispatched.is(event))
  assert(event.data.result.isErr, 'expected the dispatch to fail')
  expect(event.data.result.asErr.isBadOrigin, `expected BadOrigin, got ${event.data.result.asErr.type}`).toBe(true)
}

/**
 * Assert that the signed extrinsic `tx` failed with `BadOrigin`.
 *
 * Only the events `tx` itself emitted are read, as `sendTransaction` returns them, so another
 * extrinsic in the same block can neither break this check nor satisfy it.
 */
async function expectExtrinsicBadOrigin(
  client: Client<any, any>,
  tx: Awaited<ReturnType<typeof sendTransaction>>,
): Promise<void> {
  const events = (await tx.events) as EventRecord[]
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures, 'expected the extrinsic to fail').toHaveLength(1)

  const failure = failures[0].event
  assert(client.api.events.system.ExtrinsicFailed.is(failure))
  const { dispatchError } = failure.data
  expect(dispatchError.isBadOrigin, `expected BadOrigin, got ${dispatchError.type}`).toBe(true)
}

/**
 * The weight of `call` as the runtime computes it.
 *
 * This is the weight `dispatch_whitelisted_call` compares its weight witness against.
 */
async function callWeight(client: Client<any, any>, call: { method: any }) {
  const info = await client.api.call.transactionPaymentCallApi.queryCallInfo(call.method, call.method.encodedLength)
  return info.weight
}

/**
 * Setup: `account` notes `bytes` as a preimage.
 *
 * Asserts the bytes are stored under their hash and length, so a later failure in the test cannot
 * come from it.
 */
async function notePreimage(client: Client<any, any>, account: KeyringPair, bytes: Uint8Array) {
  await sendTransaction(client.api.tx.preimage.notePreimage(u8aToHex(bytes)).signAsync(account))
  await client.dev.newBlock()

  const stored = await client.api.query.preimage.preimageFor([blake2AsHex(bytes, 256), bytes.length])
  expect(stored.isSome, 'setup: the preimage was not noted').toBe(true)
}

/**
 * Setup: Root whitelists `callHash` through the scheduler in the next block.
 *
 * Asserts the hash is listed afterwards, so a later failure in the test cannot come from it.
 */
async function whitelistAsRoot(client: Client<any, any>, callHash: string) {
  const { schedulerBlockProvider } = client.config.properties
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.whitelistCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched, 'setup: the whitelist call was not dispatched').toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk, 'setup: the whitelist call failed').toBe(true)
  expect(
    (await client.api.query.whitelist.whitelistedCall(callHash)).isSome,
    'setup: the hash was not whitelisted',
  ).toBe(true)
}

/// -------
/// Tests: whitelist_call
/// -------

/**
 * Root whitelists a call hash.
 *
 * Root is one of the two origins `WhitelistOrigin` admits. Listing the hash also makes the pallet
 * request its preimage, so that the bytes stay available for a later dispatch by hash. Nobody has
 * noted the preimage here, so the request carries neither an owner nor a length.
 *
 * 1. Verify the hash is not listed and has no preimage request
 * 2. Dispatch `whitelist_call` as Root
 * 3. Verify the dispatch succeeded, with one `CallWhitelisted` event and one `preimage.Requested`
 *    event for the hash
 * 4. Verify the hash is listed and has exactly one preimage request
 */
async function rootWhitelistsCall(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)

  // 2. `whitelist_call` as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.whitelistCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched, `CallWhitelisted` and `preimage.Requested`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const whitelisted = await whitelistEvents(client)
  const requested = (await client.api.query.system.events()).filter(
    ({ event }) => client.api.events.preimage.Requested.is(event) && event.data.hash_.toHex() === callHash,
  )
  await check([...dispatched, ...whitelisted, ...requested])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('whitelist as Root: Dispatched, CallWhitelisted and preimage Requested events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelisted).toHaveLength(1)
  assert(client.api.events.whitelist.CallWhitelisted.is(whitelisted[0].event))
  expect(whitelisted[0].event.data.callHash.toHex()).toBe(callHash)
  expect(requested).toHaveLength(1)

  // 4. Listed, with one preimage request that has no owner and no known length
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  const status = (await client.api.query.preimage.requestStatusFor(callHash)).unwrap()
  assert(status.isRequested, `expected a requested preimage, got ${status.type}`)
  expect(status.asRequested.count.toNumber()).toBe(1)
  expect(status.asRequested.maybeTicket.isNone).toBe(true)
  expect(status.asRequested.maybeLen.isNone).toBe(true)
}

/**
 * Whitelisting a hash that is already listed fails with `CallAlreadyWhitelisted`.
 *
 * The check runs before the pallet requests the preimage, so the rejected call must not leave a
 * second request behind. A second request would keep the preimage pinned after the hash is
 * dispatched or removed.
 *
 * 1. Whitelist the hash as Root
 * 2. Dispatch `whitelist_call` for the same hash as Root again
 * 3. Verify the dispatch failed with `CallAlreadyWhitelisted` and emitted no whitelist event
 * 4. Verify the hash is still listed with exactly one preimage request
 */
async function whitelistListedCallFails(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)
  expect(await preimageRequestCount(client, callHash)).toBe(1)

  // 2. `whitelist_call` again
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.whitelistCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `CallAlreadyWhitelisted`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('whitelist twice: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'CallAlreadyWhitelisted')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/**
 * A signed account cannot whitelist a call hash.
 *
 * `WhitelistOrigin` admits only Root and the Fellowship, so an ordinary account is rejected with
 * `BadOrigin` however much balance it holds.
 *
 * 1. Fund a signer and verify the hash is not listed
 * 2. Send `whitelist_call` from the signer
 * 3. Verify the extrinsic failed with `BadOrigin`
 * 4. Verify the hash is not listed and has no preimage request
 */
async function signedWhitelistFails(client: Client<any, any>) {
  const { alice } = testAccounts
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Funded signer, hash not listed
  await fundAccounts(client, alice)
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 2. `whitelist_call` from a signed account
  const tx = await sendTransaction(client.api.tx.whitelist.whitelistCall(callHash).signAsync(alice))
  await client.dev.newBlock()

  // 3. `BadOrigin`
  await checkEvents(tx, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed whitelist: ExtrinsicFailed event',
  )
  await expectExtrinsicBadOrigin(client, tx)

  // 4. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/**
 * The origin that dispatches whitelisted calls cannot whitelist them.
 *
 * `WhitelistedCaller` passes `DispatchWhitelistedOrigin` but not `WhitelistOrigin`. If it passed
 * both, a referendum on its track could list a call and dispatch it as Root without the
 * Fellowship.
 *
 * 1. Verify the hash is not listed
 * 2. Dispatch `whitelist_call` as `WhitelistedCaller`
 * 3. Verify the dispatch failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the hash is not listed and has no preimage request
 */
async function whitelistedCallerWhitelistFails(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Not listed
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 2. `whitelist_call` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.whitelistCall(callHash).method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('whitelist as WhitelistedCaller: Dispatched event')
  expectDispatchedBadOrigin(client, dispatched[0])
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/// -------
/// Tests: remove_whitelisted_call
/// -------

/**
 * Root removes a whitelisted call hash.
 *
 * Removal is how a listing is revoked before anyone dispatches it. It also gives back the preimage
 * request taken when the hash was listed. Nobody noted the preimage here, so once the request is
 * gone `pallet_preimage` keeps no status for the hash at all.
 *
 * 1. Whitelist the hash as Root
 * 2. Dispatch `remove_whitelisted_call` as Root
 * 3. Verify the dispatch succeeded with one `WhitelistedCallRemoved` event for the hash
 * 4. Verify the hash is no longer listed and has no preimage request
 */
async function rootRemovesWhitelistedCall(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)
  expect(await preimageRequestCount(client, callHash)).toBe(1)

  // 2. `remove_whitelisted_call` as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.removeWhitelistedCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched and `WhitelistedCallRemoved`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const removed = await whitelistEvents(client)
  await check([...dispatched, ...removed])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('remove as Root: Dispatched and WhitelistedCallRemoved events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(removed).toHaveLength(1)
  assert(client.api.events.whitelist.WhitelistedCallRemoved.is(removed[0].event))
  expect(removed[0].event.data.callHash.toHex()).toBe(callHash)

  // 4. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/**
 * Removing a hash that is not listed fails with `CallIsNotWhitelisted`.
 *
 * The pallet takes the entry before it gives back the preimage request, so a removal with nothing
 * to take must not touch `pallet_preimage`.
 *
 * 1. Verify the hash is not listed
 * 2. Dispatch `remove_whitelisted_call` as Root
 * 3. Verify the dispatch failed with `CallIsNotWhitelisted` and emitted no whitelist event
 * 4. Verify the hash is still not listed and has no preimage request
 */
async function removeUnlistedCallFails(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Not listed
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 2. `remove_whitelisted_call` as Root
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.removeWhitelistedCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `CallIsNotWhitelisted`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('remove unlisted hash: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'CallIsNotWhitelisted')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/**
 * A signed account cannot remove a whitelisted call hash.
 *
 * Removal is gated by the same `WhitelistOrigin` as listing. If any account could remove a hash,
 * it could block every whitelisted dispatch.
 *
 * 1. Whitelist the hash as Root and fund a signer
 * 2. Send `remove_whitelisted_call` from the signer
 * 3. Verify the extrinsic failed with `BadOrigin`
 * 4. Verify the hash is still listed with its preimage request
 */
async function signedRemoveFails(client: Client<any, any>) {
  const { alice } = testAccounts
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Whitelisted hash, funded signer
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)

  // 2. `remove_whitelisted_call` from a signed account
  const tx = await sendTransaction(client.api.tx.whitelist.removeWhitelistedCall(callHash).signAsync(alice))
  await client.dev.newBlock()

  // 3. `BadOrigin`
  await checkEvents(tx, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed remove: ExtrinsicFailed event',
  )
  await expectExtrinsicBadOrigin(client, tx)
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/**
 * The origin that dispatches whitelisted calls cannot remove them from the list.
 *
 * `WhitelistedCaller` passes `DispatchWhitelistedOrigin` but not `WhitelistOrigin`, which gates
 * removal as well as listing.
 *
 * 1. Whitelist the hash as Root
 * 2. Dispatch `remove_whitelisted_call` as `WhitelistedCaller`
 * 3. Verify the dispatch failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the hash is still listed with its preimage request
 */
async function whitelistedCallerRemoveFails(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)

  // 2. `remove_whitelisted_call` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.removeWhitelistedCall(callHash).method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('remove as WhitelistedCaller: Dispatched event')
  expectDispatchedBadOrigin(client, dispatched[0])
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/**
 * A removed hash can be whitelisted again.
 *
 * Removal leaves nothing behind that would make a later `whitelist_call` for the same hash fail
 * with `CallAlreadyWhitelisted`. The second listing takes a fresh preimage request, so the count is
 * one again and not two.
 *
 * 1. Whitelist the hash as Root
 * 2. Dispatch `remove_whitelisted_call` as Root, and verify the hash is no longer listed
 * 3. Dispatch `whitelist_call` for the same hash as Root
 * 4. Verify the dispatch succeeded with one `CallWhitelisted` event for the hash
 * 5. Verify the hash is listed with exactly one preimage request
 */
async function removedCallCanBeWhitelistedAgain(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const callHash = targetCall(client).method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)

  // 2. `remove_whitelisted_call` as Root
  const removeAgendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.removeWhitelistedCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const removeDispatched = await dispatchedFromAgenda(client, removeAgendaBlock)
  expect(removeDispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(removeDispatched[0].event))
  expect(removeDispatched[0].event.data.result.isOk).toBe(true)
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 3. `whitelist_call` again as Root
  const whitelistAgendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.whitelistCall(callHash).method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Dispatched and `CallWhitelisted`
  const whitelistDispatched = await dispatchedFromAgenda(client, whitelistAgendaBlock)
  const whitelisted = await whitelistEvents(client)
  await check([...whitelistDispatched, ...whitelisted])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('whitelist after removal: Dispatched and CallWhitelisted events')

  expect(whitelistDispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(whitelistDispatched[0].event))
  expect(whitelistDispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelisted).toHaveLength(1)
  assert(client.api.events.whitelist.CallWhitelisted.is(whitelisted[0].event))
  expect(whitelisted[0].event.data.callHash.toHex()).toBe(callHash)

  // 5. Listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/// -------
/// Tests: dispatch_whitelisted_call_with_preimage
/// -------

/**
 * `dispatchOrigin` dispatches a whitelisted call, passing the call itself.
 *
 * `DispatchWhitelistedOrigin` admits Root and `WhitelistedCaller`, and the test runs once with
 * each. Whichever of the two dispatches, the pallet runs the inner call as Root: the inner call is
 * `balances.force_set_balance`, which admits no other origin. The dispatch takes the hash off the
 * list and gives back its preimage request.
 *
 * 1. Whitelist the call's hash as Root, and verify the target account does not hold the target
 *    balance yet
 * 2. Dispatch `dispatch_whitelisted_call_with_preimage` with the call as `dispatchOrigin`
 * 3. Verify the dispatch succeeded, with one `WhitelistedCallDispatched` event carrying an `Ok`
 *    result and one `BalanceSet` event for the target account
 * 4. Verify the target account holds exactly the target balance
 * 5. Verify the hash is no longer listed and has no preimage request
 */
async function dispatchWithPreimageRunsCallAsRoot(client: Client<any, any>, dispatchOrigin: any) {
  const { bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callHash = call.method.hash.toHex()

  // 1. Whitelist; the target balance is not there yet
  await whitelistAsRoot(client, callHash)
  expect(await getFreeFunds(client, bob.address)).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call_with_preimage` as `dispatchOrigin`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).method.toHex(),
    dispatchOrigin,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched, `WhitelistedCallDispatched` with `Ok`, and `BalanceSet`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const whitelistRecords = await whitelistEvents(client)
  const balanceSet = await balanceSetEvents(client, bob)
  await check([...dispatched, ...whitelistRecords, ...balanceSet])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch with preimage: Dispatched, WhitelistedCallDispatched and BalanceSet events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelistRecords).toHaveLength(1)
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(whitelistRecords[0].event))
  expect(whitelistRecords[0].event.data.callHash.toHex()).toBe(callHash)
  expect(whitelistRecords[0].event.data.result.isOk).toBe(true)

  expect(balanceSet).toHaveLength(1)
  assert(client.api.events.balances.BalanceSet.is(balanceSet[0].event))
  expect(balanceSet[0].event.data.free.toBigInt()).toBe(targetBalance(client))

  // 4. The inner call took effect
  expect(await getFreeFunds(client, bob.address)).toBe(targetBalance(client))

  // 5. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/**
 * Dispatching a call whose hash is not listed fails with `CallIsNotWhitelisted`.
 *
 * This is the check the pallet exists for: `WhitelistedCaller` alone cannot make a call run as
 * Root. The inner call must not run.
 *
 * Skipped on a runtime with deferred dispatch, where this dispatch is deferred instead.
 *
 * 1. Verify the call's hash is not listed, and record the target account's balance
 * 2. Dispatch `dispatch_whitelisted_call_with_preimage` with the call as `WhitelistedCaller`
 * 3. Verify the dispatch failed with `CallIsNotWhitelisted`, with no whitelist event and no
 *    `BalanceSet` event for the target account
 * 4. Verify the target account's balance is unchanged and the hash is still not listed
 */
async function dispatchUnlistedCallWithPreimageFails(client: Client<any, any>, ctx: TestContext | undefined) {
  skipOnDeferredDispatch(client, ctx)

  const { bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callHash = call.method.hash.toHex()

  // 1. Not listed
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call_with_preimage` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `CallIsNotWhitelisted`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch unlisted call with preimage: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'CallIsNotWhitelisted')
  expect(await whitelistEvents(client)).toHaveLength(0)
  expect(await balanceSetEvents(client, bob)).toHaveLength(0)

  // 4. Nothing changed
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
}

/**
 * A whitelisted call can be dispatched once.
 *
 * The first dispatch takes the hash off the list, so a second dispatch of the same call fails with
 * `CallIsNotWhitelisted`. Running the call again needs its hash to be whitelisted again.
 *
 * Skipped on a runtime with deferred dispatch, where the second dispatch is deferred instead.
 *
 * 1. Whitelist the call's hash as Root
 * 2. Dispatch `dispatch_whitelisted_call_with_preimage` with the call as `WhitelistedCaller`, and
 *    verify it succeeded
 * 3. Dispatch the same call as `WhitelistedCaller` again
 * 4. Verify the second dispatch failed with `CallIsNotWhitelisted`, with no whitelist event and no
 *    `BalanceSet` event for the target account
 */
async function dispatchWithPreimageTwiceFails(client: Client<any, any>, ctx: TestContext | undefined) {
  skipOnDeferredDispatch(client, ctx)

  const { bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callHash = call.method.hash.toHex()
  const dispatchCall = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).method.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)

  // 2. First dispatch
  const firstAgendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(client, dispatchCall, WHITELISTED_CALLER_ORIGIN, schedulerBlockProvider)
  await client.dev.newBlock()

  const firstDispatched = await dispatchedFromAgenda(client, firstAgendaBlock)
  expect(firstDispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(firstDispatched[0].event))
  expect(firstDispatched[0].event.data.result.isOk).toBe(true)
  expect(await whitelistEvents(client)).toHaveLength(1)
  expect(await getFreeFunds(client, bob.address)).toBe(targetBalance(client))

  // 3. Second dispatch
  const secondAgendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(client, dispatchCall, WHITELISTED_CALLER_ORIGIN, schedulerBlockProvider)
  await client.dev.newBlock()

  // 4. `CallIsNotWhitelisted`
  const secondDispatched = await dispatchedFromAgenda(client, secondAgendaBlock)
  expect(secondDispatched).toHaveLength(1)
  await check(secondDispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('second dispatch with preimage: Dispatched event')
  expectDispatchedError(client, secondDispatched[0], 'CallIsNotWhitelisted')
  expect(await whitelistEvents(client)).toHaveLength(0)
  expect(await balanceSetEvents(client, bob)).toHaveLength(0)
}

/**
 * A whitelisted call that fails still uses up its listing.
 *
 * The pallet takes the hash off the list before it runs the inner call, and reports the inner
 * call's outcome in `WhitelistedCallDispatched` instead of failing the dispatch. So the scheduler
 * records the outer dispatch as `Ok`, and the inner call's error is only visible in the event. The
 * inner call here is `system.remark_with_event`, which fails with `BadOrigin` under Root.
 *
 * 1. Whitelist the failing call's hash as Root
 * 2. Dispatch `dispatch_whitelisted_call_with_preimage` with the call as `WhitelistedCaller`
 * 3. Verify the outer dispatch succeeded, and that `WhitelistedCallDispatched` carries an `Err`
 *    result with `BadOrigin`
 * 4. Verify the inner call emitted no `system.Remarked` event
 * 5. Verify the hash is no longer listed and has no preimage request
 */
async function dispatchFailingCallConsumesListing(client: Client<any, any>) {
  const { schedulerBlockProvider } = client.config.properties
  const call = failingCall(client)
  const callHash = call.method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)

  // 2. `dispatch_whitelisted_call_with_preimage` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Outer dispatch `Ok`, inner result `Err(BadOrigin)`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const whitelistRecords = await whitelistEvents(client)
  await check([...dispatched, ...whitelistRecords])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch failing call: Dispatched and WhitelistedCallDispatched events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelistRecords).toHaveLength(1)
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(whitelistRecords[0].event))
  expect(whitelistRecords[0].event.data.callHash.toHex()).toBe(callHash)
  const innerResult = whitelistRecords[0].event.data.result
  assert(innerResult.isErr, 'expected the inner call to fail')
  expect(innerResult.asErr.error.isBadOrigin, `expected BadOrigin, got ${innerResult.asErr.error.type}`).toBe(true)

  // 4. The inner call did not run to completion
  const events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.system.Remarked.is(event))).toHaveLength(0)

  // 5. Not listed, no preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
}

/**
 * A signed account cannot dispatch a whitelisted call.
 *
 * Being listed makes a call dispatchable by `DispatchWhitelistedOrigin` only. An ordinary account
 * is rejected with `BadOrigin`, and the listing stays in place for the real dispatcher.
 *
 * Skipped on a runtime with deferred dispatch, where a signed dispatch fails with another error.
 *
 * 1. Whitelist the call's hash as Root, fund a signer, and record the target account's balance
 * 2. Send `dispatch_whitelisted_call_with_preimage` with the call from the signer
 * 3. Verify the extrinsic failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request
 */
async function signedDispatchWithPreimageFails(client: Client<any, any>, ctx: TestContext | undefined) {
  skipOnDeferredDispatch(client, ctx)

  const { alice, bob } = testAccounts
  const call = targetCall(client)
  const callHash = call.method.hash.toHex()

  // 1. Whitelisted hash, funded signer
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call_with_preimage` from a signed account
  const tx = await sendTransaction(
    client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).signAsync(alice),
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  await checkEvents(tx, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed dispatch with preimage: ExtrinsicFailed event',
  )
  await expectExtrinsicBadOrigin(client, tx)
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/**
 * A governance origin other than `WhitelistedCaller` cannot dispatch a whitelisted call.
 *
 * `StakingAdmin` is a real referendum origin on the same runtime, but `DispatchWhitelistedOrigin`
 * admits only Root and `WhitelistedCaller`. The listing stays in place.
 *
 * 1. Whitelist the call's hash as Root, and record the target account's balance
 * 2. Dispatch `dispatch_whitelisted_call_with_preimage` with the call as `StakingAdmin`
 * 3. Verify the dispatch failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request
 */
async function stakingAdminDispatchWithPreimageFails(client: Client<any, any>) {
  const { bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callHash = call.method.hash.toHex()

  // 1. Whitelist
  await whitelistAsRoot(client, callHash)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call_with_preimage` as `StakingAdmin`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()).method.toHex(),
    STAKING_ADMIN_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch with preimage as StakingAdmin: Dispatched event')
  expectDispatchedBadOrigin(client, dispatched[0])
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/// -------
/// Tests: dispatch_whitelisted_call
/// -------

/**
 * `WhitelistedCaller` dispatches a whitelisted call by its hash, with exact witnesses.
 *
 * `dispatch_whitelisted_call` takes the hash, the encoded length and a weight witness, and loads
 * the call from its preimage. The witnesses here are exact: the real encoded length and the real
 * call weight. The preimage is noted after the hash was whitelisted, so it is stored under the
 * pallet's request and has no owner. When the dispatch gives the request back, nobody needs the
 * bytes any more and `pallet_preimage` deletes them.
 *
 * 1. Whitelist the call's hash as Root, then have a signed account note the preimage
 * 2. Verify the preimage is stored under the pallet's request, with no owner and no deposit taken
 * 3. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`, with the exact length and weight
 * 4. Verify the dispatch succeeded, with one `WhitelistedCallDispatched` event carrying an `Ok`
 *    result, one `BalanceSet` event for the target account and one `preimage.Cleared` event
 * 5. Verify the target account holds exactly the target balance
 * 6. Verify the hash is no longer listed, and its preimage and request are gone
 */
async function dispatchByHashRunsNotedCall(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist, then note the preimage
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)

  // 2. Stored under the pallet's request: no owner, no deposit
  const noted = (await client.api.query.preimage.requestStatusFor(callHash)).unwrap()
  assert(noted.isRequested, `expected a requested preimage, got ${noted.type}`)
  expect(noted.asRequested.count.toNumber()).toBe(1)
  expect(noted.asRequested.maybeTicket.isNone).toBe(true)
  expect(noted.asRequested.maybeLen.unwrap().toNumber()).toBe(callBytes.length)
  expect(await getReservedFunds(client, alice.address)).toBe(0n)
  expect(await getFreeFunds(client, bob.address)).not.toBe(targetBalance(client))

  // 3. `dispatch_whitelisted_call` as `WhitelistedCaller`, exact witnesses
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Dispatched, `WhitelistedCallDispatched` with `Ok`, `BalanceSet` and `preimage.Cleared`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const whitelistRecords = await whitelistEvents(client)
  const balanceSet = await balanceSetEvents(client, bob)
  const cleared = (await client.api.query.system.events()).filter(
    ({ event }) => client.api.events.preimage.Cleared.is(event) && event.data.hash_.toHex() === callHash,
  )
  await check([...dispatched, ...whitelistRecords, ...balanceSet, ...cleared])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash: Dispatched, WhitelistedCallDispatched, BalanceSet and preimage Cleared events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelistRecords).toHaveLength(1)
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(whitelistRecords[0].event))
  expect(whitelistRecords[0].event.data.callHash.toHex()).toBe(callHash)
  expect(whitelistRecords[0].event.data.result.isOk).toBe(true)

  expect(balanceSet).toHaveLength(1)
  assert(client.api.events.balances.BalanceSet.is(balanceSet[0].event))
  expect(balanceSet[0].event.data.free.toBigInt()).toBe(targetBalance(client))
  expect(cleared).toHaveLength(1)

  // 5. The inner call took effect
  expect(await getFreeFunds(client, bob.address)).toBe(targetBalance(client))

  // 6. Not listed; preimage and request gone
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(callHash)).isNone).toBe(true)
  expect((await client.api.query.preimage.preimageFor([callHash, callBytes.length])).isNone).toBe(true)
}

/**
 * Root dispatches a whitelisted call by its hash, and a preimage noted by its owner survives.
 *
 * Root is the second origin `DispatchWhitelistedOrigin` admits. The preimage here is noted before
 * the hash is whitelisted, so the account that noted it owns it and pays a deposit. Whitelisting
 * adds the pallet's request on top. When the dispatch gives that request back, the preimage goes
 * back to being unrequested but stays stored, with the owner's deposit still held, so the owner
 * can remove it and get the deposit back.
 *
 * 1. Have a signed account note the preimage, and verify it owns the preimage and paid a deposit
 * 2. Whitelist the call's hash as Root, and verify the preimage is now requested and keeps its
 *    owner
 * 3. Dispatch `dispatch_whitelisted_call` as Root, with the exact length and weight
 * 4. Verify the dispatch succeeded, with one `WhitelistedCallDispatched` event carrying an `Ok`
 *    result, one `BalanceSet` event for the target account and no `preimage.Cleared` event
 * 5. Verify the target account holds exactly the target balance and the hash is no longer listed
 * 6. Verify the preimage is still stored, unrequested, with the same owner and deposit
 */
async function dispatchByHashKeepsOwnedPreimage(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. The owner notes the preimage and pays a deposit
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)

  const noted = (await client.api.query.preimage.requestStatusFor(callHash)).unwrap()
  assert(noted.isUnrequested, `expected an unrequested preimage, got ${noted.type}`)
  expect(noted.asUnrequested.ticket[0].toString()).toBe(addressOf(client, alice))
  const deposit = await getReservedFunds(client, alice.address)
  expect(deposit).toBeGreaterThan(0n)

  // 2. Whitelist: requested, same owner
  await whitelistAsRoot(client, callHash)

  const requested = (await client.api.query.preimage.requestStatusFor(callHash)).unwrap()
  assert(requested.isRequested, `expected a requested preimage, got ${requested.type}`)
  expect(requested.asRequested.count.toNumber()).toBe(1)
  expect(requested.asRequested.maybeTicket.unwrap()[0].toString()).toBe(addressOf(client, alice))
  expect(await getFreeFunds(client, bob.address)).not.toBe(targetBalance(client))

  // 3. `dispatch_whitelisted_call` as Root, exact witnesses
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .method.toHex(),
    { system: 'Root' },
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4. Dispatched, `WhitelistedCallDispatched` with `Ok` and `BalanceSet`; no `preimage.Cleared`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  const whitelistRecords = await whitelistEvents(client)
  const balanceSet = await balanceSetEvents(client, bob)
  await check([...dispatched, ...whitelistRecords, ...balanceSet])
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash as Root: Dispatched, WhitelistedCallDispatched and BalanceSet events')

  expect(dispatched).toHaveLength(1)
  assert(client.api.events.scheduler.Dispatched.is(dispatched[0].event))
  expect(dispatched[0].event.data.result.isOk).toBe(true)

  expect(whitelistRecords).toHaveLength(1)
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(whitelistRecords[0].event))
  expect(whitelistRecords[0].event.data.callHash.toHex()).toBe(callHash)
  expect(whitelistRecords[0].event.data.result.isOk).toBe(true)

  expect(balanceSet).toHaveLength(1)
  assert(client.api.events.balances.BalanceSet.is(balanceSet[0].event))
  expect(balanceSet[0].event.data.free.toBigInt()).toBe(targetBalance(client))

  const events = await client.api.query.system.events()
  expect(events.filter(({ event }) => client.api.events.preimage.Cleared.is(event))).toHaveLength(0)

  // 5. The inner call took effect; not listed
  expect(await getFreeFunds(client, bob.address)).toBe(targetBalance(client))
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 6. Preimage still stored, unrequested, same owner and deposit
  const after = (await client.api.query.preimage.requestStatusFor(callHash)).unwrap()
  assert(after.isUnrequested, `expected an unrequested preimage, got ${after.type}`)
  expect(after.asUnrequested.ticket[0].toString()).toBe(addressOf(client, alice))
  expect(after.asUnrequested.len.toNumber()).toBe(callBytes.length)
  expect((await client.api.query.preimage.preimageFor([callHash, callBytes.length])).isSome).toBe(true)
  expect(await getReservedFunds(client, alice.address)).toBe(deposit)
}

/**
 * Dispatching by hash fails with `UnavailablePreImage` when nobody noted the preimage.
 *
 * The hash is listed, but the pallet has no bytes to decode a call from. The listing stays in
 * place, so the dispatch can be repeated once the preimage is noted.
 *
 * 1. Whitelist the call's hash as Root, without noting the preimage
 * 2. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`
 * 3. Verify the dispatch failed with `UnavailablePreImage` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request
 */
async function dispatchByHashWithoutPreimageFails(client: Client<any, any>) {
  const { bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist; no preimage
  await whitelistAsRoot(client, callHash)
  expect((await client.api.query.preimage.preimageFor([callHash, callBytes.length])).isNone).toBe(true)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `UnavailablePreImage`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash without preimage: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'UnavailablePreImage')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
}

/**
 * Dispatching by hash fails with `UnavailablePreImage` when the length witness is wrong.
 *
 * Preimages are stored under their hash and length, and the pallet looks one up with the length it
 * is given. A noted preimage is therefore not found under any other length.
 *
 * 1. Whitelist the call's hash as Root, then have a signed account note the preimage
 * 2. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`, with a length one byte too long
 * 3. Verify the dispatch failed with `UnavailablePreImage` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request, and the preimage is unchanged
 */
async function dispatchByHashWithWrongLengthFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist, then note the preimage
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `WhitelistedCaller`, length one byte too long
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length + 1, await callWeight(client, call))
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `UnavailablePreImage`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash with wrong length: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'UnavailablePreImage')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request, preimage unchanged
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
  expect(await storedPreimage(client, callHash, callBytes.length)).toBe(u8aToHex(callBytes))
}

/**
 * Dispatching by hash fails with `UndecodableCall` when the preimage has trailing bytes.
 *
 * The pallet decodes the whole preimage as one call. The preimage here is a valid call followed by
 * a second copy of itself: its start decodes, but the bytes left over make the decoding fail. If
 * the pallet ignored them, the listed hash would cover bytes that are never run.
 *
 * 1. Whitelist the hash of the padded bytes as Root, then have a signed account note them
 * 2. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`, with the padded length
 * 3. Verify the dispatch failed with `UndecodableCall` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request, and the preimage is unchanged
 */
async function dispatchByHashOfPaddedPreimageFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const paddedBytes = u8aConcat(call.method.toU8a(), call.method.toU8a())
  const paddedHash = blake2AsHex(paddedBytes, 256)

  // 1. Whitelist the padded bytes' hash, then note them
  await whitelistAsRoot(client, paddedHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, paddedBytes)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `WhitelistedCaller`
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(paddedHash, paddedBytes.length, await callWeight(client, call))
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `UndecodableCall`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash of padded preimage: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'UndecodableCall')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request, preimage unchanged
  expect((await client.api.query.whitelist.whitelistedCall(paddedHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, paddedHash)).toBe(1)
  expect(await storedPreimage(client, paddedHash, paddedBytes.length)).toBe(u8aToHex(paddedBytes))
}

/**
 * Dispatching by hash fails with `InvalidCallWeightWitness` when the witness is below the call's
 * weight.
 *
 * The weight declared for `dispatch_whitelisted_call` is built from the weight witness, so the
 * pallet refuses to run a call that weighs more than the witness says. The witness here is the
 * exact call weight with one unit of reference time taken off, the smallest shortfall there is.
 *
 * 1. Whitelist the call's hash as Root, then have a signed account note the preimage
 * 2. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`, with the call's weight less one
 *    unit of reference time
 * 3. Verify the dispatch failed with `InvalidCallWeightWitness` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request, and the preimage is unchanged
 */
async function dispatchByHashWithLowWeightWitnessFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist, then note the preimage
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `WhitelistedCaller`, one unit of reference time short
  const weight = await callWeight(client, call)
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, {
        refTime: weight.refTime.toBigInt() - 1n,
        proofSize: weight.proofSize.toBigInt(),
      })
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `InvalidCallWeightWitness`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash with low weight witness: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'InvalidCallWeightWitness')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request, preimage unchanged
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
  expect(await storedPreimage(client, callHash, callBytes.length)).toBe(u8aToHex(callBytes))
}

/**
 * Dispatching by hash fails with `CallIsNotWhitelisted` when the hash is not listed.
 *
 * The preimage is noted and both witnesses are exact, so the listing is the only thing missing.
 * Anyone can note a preimage, and that alone must not make a call dispatchable.
 *
 * Skipped on a runtime with deferred dispatch, where this dispatch is deferred instead.
 *
 * 1. Have a signed account note the preimage, verify the hash is not listed, and record the
 *    preimage's request status
 * 2. Dispatch `dispatch_whitelisted_call` as `WhitelistedCaller`, with the exact length and weight
 * 3. Verify the dispatch failed with `CallIsNotWhitelisted` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged and the hash is still not listed
 * 5. Verify the preimage and its request status are unchanged
 */
async function dispatchUnlistedCallByHashFails(client: Client<any, any>, ctx: TestContext | undefined) {
  skipOnDeferredDispatch(client, ctx)

  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Noted preimage owned by its noter, hash not listed
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)
  const statusBefore = await client.api.query.preimage.requestStatusFor(callHash)
  assert(statusBefore.unwrap().isUnrequested, `expected an unrequested preimage, got ${statusBefore.unwrap().type}`)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `WhitelistedCaller`, exact witnesses
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .method.toHex(),
    WHITELISTED_CALLER_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `CallIsNotWhitelisted`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch unlisted call by hash: Dispatched event')
  expectDispatchedError(client, dispatched[0], 'CallIsNotWhitelisted')
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run; still not listed
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isNone).toBe(true)

  // 5. Preimage and request status unchanged
  expect(await storedPreimage(client, callHash, callBytes.length)).toBe(u8aToHex(callBytes))
  expect((await client.api.query.preimage.requestStatusFor(callHash)).toHex()).toBe(statusBefore.toHex())
}

/**
 * A signed account cannot dispatch a whitelisted call by hash.
 *
 * The hash is listed, the preimage is noted and both witnesses are exact, so the origin is the
 * only thing wrong. `DispatchWhitelistedOrigin` admits only Root and `WhitelistedCaller`, so an
 * ordinary account is rejected with `BadOrigin`, and the listing and the preimage stay in place.
 *
 * Skipped on a runtime with deferred dispatch, where a signed dispatch fails with another error.
 *
 * 1. Whitelist the call's hash as Root, then have a signed account note the preimage
 * 2. Send `dispatch_whitelisted_call` from the signer, with the exact length and weight
 * 3. Verify the extrinsic failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request, and the preimage is unchanged
 */
async function signedDispatchByHashFails(client: Client<any, any>, ctx: TestContext | undefined) {
  skipOnDeferredDispatch(client, ctx)

  const { alice, bob } = testAccounts
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist, then note the preimage
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` from a signed account, exact witnesses
  const tx = await sendTransaction(
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .signAsync(alice),
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  await checkEvents(tx, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed dispatch by hash: ExtrinsicFailed event',
  )
  await expectExtrinsicBadOrigin(client, tx)
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request, preimage unchanged
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
  expect(await storedPreimage(client, callHash, callBytes.length)).toBe(u8aToHex(callBytes))
}

/**
 * A governance origin other than `WhitelistedCaller` cannot dispatch a whitelisted call by hash.
 *
 * The hash is listed, the preimage is noted and both witnesses are exact, so the origin is the
 * only thing wrong. `StakingAdmin` is a real referendum origin on the same runtime, but
 * `DispatchWhitelistedOrigin` admits only Root and `WhitelistedCaller`.
 *
 * 1. Whitelist the call's hash as Root, then have a signed account note the preimage
 * 2. Dispatch `dispatch_whitelisted_call` as `StakingAdmin`, with the exact length and weight
 * 3. Verify the dispatch failed with `BadOrigin` and emitted no whitelist event
 * 4. Verify the target account's balance is unchanged
 * 5. Verify the hash is still listed with its preimage request, and the preimage is unchanged
 */
async function stakingAdminDispatchByHashFails(client: Client<any, any>) {
  const { alice, bob } = testAccounts
  const { schedulerBlockProvider } = client.config.properties
  const call = targetCall(client)
  const callBytes = call.method.toU8a()
  const callHash = call.method.hash.toHex()

  // 1. Whitelist, then note the preimage
  await whitelistAsRoot(client, callHash)
  await fundAccounts(client, alice)
  await notePreimage(client, alice, callBytes)
  const balanceBefore = await getFreeFunds(client, bob.address)
  expect(balanceBefore).not.toBe(targetBalance(client))

  // 2. `dispatch_whitelisted_call` as `StakingAdmin`, exact witnesses
  const agendaBlock = await nextSchedulableBlockNum(client.api, schedulerBlockProvider)
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.whitelist
      .dispatchWhitelistedCall(callHash, callBytes.length, await callWeight(client, call))
      .method.toHex(),
    STAKING_ADMIN_ORIGIN,
    schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. `BadOrigin`
  const dispatched = await dispatchedFromAgenda(client, agendaBlock)
  expect(dispatched).toHaveLength(1)
  await check(dispatched)
    .filterEvents()
    .redact({ hash: false, redactKeys: /^task$/ })
    .toMatchSnapshot('dispatch by hash as StakingAdmin: Dispatched event')
  expectDispatchedBadOrigin(client, dispatched[0])
  expect(await whitelistEvents(client)).toHaveLength(0)

  // 4. The inner call did not run
  expect(await getFreeFunds(client, bob.address)).toBe(balanceBefore)

  // 5. Still listed, one preimage request, preimage unchanged
  expect((await client.api.query.whitelist.whitelistedCall(callHash)).isSome).toBe(true)
  expect(await preimageRequestCount(client, callHash)).toBe(1)
  expect(await storedPreimage(client, callHash, callBytes.length)).toBe(u8aToHex(callBytes))
}

/// -------
/// Test tree
/// -------

export function whitelistE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      restoreSnapshot = captureSnapshot(client)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
      await client.dev.setHead(blockNumber)
    },
    afterAll: async () => {
      await client.api.disconnect().catch(() => {})
      await client.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'describe',
        label: 'whitelist_call',
        children: [
          {
            kind: 'test',
            label: 'whitelistCall as Root - CallWhitelisted, hash stored, preimage requested',
            testFn: () => rootWhitelistsCall(client),
          },
          {
            kind: 'test',
            label: 'whitelistCall of a listed hash - CallAlreadyWhitelisted',
            testFn: () => whitelistListedCallFails(client),
          },
          {
            kind: 'test',
            label: 'whitelistCall by a signed account - BadOrigin',
            testFn: () => signedWhitelistFails(client),
          },
          {
            kind: 'test',
            label: 'whitelistCall as WhitelistedCaller - BadOrigin',
            testFn: () => whitelistedCallerWhitelistFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'remove_whitelisted_call',
        children: [
          {
            kind: 'test',
            label: 'removeWhitelistedCall as Root - WhitelistedCallRemoved, hash and preimage request cleared',
            testFn: () => rootRemovesWhitelistedCall(client),
          },
          {
            kind: 'test',
            label: 'removeWhitelistedCall of an unlisted hash - CallIsNotWhitelisted',
            testFn: () => removeUnlistedCallFails(client),
          },
          {
            kind: 'test',
            label: 'removeWhitelistedCall by a signed account - BadOrigin',
            testFn: () => signedRemoveFails(client),
          },
          {
            kind: 'test',
            label: 'removeWhitelistedCall as WhitelistedCaller - BadOrigin',
            testFn: () => whitelistedCallerRemoveFails(client),
          },
          {
            kind: 'test',
            label: 'removed hash can be whitelisted again',
            testFn: () => removedCallCanBeWhitelistedAgain(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'dispatch_whitelisted_call_with_preimage',
        children: [
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage as WhitelistedCaller - inner call runs as Root, hash consumed',
            testFn: () => dispatchWithPreimageRunsCallAsRoot(client, WHITELISTED_CALLER_ORIGIN),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage as Root - inner call runs as Root, hash consumed',
            testFn: () => dispatchWithPreimageRunsCallAsRoot(client, { system: 'Root' }),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage of an unlisted hash - CallIsNotWhitelisted',
            testFn: (ctx) => dispatchUnlistedCallWithPreimageFails(client, ctx),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage a second time - CallIsNotWhitelisted',
            testFn: (ctx) => dispatchWithPreimageTwiceFails(client, ctx),
          },
          {
            kind: 'test',
            label:
              'dispatchWhitelistedCallWithPreimage of a failing inner call - error reported in the event, hash consumed',
            testFn: () => dispatchFailingCallConsumesListing(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage by a signed account - BadOrigin',
            testFn: (ctx) => signedDispatchWithPreimageFails(client, ctx),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCallWithPreimage as StakingAdmin - BadOrigin',
            testFn: () => stakingAdminDispatchWithPreimageFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'dispatch_whitelisted_call',
        children: [
          {
            kind: 'test',
            label:
              'dispatchWhitelistedCall as WhitelistedCaller - noted preimage dispatched with exact witnesses, preimage cleared',
            testFn: () => dispatchByHashRunsNotedCall(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall as Root - preimage noted by its owner survives the dispatch',
            testFn: () => dispatchByHashKeepsOwnedPreimage(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall without a noted preimage - UnavailablePreImage',
            testFn: () => dispatchByHashWithoutPreimageFails(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall with a wrong length witness - UnavailablePreImage',
            testFn: () => dispatchByHashWithWrongLengthFails(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall of a preimage with trailing bytes - UndecodableCall',
            testFn: () => dispatchByHashOfPaddedPreimageFails(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall with a weight witness below the call weight - InvalidCallWeightWitness',
            testFn: () => dispatchByHashWithLowWeightWitnessFails(client),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall of an unlisted hash - CallIsNotWhitelisted',
            testFn: (ctx) => dispatchUnlistedCallByHashFails(client, ctx),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall by a signed account - BadOrigin',
            testFn: (ctx) => signedDispatchByHashFails(client, ctx),
          },
          {
            kind: 'test',
            label: 'dispatchWhitelistedCall as StakingAdmin - BadOrigin',
            testFn: () => stakingAdminDispatchByHashFails(client),
          },
        ],
      },
    ],
  }
}
