import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { checkSystemEvents, getBlockNumber, type TestConfig } from './helpers/index.js'

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a remark call and extract all metadata needed for tests
 */
function buildCall(client: Client<any, any>, remark: string) {
  const call = client.api.tx.system.remark(remark)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

/**
 * Build a forceTransfer call (Root-only dispatchable)
 */
function buildForceTransferCall(client: Client<any, any>, from: string, to: string, value: bigint) {
  const call = client.api.tx.balances.forceTransfer(from, to, value)
  const encodedCall = call.method.toHex()
  const callHash = client.api.registry.hash(call.method.toU8a()).toHex()
  return { call, encodedCall, callHash }
}

/**
 * Query the deferred dispatch storage entry
 */
async function getDeferredDispatch(client: Client<any, any>, callHash: string): Promise<any> {
  return client.api.query.whitelist.deferredDispatch(callHash)
}

/**
 * Check if a call hash is whitelisted
 */
async function isWhitelisted(client: Client<any, any>, callHash: string): Promise<boolean> {
  const maybe = await client.api.query.whitelist.whitelistedCall(callHash)
  return maybe.isSome
}

/**
 * Fund multiple accounts for testing
 */
async function fundAccounts(client: Client<any, any>, addresses: string[], amount: bigint) {
  for (const addr of addresses) {
    await client.dev.setStorage({
      System: { Account: [[[addr], { data: { free: amount } }]] },
    })
  }
}

/**
 * Find a specific event in a list of events
 */
function findEvent(events: any[], section: string, method: string, matchFn?: (data: any) => boolean): any | undefined {
  for (const { event } of events) {
    if (event.section === section && event.method === method && (!matchFn || matchFn(event.data))) {
      return event
    }
  }
  return undefined
}

/**
 * Note a preimage via storage injection
 */
async function notePreimage(client: Client<any, any>, callHash: string, encodedCall: string) {
  // Strip 0x prefix if present for consistent byte conversion
  const hexBody = encodedCall.startsWith('0x') ? encodedCall.slice(2) : encodedCall
  const callU8a = new Uint8Array(hexBody.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)))
  await client.dev.setStorage({
    Preimage: {
      // PreimageFor uses [hash, length] as the composite key per FRAME Preimage pallet
      PreimageFor: [[[callHash, callU8a.length], callU8a]],
      StatusFor: [[[callHash], { Requested: { count: 1, len: callU8a.length } }]],
    },
  })
}

// ─────────────────────────────────────────────────────────────
// Success Tests
// ─────────────────────────────────────────────────────────────

/**
 * Deferred dispatch executes with any origin.
 *
 * Pallet flow:
 *   1. dispatchWhitelistedCallWithPreimage (Root) → DEFERS (note/request)
 *   2. dispatchWhitelistedCallWithPreimage (Signed) → EXECUTES (deferred)
 *   The signed origin must execute BEFORE the deferred dispatch expires:
 *      ensure!(current_block < expire_at, Error::DeferredDispatchExpired)
 */
async function deferredDispatchHappyPathTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, encodedCall: _encodedCall, callHash } = buildCall(client, 'deferred dispatch happy path')

    // Dispatch with Root BEFORE whitelist → DEFERS (call not whitelisted yet)
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify DispatchDeferred event
    const events1 = await client.api.query.system.events()
    const deferredEvent = findEvent(
      events1 as any,
      'whitelist',
      'DispatchDeferred',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(deferredEvent).toBeDefined()

    // Verify DeferredDispatch storage
    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome, 'Deferred dispatch should be created')

    // Trigger deferred dispatch execution path with signed origin (Bob)
    const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(executeTx.signAsync(bob))
    await client.dev.newBlock()

    // Verify DeferredDispatchExecuted event
    const events2 = await client.api.query.system.events()
    const executedEvent = findEvent(
      events2 as any,
      'whitelist',
      'DeferredDispatchExecuted',
      (d: any) => d.callHash.toHex() === callHash && d.who.toString() === bob.address,
    )
    expect(executedEvent).toBeDefined()

    // Verify the remark was actually executed (as Root)
    const hasRemarkEvent = (events2 as any).some(
      (e: any) => e.event.section === 'system' && e.event.method === 'Remarked',
    )
    expect(hasRemarkEvent).toBe(true)

    // Verify DeferredDispatch storage is cleaned up
    const afterExec = await getDeferredDispatch(client, callHash)
    expect(afterExec.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

/**
 * Direct dispatch — when the call is already whitelisted, Root origin
 * dispatches immediately without deferral.
 *
 * Pallet flow:
 *   1. whitelistCall (Root) → adds to WhitelistedCall storage
 *   2. dispatchWhitelistedCallWithPreimage (Root) → DIRECT dispatch (no defer)
 */
async function directDispatchWithPreimageTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'direct dispatch test')

    // Whitelist
    const whitelistTx = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(whitelistTx.signAsync(alice))
    await client.dev.newBlock()

    assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

    // Dispatch with Root — call IS whitelisted, so DIRECT dispatch
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify NO DispatchDeferred event (it was direct, not deferred)
    const events = await client.api.query.system.events()
    const deferredEvent = findEvent(
      events as any,
      'whitelist',
      'DispatchDeferred',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(deferredEvent).toBeUndefined()

    // Verify the remark executed
    const hasRemarkEvent = (events as any).some(
      (e: any) => e.event.section === 'system' && e.event.method === 'Remarked',
    )
    expect(hasRemarkEvent).toBe(true)

    // No deferred entry should exist
    const deferredOpt = await getDeferredDispatch(client, callHash)
    expect(deferredOpt.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

/**
 * Call semantics
 *
 * Uses forceTransfer (Root-only) to prove the deferred call runs with Root semantics.
 */
async function deferredDispatchRootSemanticsTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob
    const charlie = testAccounts.charlie

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    // Use a call that ONLY Root can execute: forceTransfer
    const {
      call,
      encodedCall: _encodedCall,
      callHash,
    } = buildForceTransferCall(client, alice.address, bob.address, 1000n)

    // Dispatch with Root before whitelist → DEFERS + auto-notes(preimage)
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify deferred
    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome, 'Should be deferred')

    // Execute with signed origin (Charlie) — the forceTransfer executes as Root
    const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(executeTx.signAsync(charlie))
    await client.dev.newBlock()

    // Verify the forceTransfer succeeded (proves it ran as Root)
    const allEvents = await client.api.query.system.events()
    const transferEvent = findEvent(
      allEvents as any,
      'balances',
      'Transfer',
      (d: any) => d.from.toString() === alice.address && d.to.toString() === bob.address,
    )
    expect(transferEvent).toBeDefined()

    // Now try the same call directly as Signed — should fail with BadOrigin
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

/**
 * Hash-only dispatch — dispatch_whitelisted_call with manual preimage.
 *
 * Pallet flow:
 *   1. dispatchWhitelistedCall (callHash) (Root) → DEFERS
 *   2. whitelistCall (Root)
 *   3. Note preimage manually
 *   4. dispatchWhitelistedCall (Signed) → EXECUTES (deferred)
 */
async function deferredDispatchHashOnlyTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, encodedCall, callHash } = buildCall(client, 'hash-only dispatch test')

    // Get call length and weight
    const callLen = call.method.toU8a().length
    const callWeight = await call.paymentInfo(alice.address)

    // Dispatch with callHash before whitelist → DEFERS
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight)
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify DispatchDeferred event
    const events1 = await client.api.query.system.events()
    const deferredEvent = findEvent(
      events1 as any,
      'whitelist',
      'DispatchDeferred',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(deferredEvent).toBeDefined()

    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome, 'Deferred dispatch should be created')

    // Whitelist
    const whitelistTx = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(whitelistTx.signAsync(alice))
    await client.dev.newBlock()

    // Note preimage manually
    await notePreimage(client, callHash, encodedCall)

    // Execute with signed origin using hash-only variant
    const executeTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, callWeight.weight)
    await sendTransaction(executeTx.signAsync(bob))
    await client.dev.newBlock()

    // Verify DeferredDispatchExecuted event
    const events2 = await client.api.query.system.events()
    const executedEvent = findEvent(
      events2 as any,
      'whitelist',
      'DeferredDispatchExecuted',
      (d: any) => d.callHash.toHex() === callHash && d.who.toString() === bob.address,
    )
    expect(executedEvent).toBeDefined()

    // Verify deferred entry is cleaned up
    const afterExec = await getDeferredDispatch(client, callHash)
    expect(afterExec.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

// ─────────────────────────────────────────────────────────────
// Failure Tests
// ─────────────────────────────────────────────────────────────

/**
 * Deferred dispatch expired — signed origin rejected after expiry.
 *
 * After the deferred dispatch expires, a signed origin can no longer execute it.
 * Root origin can still dispatch (see Test 7).
 */
async function deferredDispatchEarlyExecutionTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, encodedCall: _encodedCall, callHash } = buildCall(client, 'early execution test')

    // Dispatch with Root Before whitelist → DEFERS + auto-notes preimage
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify deferred entry exists
    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome, 'Deferred dispatch should exist')
    const expireBlock = deferredOpt.unwrap().expireAt.toNumber()

    const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
    await client.dev.newBlock({
      blocks: Math.max(expireBlock - currentBlock + 20, 30),
    })

    // Try to execute with signed origin — should fail with DeferredDispatchExpired
    const executeTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(executeTx.signAsync(bob))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'expired deferred dispatch rejected for signed origin',
    )

    // Entry still exists (needs permissionless removal)
    const stillDeferred = await getDeferredDispatch(client, callHash)
    expect(stillDeferred.isSome).toBe(true)
  } finally {
    await client.teardown()
  }
}

/**
 * Already deferred
 */
async function alreadyDeferredTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'already deferred test')

    // Dispatch with Root → DEFERS + autp-notes preimage
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify first deferral succeeded
    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome, 'First deferral should succeed')

    // Try to dispatch again with Root — should fail with AlreadyDeferred
    const dispatchTx2 = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx2.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'already deferred error',
    )
  } finally {
    await client.teardown()
  }
}

/**
 * Invalid call weight witness.
 *
 * dispatch_whitelisted_call requires the caller to provide the
 * call weight witness. If it doesn't match the actual call weight, the
 * extrinsic fails with InvalidCallWeightWitness.
 */
async function invalidCallWeightWitnessTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice

    await fundAccounts(client, [alice.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'invalid weight witness test')

    const callLen = call.method.toU8a().length

    // Use an intentionally wrong weight (way too high)
    const wrongWeight = { refTime: 1000000000000, proofSize: 1000000000000 }

    // Dispatch with wrong weight — should fail
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCall(callHash, callLen, wrongWeight as any)
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'invalid call weight witness',
    )
  } finally {
    await client.teardown()
  }
}

/**
 * Origin gating
 */
async function whitelistOriginGatingTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'origin gating test')

    // Bob (regular account) tries to whitelist — should fail with BadOrigin
    const unauthorizedWhitelist = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(unauthorizedWhitelist.signAsync(bob))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'unauthorized whitelist rejected',
    )

    // Bob tries to dispatch — should fail (only DispatchWhitelistedOrigin can defer)
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

/**
 * CallAlreadyWhitelisted
 */
async function callAlreadyWhitelistedTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice

    await fundAccounts(client, [alice.address], 10n ** 18n)

    const { callHash } = buildCall(client, 'double whitelist test')

    // Whitelist
    const whitelistTx1 = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(whitelistTx1.signAsync(alice))
    await client.dev.newBlock()

    assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

    // Attempt to whitelist the same hash fails with CallAlreadyWhitelisted
    const whitelistTx2 = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(whitelistTx2.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'call already whitelisted',
    )
  } finally {
    await client.teardown()
  }
}

/**
 * removeWhitelistedCall
 */
async function removeWhitelistedCallTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob

    await fundAccounts(client, [alice.address, bob.address], 10n ** 18n)

    const { callHash } = buildCall(client, 'remove whitelisted call test')

    // Whitelist
    const whitelistTx = client.api.tx.whitelist.whitelistCall(callHash)
    await sendTransaction(whitelistTx.signAsync(alice))
    await client.dev.newBlock()

    assert(await isWhitelisted(client, callHash), 'Call should be whitelisted')

    // Bob (non-Root) tries to remove, fails with BadOrigin
    const unauthorizedRemove = client.api.tx.whitelist.removeWhitelistedCall(callHash)
    await sendTransaction(unauthorizedRemove.signAsync(bob))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'unauthorized remove rejected',
    )

    // Alice (Root) removes
    const removeTx = client.api.tx.whitelist.removeWhitelistedCall(callHash)
    await sendTransaction(removeTx.signAsync(alice))
    await client.dev.newBlock()

    // Verify call is no longer whitelisted
    expect(await isWhitelisted(client, callHash)).toBe(false)

    // Try to remove again, fails with CallIsNotWhitelisted
    const removeTx2 = client.api.tx.whitelist.removeWhitelistedCall(callHash)
    await sendTransaction(removeTx2.signAsync(alice))
    await client.dev.newBlock()

    await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
      'remove non-whitelisted call fails',
    )
  } finally {
    await client.teardown()
  }
}

/**
 * Permissionless removal — anyone can clean up an expired deferred dispatch.
 */
async function permissionlessRemovalTest<T extends Chain>(chain: Chain<T>) {
  const [client] = await setupNetworks(chain)

  try {
    const alice = testAccounts.alice
    const bob = testAccounts.bob
    const charlie = testAccounts.charlie

    await fundAccounts(client, [alice.address, bob.address, charlie.address], 10n ** 18n)

    const { call, callHash } = buildCall(client, 'permissionless removal test')

    // Dispatch with Root BEFORE whitelist → DEFERS + auto-note(preimage)
    const dispatchTx = client.api.tx.whitelist.dispatchWhitelistedCallWithPreimage(call.method.toHex())
    await sendTransaction(dispatchTx.signAsync(alice))
    await client.dev.newBlock()

    // Move well past expiration
    const deferredOpt = await getDeferredDispatch(client, callHash)
    assert(deferredOpt.isSome)
    const expireBlock = deferredOpt.unwrap().expireAt.toNumber()
    const currentBlock = await getBlockNumber(client.api, client.config.properties.schedulerBlockProvider)
    await client.dev.newBlock({
      blocks: Math.max(expireBlock - currentBlock + 10, 20),
    })

    // Charlie (anyone) removes the expired deferred entry
    const removeTx = client.api.tx.whitelist.removeDeferredDispatch(callHash)
    await sendTransaction(removeTx.signAsync(charlie))
    await client.dev.newBlock()

    // Verify removal event
    const allEvents = await client.api.query.system.events()
    const removedEvent = findEvent(
      allEvents as any,
      'whitelist',
      'DeferredDispatchRemoved',
      (d: any) => d.callHash.toHex() === callHash,
    )
    expect(removedEvent).toBeDefined()

    // Verify storage is cleaned up
    const afterRemoval = await getDeferredDispatch(client, callHash)
    expect(afterRemoval.isNone).toBe(true)
  } finally {
    await client.teardown()
  }
}

// ─────────────────────────────────────────────────────────────
// Test Trees (following accounts.ts + bounties.ts pattern)
// ─────────────────────────────────────────────────────────────

/**
 * Success path test tree for whitelist deferred dispatch.
 */
export function whitelistDeferredSuccessTests<T extends Chain>(chain: Chain<T>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Whitelist Deferred Dispatch — Success Path',
    children: [
      {
        kind: 'test' as const,
        label: 'happy path — deferred dispatch executes after delay',
        testFn: () => deferredDispatchHappyPathTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'direct dispatch — whitelisted call executes immediately',
        testFn: () => directDispatchWithPreimageTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'root semantics — deferred call runs as Root origin',
        testFn: () => deferredDispatchRootSemanticsTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'hash-only dispatch — manual preimage path',
        testFn: () => deferredDispatchHashOnlyTest(chain),
      },
    ],
  }
}

/**
 * Failure path test tree for whitelist deferred dispatch.
 */
export function whitelistDeferredFailureTests<T extends Chain>(chain: Chain<T>): RootTestTree {
  return {
    kind: 'describe',
    label: 'Whitelist Deferred Dispatch — Failure Path',
    children: [
      {
        kind: 'test' as const,
        label: 'early execution rejected before expiration',
        testFn: () => deferredDispatchEarlyExecutionTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'already deferred — double deferral fails',
        testFn: () => alreadyDeferredTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'invalid call weight witness',
        testFn: () => invalidCallWeightWitnessTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'origin gating — unauthorized accounts rejected',
        testFn: () => whitelistOriginGatingTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'call already whitelisted — double whitelist fails',
        testFn: () => callAlreadyWhitelistedTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'remove whitelisted call — origin gating and success',
        testFn: () => removeWhitelistedCallTest(chain),
      },
      {
        kind: 'test' as const,
        label: 'permissionless removal — anyone cleans up expired entry',
        testFn: () => permissionlessRemovalTest(chain),
      },
    ],
  }
}

/**
 * Combined E2E test tree for whitelist deferred dispatch.
 *
 * Follows the pattern from accounts.ts and bounties.ts:
 *   - Groups tests into `success` and `failure` describe blocks
 *   - Accepts TestConfig for suite naming
 */
export function whitelistDeferredE2ETests<T extends Chain>(chain: Chain<T>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'success',
        children: whitelistDeferredSuccessTests(chain).children,
      },
      {
        kind: 'describe',
        label: 'failure',
        children: whitelistDeferredFailureTests(chain).children,
      },
    ],
  }
}
