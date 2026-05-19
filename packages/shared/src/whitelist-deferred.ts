import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Event, EventRecord } from '@polkadot/types/interfaces'

import { assert, expect } from 'vitest'

import { checkSystemEvents, getBlockNumber, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

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

async function getDeferredDispatch(client: Client<any, any>, callHash: string): Promise<any> {
  const q = (client.api.query.whitelist as any).deferredDispatch
  if (!q) {
    throw new Error(
      'Runtime missing whitelist.deferredDispatch query. ' +
        'The runtime you are testing does not include the deferred-dispatch feature. ' +
        'Use a runtime that includes it (e.g. a relay chain with the updated whitelist pallet).',
    )
  }
  return q(callHash)
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

async function notePreimage(client: Client<any, any>, _callHash: string, encodedCall: string) {
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

async function advanceBlocks(client: Client<any, any>, count: number) {
  await client.dev.newBlock({ blocks: count })
}

async function forceExpireDeferred(client: Client<any, any>, callHash: string) {
  const deferredOpt = await getDeferredDispatch(client, callHash)
  assert(deferredOpt.isSome, 'Deferred dispatch must exist before forcing expiry')
  const entry = deferredOpt.unwrap().toJSON()
  entry.expireAt = 0
  await client.dev.setStorage({
    Whitelist: {
      DeferredDispatch: [[[callHash], entry]],
    },
  })
}

async function assertRuntimeHasDeferred(client: Client<any, any>) {
  const hasDeferred = !!(client.api.query.whitelist as any).deferredDispatch
  if (!hasDeferred) {
    const available = Object.keys(client.api.query.whitelist || {})
    throw new Error(
      `Runtime at block ${await client.api.query.system.number()} is missing deferredDispatch. ` +
        `Available whitelist queries: [${available.join(', ')}]. ` +
        `Did you set ASSETHUBKUSAMA_WASM to the newly built wasm?`,
    )
  }
}

// ── Test Cases ──

async function deferredDispatchHappyPathTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
    expect(dispatchedEvent).toBeDefined()
    expect(dispatchedEvent.data.result.asOk).toBeDefined()

    const executedEvent = findEvent(
      eventsAfterExecution,
      'whitelist',
      'DeferredDispatchExecuted',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(executedEvent).toBeDefined()

    const afterExec = await getDeferredDispatch(client, callHash)
    expect(afterExec.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

async function directDispatchWithPreimageTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
    const deferredEvent = findEvent(
      events,
      'whitelist',
      'DispatchDeferred',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(deferredEvent).toBeUndefined()

    const hasDispatchedEvent = findEvent(
      events,
      'whitelist',
      'WhitelistedCallDispatched',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(hasDispatchedEvent).toBeDefined()
    expect(hasDispatchedEvent.data.result.asOk).toBeDefined()

    const deferredOpt = await getDeferredDispatch(client, callHash)
    expect(deferredOpt.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

async function deferredDispatchRootSemanticsTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
    expect(dispatchedEvent).toBeDefined()
    expect(dispatchedEvent.data.result.asOk).toBeDefined()

    // Prove direct signed call fails
    const directCall = client.api.tx.balances.forceTransfer(alice.address, bob.address, 1000n)
    await sendTransaction(directCall.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'signed origin rejected for root-only call',
    )
  } finally {
    await client.teardown()
  }
}

async function deferredDispatchHashOnlyTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

    const alice = testAccounts.alice
    const bob = testAccounts.bob
    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, encodedCall, callHash } = buildCall(client, 'hash-only dispatch test')
    const callLen = call.method.toU8a().length
    const callWeight = await call.paymentInfo(alice.address)

    // 1. Hash-only dispatch before whitelist → DEFERS (Root)
    await dispatchWithRoot(
      client,
      client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight),
    )
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
    await notePreimage(client, callHash, encodedCall)

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
  } finally {
    await client.teardown()
  }
}

async function alreadyDeferredTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
  } finally {
    await client.teardown()
  }
}

async function invalidCallWeightWitnessTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

    const alice = testAccounts.alice
    await fundAccounts(client, [alice.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'invalid weight witness test')
    const callLen = call.method.toU8a().length
    const callWeight = await call.paymentInfo(alice.address)

    // Create a deferred entry first so we hit the execution path
    await dispatchWithRoot(
      client,
      client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight),
    )
    await client.dev.newBlock()

    // Whitelist + preimage so execution is possible
    await dispatchWithRoot(client, client.api.tx.whitelist.whitelistCall(callHash))
    await client.dev.newBlock()
    await notePreimage(client, callHash, call.method.toHex())

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
  } finally {
    await client.teardown()
  }
}

async function whitelistOriginGatingTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
  } finally {
    await client.teardown()
  }
}

async function callAlreadyWhitelistedTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
  } finally {
    await client.teardown()
  }
}

async function removeWhitelistedCallTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
  } finally {
    await client.teardown()
  }
}

async function permissionlessRemovalTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)
  try {
    await assertRuntimeHasDeferred(client)

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
    expect(removalFailed).toBeUndefined()

    const removedEvent = findEvent(
      removalEvents,
      'whitelist',
      'DeferredDispatchRemoved',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(removedEvent).toBeDefined()

    const afterRemoval = await getDeferredDispatch(client, callHash)
    expect(afterRemoval.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

// ── Exported Test Trees (data only) ──

export function whitelistDeferredSuccessTests<T extends Chain>(chain: Chain<T>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Whitelist Deferred Dispatch — Success Path',
    children: [
      { kind: 'test' as const, label: 'happy path', testFn: () => deferredDispatchHappyPathTest(chain) },
      { kind: 'test' as const, label: 'direct dispatch', testFn: () => directDispatchWithPreimageTest(chain) },
      { kind: 'test' as const, label: 'root semantics', testFn: () => deferredDispatchRootSemanticsTest(chain) },
      { kind: 'test' as const, label: 'hash-only dispatch', testFn: () => deferredDispatchHashOnlyTest(chain) },
      { kind: 'test' as const, label: 'permissionless removal', testFn: () => permissionlessRemovalTest(chain) },
    ],
  }
}

export function whitelistDeferredFailureTests<T extends Chain>(chain: Chain<T>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Whitelist Deferred Dispatch — Failure Path',
    children: [
      { kind: 'test' as const, label: 'already deferred', testFn: () => alreadyDeferredTest(chain) },
      { kind: 'test' as const, label: 'invalid weight witness', testFn: () => invalidCallWeightWitnessTest(chain) },
      { kind: 'test' as const, label: 'origin gating', testFn: () => whitelistOriginGatingTest(chain) },
      { kind: 'test' as const, label: 'call already whitelisted', testFn: () => callAlreadyWhitelistedTest(chain) },
      { kind: 'test' as const, label: 'remove whitelisted call', testFn: () => removeWhitelistedCallTest(chain) },
    ],
  }
}

export function whitelistDeferredE2ETests<T extends Chain>(chain: Chain<T>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      { kind: 'describe', label: 'success', children: whitelistDeferredSuccessTests(chain).children },
      { kind: 'describe', label: 'failure', children: whitelistDeferredFailureTests(chain).children },
    ],
  }
}
