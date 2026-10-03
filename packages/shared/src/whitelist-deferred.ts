import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupBalances, type TestNode } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Event, EventRecord } from '@polkadot/types/interfaces'

import { assert, expect } from 'vitest'

import { scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

// ── Helpers ──

const TEST_BALANCE = 10n ** 18n

function fundedAccounts(addresses: string[]) {
  return addresses.map((address) => ({ address, amount: TEST_BALANCE }))
}

function buildCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, remark: string) {
  const call = client.api.tx.system.remark(remark)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

function buildForceTransferCall<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, from: string, to: string, value: bigint) {
  const call = client.api.tx.balances.forceTransfer(from, to, value)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

// True once the runtime carries polkadot-sdk#11336, where deferred dispatch is
// unconditional. Until a release ships it, use a `<NETWORK>_WASM` override.
function runtimeHasDeferredDispatch<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): boolean {
  return !!(client.api.query.whitelist as any)?.deferredDispatch
}

async function getDeferredDispatch<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, callHash: string): Promise<any> {
  return (client.api.query.whitelist as any).deferredDispatch(callHash)
}

async function isWhitelisted<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, callHash: string): Promise<boolean> {
  const maybe = await client.api.query.whitelist.whitelistedCall(callHash)
  return maybe.isSome
}

// The deferred-dispatch events are absent from the generated metadata types until
// the feature ships, so the cast lives here rather than at each call site.
function findWhitelistEvent(events: EventRecord[], method: string, callHash: string): Event | undefined {
  for (const { event } of events) {
    if (event.section === 'whitelist' && event.method === method) {
      if ((event.data as any).callHash?.toHex() === callHash) {
        return event
      }
    }
  }
  return undefined
}

async function notePreimage<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, encodedCall: string) {
  const tx = client.api.tx.preimage.notePreimage(encodedCall)
  await dispatchWithRoot(client, tx)
  await client.dev.newBlock()
}

async function dispatchWithRoot<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, tx: SubmittableExtrinsic<'promise'>) {
  await scheduleInlineCallWithOrigin(
    client,
    tx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
}

// Expiry block 1; not 0, which setStorage treats as a deletion (falsy).
async function forceExpireDeferred<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, callHash: string) {
  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch must exist before forcing expiry')
  await client.dev.setStorage({
    Whitelist: {
      DeferredDispatch: [[[callHash], 1]],
    },
  })
}

// Root calls go through the scheduler, which reports failure as `scheduler.Dispatched`
// carrying an `Err` result. They never emit `system.ExtrinsicFailed`.
async function expectScheduledWhitelistError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, expectedError: string) {
  const events = await client.api.query.system.events()
  const dispatched = events.find(({ event }) => event.section === 'scheduler' && event.method === 'Dispatched')
  assert(dispatched, 'scheduler.Dispatched should be emitted for a Root-dispatched call')
  assert(client.api.events.scheduler.Dispatched.is(dispatched.event))

  const result = dispatched.event.data.result
  assert(result.isErr, 'Scheduled call should have failed')
  const err = result.asErr
  assert(err.isModule, 'Expected a module error')

  const meta = client.api.registry.findMetaError(err.asModule)
  expect({ section: meta.section, name: meta.name }).toEqual({ section: 'whitelist', name: expectedError })
}

// Signed calls report failure as `system.ExtrinsicFailed`.
async function expectExtrinsicWhitelistError<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, expectedError: string) {
  const events = await client.api.query.system.events()
  const failed = events.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed')
  assert(failed, 'system.ExtrinsicFailed should be emitted for a signed call')
  assert(client.api.events.system.ExtrinsicFailed.is(failed.event))

  const err = failed.event.data.dispatchError
  assert(err.isModule, 'Expected a module error')

  const meta = client.api.registry.findMetaError(err.asModule)
  expect({ section: meta.section, name: meta.name }).toEqual({ section: 'whitelist', name: expectedError })
}

// BadOrigin is a top-level DispatchError, not a module error.
async function expectBadOrigin<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const events = await client.api.query.system.events()
  const failed = events.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed')
  assert(failed, 'system.ExtrinsicFailed should be emitted for a signed call')
  assert(client.api.events.system.ExtrinsicFailed.is(failed.event))
  expect(failed.event.data.dispatchError.isBadOrigin).toBe(true)
}

// ── Test Cases ──

async function deferredDispatchHappyPathTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, callHash } = buildCall(client, 'deferred dispatch happy path')

  // 1. Root dispatches before whitelist → DEFERS
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const eventsAfterDeferral = await client.api.query.system.events()
  const deferredEvent = findWhitelistEvent(eventsAfterDeferral, 'DispatchDeferred', callHash)
  expect(deferredEvent).toBeDefined()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch should be created')

  // 2. Whitelist the call so execution can proceed
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  // 3. Signed origin executes the deferred call
  const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
  await sendTransaction(executeTx.signAsync(bob))
  await client.dev.newBlock()

  const eventsAfterExecution = await client.api.query.system.events()
  const dispatchedEvent = findWhitelistEvent(eventsAfterExecution, 'WhitelistedCallDispatched', callHash)
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(dispatchedEvent))
  expect(dispatchedEvent.data.result.isOk).toBe(true)

  const executedEvent = findWhitelistEvent(eventsAfterExecution, 'DeferredDispatchExecuted', callHash)
  expect(executedEvent).toBeDefined()

  const afterExec = await getDeferredDispatch(client, callHash)
  expect(afterExec.isNone).toBe(true)
}

async function directDispatchWithPreimageTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, callHash } = buildCall(client, 'direct dispatch test')

  // Whitelist first (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Root dispatch → DIRECT (no deferral because already whitelisted)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const deferredEvent = findWhitelistEvent(events, 'DispatchDeferred', callHash)
  expect(deferredEvent).toBeUndefined()

  const dispatchedEvent = findWhitelistEvent(events, 'WhitelistedCallDispatched', callHash)
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(dispatchedEvent))
  expect(dispatchedEvent.data.result.isOk).toBe(true)

  const deferredOpt = await getDeferredDispatch(client, callHash)
  expect(deferredOpt.isNone).toBe(true)
}

async function deferredDispatchRootSemanticsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  await setupBalances(client, fundedAccounts([alice.address, bob.address, charlie.address]))

  const { call, callHash } = buildForceTransferCall(client, alice.address, bob.address, 1000n)

  // Root dispatches before whitelist → DEFERS
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Should be deferred')

  // Whitelist so execution can proceed
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  // Signed origin executes → runs as Root
  const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
  await sendTransaction(executeTx.signAsync(charlie))
  await client.dev.newBlock()

  const allEvents = await client.api.query.system.events()
  const dispatchedEvent = findWhitelistEvent(allEvents, 'WhitelistedCallDispatched', callHash)
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  assert(client.api.events.whitelist.WhitelistedCallDispatched.is(dispatchedEvent))
  expect(dispatchedEvent.data.result.isOk).toBe(true)

  // Prove direct signed call fails
  const directCall = client.api.tx.balances.forceTransfer(alice.address, bob.address, 1000n)
  await sendTransaction(directCall.signAsync(alice))
  await client.dev.newBlock()

  await expectBadOrigin(client)
}

async function deferredDispatchHashOnlyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, encodedCall, callHash } = buildCall(client, 'hash-only dispatch test')
  const callLen = call.method.toU8a().length
  const callWeight = await call.paymentInfo(alice.address)

  // 1. Hash-only dispatch before whitelist → DEFERS (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight))
  await client.dev.newBlock()

  const eventsAfterDeferral = await client.api.query.system.events()
  const deferredEvent = findWhitelistEvent(eventsAfterDeferral, 'DispatchDeferred', callHash)
  expect(deferredEvent).toBeDefined()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch should be created')

  // 2. Whitelist
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  // 3. Note preimage via Root origin
  await notePreimage(client, encodedCall)

  // 4. Signed executes hash-only variant
  const executeTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight)
  await sendTransaction(executeTx.signAsync(bob))
  await client.dev.newBlock()

  const eventsAfterExecution = await client.api.query.system.events()
  const executedEvent = findWhitelistEvent(eventsAfterExecution, 'DeferredDispatchExecuted', callHash)
  expect(executedEvent).toBeDefined()

  const afterExec = await getDeferredDispatch(client, callHash)
  expect(afterExec.isNone).toBe(true)
}

async function alreadyDeferredTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, callHash } = buildCall(client, 'already deferred test')

  // First deferral (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'First deferral should succeed')

  // Second deferral should fail
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  await expectScheduledWhitelistError(client, 'AlreadyDeferred')
}

async function invalidCallWeightWitnessTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  await setupBalances(client, fundedAccounts([alice.address]))

  const { call, callHash } = buildCall(client, 'invalid weight witness test')
  const callLen = call.method.toU8a().length
  const callWeight = await call.paymentInfo(alice.address)

  // Create a deferred entry first so we hit the execution path
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight))
  await client.dev.newBlock()

  // Whitelist + preimage so execution is possible
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  await notePreimage(client, call.method.toHex())

  // Execute with intentionally wrong weight (small enough for tx pool, wrong for runtime)
  const wrongWeight = { refTime: 1000, proofSize: 1000 }
  const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, wrongWeight as any)
  await sendTransaction(dispatchTx.signAsync(alice))
  await client.dev.newBlock()

  await expectExtrinsicWhitelistError(client, 'InvalidCallWeightWitness')

  // Failed execution should NOT remove the deferred entry — only success does
  const stillDeferred = await getDeferredDispatch(client, callHash)
  expect(stillDeferred.isSome).toBe(true)
}

async function whitelistOriginGatingTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, callHash } = buildCall(client, 'origin gating test')

  // Bob tries to whitelist → BadOrigin
  const unauthorizedWhitelist = client.api.tx.whitelist.whitelistCall(callHash)
  await sendTransaction(unauthorizedWhitelist.signAsync(bob))
  await client.dev.newBlock()

  await expectBadOrigin(client)

  // Bob tries to dispatch → fails
  const unauthorizedDispatch = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
  await sendTransaction(unauthorizedDispatch.signAsync(bob))
  await client.dev.newBlock()

  await expectExtrinsicWhitelistError(client, 'DeferredDispatchNotFound')
}

async function callAlreadyWhitelistedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  await setupBalances(client, fundedAccounts([alice.address]))

  const { callHash } = buildCall(client, 'double whitelist test')

  // Whitelist (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Attempt to whitelist again (Root) → fails with CallAlreadyWhitelisted
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  await expectScheduledWhitelistError(client, 'CallAlreadyWhitelisted')
}

async function removeWhitelistedCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { callHash } = buildCall(client, 'remove whitelisted call test')

  // Whitelist (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Bob (non-Root) tries to remove, fails with BadOrigin
  const unauthorizedRemove = client.api.tx.whitelist.removeWhitelistedCall(callHash)
  await sendTransaction(unauthorizedRemove.signAsync(bob))
  await client.dev.newBlock()

  await expectBadOrigin(client)

  // Root removes
  await dispatchWithRoot(client, client.api.tx.whitelist.removeWhitelistedCall(callHash))
  await client.dev.newBlock()

  expect(await isWhitelisted(client, callHash)).toBe(false)

  // Try to remove again (Root) → fails with CallIsNotWhitelisted
  await dispatchWithRoot(client, client.api.tx.whitelist.removeWhitelistedCall(callHash))
  await client.dev.newBlock()

  await expectScheduledWhitelistError(client, 'CallIsNotWhitelisted')
}

async function permissionlessRemovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  await setupBalances(client, fundedAccounts([alice.address, bob.address, charlie.address]))

  const { call, callHash } = buildCall(client, 'permissionless removal test')

  // Defer with Root
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome)

  // Force the entry to be expired immediately (relay chain blocks don't advance in Chopsticks para tests)
  await forceExpireDeferred(client, callHash)

  // Charlie (anyone) removes the expired deferred entry
  const removeTx = client.api.tx.whitelist.removeDeferredDispatch(callHash)
  await sendTransaction(removeTx.signAsync(charlie))
  await client.dev.newBlock()

  // Ensure the removal extrinsic succeeded (no ExtrinsicFailed)
  const removalEvents = await client.api.query.system.events()
  const removalFailed = removalEvents.find(
    ({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed',
  )
  expect(removalFailed).toBeUndefined()

  const removedEvent = findWhitelistEvent(removalEvents, 'DeferredDispatchRemoved', callHash)
  expect(removedEvent).toBeDefined()

  const afterRemoval = await getDeferredDispatch(client, callHash)
  expect(afterRemoval.isNone).toBe(true)
}

async function removalBeforeExpiryTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const charlie = testAccounts.charlie
  await setupBalances(client, fundedAccounts([alice.address, charlie.address]))

  const { call, callHash } = buildCall(client, 'removal before expiry test')

  // Defer, leaving the entry inside its delay window.
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch should be created')

  // The pallet requires `now >= expire_at`, so this removal is rejected.
  const removeTx = client.api.tx.whitelist.removeDeferredDispatch(callHash)
  await sendTransaction(removeTx.signAsync(charlie))
  await client.dev.newBlock()

  await expectExtrinsicWhitelistError(client, 'DeferredDispatchNotExpired')

  const stillDeferred = await getDeferredDispatch(client, callHash)
  expect(stillDeferred.isSome).toBe(true)
}

async function unavailablePreimageTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, encodedCall, callHash } = buildCall(client, 'unavailable preimage test')
  const callLen = call.method.toU8a().length
  const callWeight = await call.paymentInfo(alice.address)

  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight))
  await client.dev.newBlock()
  assert((await getDeferredDispatch(client, callHash)).isSome, 'Deferred dispatch should be created')

  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  // Execute with the preimage still unnoted.
  const failingTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight)
  await sendTransaction(failingTx.signAsync(bob))
  await client.dev.newBlock()

  await expectExtrinsicWhitelistError(client, 'UnavailablePreImage')

  expect((await getDeferredDispatch(client, callHash)).isSome).toBe(true)

  // Supply the preimage; the same call now goes through.
  await notePreimage(client, encodedCall)

  const executeTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight)
  await sendTransaction(executeTx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const executedEvent = findWhitelistEvent(events, 'DeferredDispatchExecuted', callHash)
  expect(executedEvent).toBeDefined()
  expect((await getDeferredDispatch(client, callHash)).isNone).toBe(true)
}

async function expiredDeferredDispatchTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await setupBalances(client, fundedAccounts([alice.address, bob.address]))

  const { call, callHash } = buildCall(client, 'expired deferred dispatch test')

  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()
  assert((await getDeferredDispatch(client, callHash)).isSome, 'Deferred dispatch should be created')

  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  // Execution is only allowed while `now < expire_at`.
  await forceExpireDeferred(client, callHash)

  const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
  await sendTransaction(executeTx.signAsync(bob))
  await client.dev.newBlock()

  await expectExtrinsicWhitelistError(client, 'DeferredDispatchExpired')

  // A failed execution leaves the entry in place.
  expect((await getDeferredDispatch(client, callHash)).isSome).toBe(true)
}

// ── Exported Test Tree ──

export function whitelistDeferredE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>
  let hasDeferredDispatch = false

  // Skips instead of failing when the runtime predates polkadot-sdk#11336.
  const testNode = (label: string, testFn: (client: Client<TCustom, TInitStorages>) => Promise<void>): TestNode => ({
    kind: 'test',
    label,
    testFn: async (ctx) => {
      if (!hasDeferredDispatch) {
        ctx?.skip()
        return
      }
      await testFn(client)
    },
  })

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      hasDeferredDispatch = runtimeHasDeferredDispatch(client)
      if (!hasDeferredDispatch) {
        console.warn(
          `[${testConfig.testSuiteName}] runtime lacks whitelist.deferredDispatch; skipping suite. ` +
            'Point the chain wasm override (e.g. ASSETHUBKUSAMA_WASM) at a runtime carrying polkadot-sdk#11336.',
        )
      }
      restoreSnapshot = captureSnapshot(client)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
      await client.dev.setHead(blockNumber)
    },
    // `client` is undefined if `beforeAll` timed out mid-setup.
    afterAll: async () => {
      await client?.api.disconnect().catch(() => {})
      await client?.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'describe',
        label: 'success',
        children: [
          testNode('happy path', deferredDispatchHappyPathTest),
          testNode('direct dispatch', directDispatchWithPreimageTest),
          testNode('root semantics', deferredDispatchRootSemanticsTest),
          testNode('hash-only dispatch', deferredDispatchHashOnlyTest),
          testNode('permissionless removal', permissionlessRemovalTest),
        ],
      },
      {
        kind: 'describe',
        label: 'failure',
        children: [
          testNode('already deferred', alreadyDeferredTest),
          testNode('invalid weight witness', invalidCallWeightWitnessTest),
          testNode('origin gating', whitelistOriginGatingTest),
          testNode('call already whitelisted', callAlreadyWhitelistedTest),
          testNode('remove whitelisted call', removeWhitelistedCallTest),
          testNode('removal before expiry', removalBeforeExpiryTest),
          testNode('unavailable preimage', unavailablePreimageTest),
          testNode('expired deferred dispatch', expiredDeferredDispatchTest),
        ],
      },
    ],
  }
}
