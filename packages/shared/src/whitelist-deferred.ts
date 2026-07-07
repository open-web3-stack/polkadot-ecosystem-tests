import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree, TestNode } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Event, EventRecord } from '@polkadot/types/interfaces'

import { assert, expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

// ── Helpers ──

function buildCall(client: Client<any, any>, remark: string) {
  const call = client.api.tx.system.remark(remark)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

function buildForceTransferCall(client: Client<any, any>, from: string, to: string, value: bigint) {
  const call = client.api.tx.balances.forceTransfer(from, to, value)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

// Not in released runtimes yet; needs a `<NETWORK>_WASM` override wasm built with the feature.
function runtimeHasDeferredDispatch(client: Client<any, any>): boolean {
  return !!(client.api.query.whitelist as any)?.deferredDispatch
}

async function getDeferredDispatch(client: Client<any, any>, callHash: string): Promise<any> {
  return (client.api.query.whitelist as any).deferredDispatch(callHash)
}

async function isWhitelisted(client: Client<any, any>, callHash: string): Promise<boolean> {
  const maybe = await client.api.query.whitelist.whitelistedCall(callHash)
  return maybe.isSome
}

async function fundAccounts(client: Client<any, any>, addresses: string[], amount: bigint) {
  const accountData = addresses.map((addr) => [
    [addr],
    {
      nonce: 0,
      consumers: 0,
      providers: 1,
      sufficients: 0,
      data: {
        free: amount,
        reserved: 0,
        miscFrozen: 0,
        feeFrozen: 0,
      },
    },
  ])
  await client.dev.setStorage({
    System: { Account: accountData },
  })
}

function findEvent(
  events: EventRecord[],
  section: string,
  method: string,
  matchFn?: (data: any) => boolean,
): Event | undefined {
  for (const { event } of events) {
    if (event.section === section && event.method === method && (!matchFn || matchFn(event.data))) {
      return event
    }
  }
  return undefined
}

async function notePreimage(client: Client<any, any>, encodedCall: string) {
  const tx = client.api.tx.preimage.notePreimage(encodedCall)
  await dispatchWithRoot(client, tx)
  await client.dev.newBlock()
}

async function dispatchWithRoot(client: Client<any, any>, tx: SubmittableExtrinsic<'promise'>) {
  await scheduleInlineCallWithOrigin(
    client,
    tx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
}

// Expiry block 1; not 0, which setStorage treats as a deletion (falsy).
async function forceExpireDeferred(client: Client<any, any>, callHash: string) {
  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch must exist before forcing expiry')
  await client.dev.setStorage({
    Whitelist: {
      DeferredDispatch: [[[callHash], 1]],
    },
  })
}

// ── Test Cases ──

async function deferredDispatchHappyPathTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { call, callHash } = buildCall(client, 'deferred dispatch happy path')

  // 1. Root dispatches before whitelist → DEFERS
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const eventsAfterDeferral = await client.api.query.system.events()
  const deferredEvent = findEvent(
    eventsAfterDeferral,
    'whitelist',
    'DispatchDeferred',
    (d: any) => d.callHash.toHex() === callHash,
  )
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
  const dispatchedEvent = findEvent(
    eventsAfterExecution,
    'whitelist',
    'WhitelistedCallDispatched',
    (d: any) => d.callHash.toHex() === callHash,
  )
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  expect((dispatchedEvent.data as any).result.isOk).toBe(true)

  const executedEvent = findEvent(
    eventsAfterExecution,
    'whitelist',
    'DeferredDispatchExecuted',
    (d: any) => d.callHash.toHex() === callHash,
  )
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
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { call, callHash } = buildCall(client, 'direct dispatch test')

  // Whitelist first (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Root dispatch → DIRECT (no deferral because already whitelisted)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const deferredEvent = findEvent(events, 'whitelist', 'DispatchDeferred', (d: any) => d.callHash.toHex() === callHash)
  expect(deferredEvent).toBeUndefined()

  const dispatchedEvent = findEvent(
    events,
    'whitelist',
    'WhitelistedCallDispatched',
    (d: any) => d.callHash.toHex() === callHash,
  )
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  expect((dispatchedEvent.data as any).result.isOk).toBe(true)

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
  await fundAccounts(client, [alice.address, bob.address, charlie.address], 10n ** 18n)

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
  const dispatchedEvent = findEvent(
    allEvents,
    'whitelist',
    'WhitelistedCallDispatched',
    (d: any) => d.callHash.toHex() === callHash,
  )
  assert(dispatchedEvent, 'WhitelistedCallDispatched event should be emitted')
  expect((dispatchedEvent.data as any).result.isOk).toBe(true)

  // Prove direct signed call fails
  const directCall = client.api.tx.balances.forceTransfer(alice.address, bob.address, 1000n)
  await sendTransaction(directCall.signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'signed origin rejected for root-only call',
  )
}

async function deferredDispatchHashOnlyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { call, encodedCall, callHash } = buildCall(client, 'hash-only dispatch test')
  const callLen = call.method.toU8a().length
  const callWeight = await call.paymentInfo(alice.address)

  // 1. Hash-only dispatch before whitelist → DEFERS (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight))
  await client.dev.newBlock()

  const eventsAfterDeferral = await client.api.query.system.events()
  const deferredEvent = findEvent(
    eventsAfterDeferral,
    'whitelist',
    'DispatchDeferred',
    (d: any) => d.callHash.toHex() === callHash,
  )
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
  const executedEvent = findEvent(
    eventsAfterExecution,
    'whitelist',
    'DeferredDispatchExecuted',
    (d: any) => d.callHash.toHex() === callHash,
  )
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
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { call, callHash } = buildCall(client, 'already deferred test')

  // First deferral (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'First deferral should succeed')

  // Second deferral should fail
  await dispatchWithRoot(client, client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex()))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'already deferred error',
  )
}

async function invalidCallWeightWitnessTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  await fundAccounts(client, [alice.address], 10n ** 18n)

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

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'invalid call weight witness',
  )

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
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { call, callHash } = buildCall(client, 'origin gating test')

  // Bob tries to whitelist → BadOrigin
  const unauthorizedWhitelist = client.api.tx.whitelist.whitelistCall(callHash)
  await sendTransaction(unauthorizedWhitelist.signAsync(bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'unauthorized whitelist rejected',
  )

  // Bob tries to dispatch → fails
  const unauthorizedDispatch = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
  await sendTransaction(unauthorizedDispatch.signAsync(bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'unauthorized dispatch rejected',
  )
}

async function callAlreadyWhitelistedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  await fundAccounts(client, [alice.address], 10n ** 18n)

  const { callHash } = buildCall(client, 'double whitelist test')

  // Whitelist (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Attempt to whitelist again (Root) → fails with CallAlreadyWhitelisted
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'call already whitelisted',
  )
}

async function removeWhitelistedCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

  const { callHash } = buildCall(client, 'remove whitelisted call test')

  // Whitelist (Root)
  await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
  await client.dev.newBlock()
  assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

  // Bob (non-Root) tries to remove, fails with BadOrigin
  const unauthorizedRemove = client.api.tx.whitelist.removeWhitelistedCall(callHash)
  await sendTransaction(unauthorizedRemove.signAsync(bob))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'unauthorized remove rejected',
  )

  // Root removes
  await dispatchWithRoot(client, client.api.tx.whitelist.removeWhitelistedCall(callHash))
  await client.dev.newBlock()

  expect(await isWhitelisted(client, callHash)).toBe(false)

  // Try to remove again (Root) → fails with CallIsNotWhitelisted
  await dispatchWithRoot(client, client.api.tx.whitelist.removeWhitelistedCall(callHash))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'remove non-whitelisted call fails',
  )
}

async function permissionlessRemovalTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  await fundAccounts(client, [alice.address, bob.address, charlie.address], 10n ** 18n)

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
  const removalFailed = findEvent(removalEvents as any, 'system', 'ExtrinsicFailed')
  expect(removalFailed?.toHuman()).toBeUndefined()

  const removedEvent = findEvent(
    removalEvents,
    'whitelist',
    'DeferredDispatchRemoved',
    (d: any) => d.callHash.toHex() === callHash,
  )
  expect(removedEvent).toBeDefined()

  const afterRemoval = await getDeferredDispatch(client, callHash)
  expect(afterRemoval.isNone).toBe(true)
}

// ── Exported Test Tree ──

export function whitelistDeferredE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>
  let hasDeferredDispatch = false

  // Skips instead of failing when the runtime predates the deferred-dispatch feature.
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
            'Set the chain wasm override (e.g. ASSETHUBKUSAMA_WASM) to a runtime built with the deferred-dispatch feature.',
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
        ],
      },
    ],
  }
}
