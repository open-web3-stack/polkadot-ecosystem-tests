import { createProof } from '@acala-network/chopsticks'
import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'

import { compactToU8a, hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'
import { decodeAddress, xxhashAsU8a } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents, type TestConfig } from './helpers/index.js'
import type { ProxyTypeMap } from './helpers/proxyTypes.js'
import { setupNetworks } from './setup.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

/**
 * Compute the raw storage key for the `Proxy.Proxies` map entry of a given account.
 *
 * The key layout is: `twox128("Proxy") ++ twox128("Proxies") ++ twox64(accountId) ++ accountId`.
 * This is the standard Substrate `StorageMap<Blake2_128Concat>` key format for the proxy pallet.
 */
function proxyStorageKey(accountId: Uint8Array): HexString {
  const palletPrefix = xxhashAsU8a('Proxy', 128)
  const storagePrefix = xxhashAsU8a('Proxies', 128)
  const twox64Hash = xxhashAsU8a(accountId, 64)
  return u8aToHex(u8aConcat(palletPrefix, storagePrefix, twox64Hash, accountId))
}

/**
 * Build a synthetic Merkle proof attesting that `delegate` is a proxy for `real`.
 *
 * Uses `api.createType` to SCALE-encode a `Proxy.Proxies` storage value with a single proxy
 * definition, then feeds the key-value pair into Chopsticks' `createProof([], inserts)` to
 * construct a fresh trie. Returns the trie root and the proof nodes. The root can later be
 * injected into the pallet's `BlockToRoot` storage so that the runtime accepts the proof.
 */
async function buildSyntheticProxyProof(
  api: any,
  real: { address: string },
  delegate: { address: string },
  proxyType: number,
  delay = 0,
): Promise<{ trieRootHash: HexString; proofNodes: HexString[] }> {
  const storageKey = proxyStorageKey(decodeAddress(real.address))
  const storageValue = api
    .createType('(Vec<(AccountId32, u8, u32)>, u128)', [[[delegate.address, proxyType, delay]], 0])
    .toHex() as HexString

  const { trieRootHash, nodes: proofNodes } = await createProof([], [[storageKey, storageValue]])

  return { trieRootHash: trieRootHash as HexString, proofNodes: proofNodes as HexString[] }
}

/**
 * Replace the most recent relay state root in the pallet's `BlockToRoot` storage with a synthetic one.
 *
 * The pallet stores a bounded vector of `(relay_block, state_root)` pairs that it uses to verify
 * incoming proofs. This function reads the current entries, swaps the state root of the last entry
 * with the given `trieRootHash`, and writes the result back via `dev.setStorage`.
 *
 * Raw storage injection is necessary because `BlockToRoot` is keyed by a generic pallet instance
 * parameter, which the high-level `dev.setStorage({ PalletName: ... })` API does not support.
 *
 * @returns The relay block number whose root was replaced (to be used as the proof's anchor block).
 */
async function injectSyntheticRoot(
  client: { api: any; dev: any },
  palletName: string,
  trieRootHash: HexString,
): Promise<number> {
  let blockToRoot = (await client.api.query[palletName].blockToRoot()).toJSON() as [number, string][]

  if (!blockToRoot || blockToRoot.length === 0) {
    await client.dev.newBlock()
    blockToRoot = (await client.api.query[palletName].blockToRoot()).toJSON() as [number, string][]
  }

  assert(blockToRoot.length > 0, 'BlockToRoot should not be empty after building a block')

  const lastRelayBlock = blockToRoot[blockToRoot.length - 1][0]

  const updatedBlockToRoot = blockToRoot.map(([block, hash]) =>
    block === lastRelayBlock ? [block, trieRootHash] : [block, hash],
  )

  const encodedEntries = updatedBlockToRoot.map(([block, hash]) =>
    u8aConcat(new Uint8Array(new Uint32Array([block as number]).buffer), hexToU8a(hash as string)),
  )
  const blockToRootValue = u8aToHex(u8aConcat(compactToU8a(updatedBlockToRoot.length), ...encodedEntries))

  const blockToRootKey = client.api.query[palletName].blockToRoot.key()
  await client.dev.setStorage([[blockToRootKey, blockToRootValue]])

  return lastRelayBlock
}

/**
 * Give each account a generous free balance so that transaction fees are not a concern.
 */
async function fundAccounts(client: { dev: any }, accounts: { address: string }[]) {
  await client.dev.setStorage({
    System: {
      account: accounts.map((a) => [[a.address], { providers: 1, data: { free: 100_000_000_000_000n } }]),
    },
  })
}

/// -------
/// Individual tests
/// -------

/**
 * Test the successful case of `remote_proxy`: dispatching an inner call on behalf of another account
 * using a valid relay-chain storage proof.
 *
 * 1. Fund Alice (real) and Bob (delegate)
 * 2. Build a synthetic proof attesting that Bob is an `Any` proxy for Alice with delay 0
 * 3. Inject the synthetic trie root into `BlockToRoot` so the pallet accepts the proof
 * 4. As Bob, call `remote_proxy` with the proof and `system.remarkWithEvent` as the inner call
 * 5. Verify that `proxy.ProxyExecuted { result: Ok }` and `system.Remarked` events are emitted
 */
async function remoteProxyCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash, proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.Any)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const innerCall = client.api.tx.system.remarkWithEvent('remote proxy test')
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: proofNodes, block: lastRelayBlock },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  // There should be exactly one ProxyExecuted event
  const proxyExecutedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'ProxyExecuted'
  })
  expect(proxyExecutedEvents.length).toBe(1)

  // The proxy call should have succeeded
  const proxyExecutedEvent = proxyExecutedEvents[0]
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecutedEvent.event))
  expect(proxyExecutedEvent.event.data.result.isOk).toBeTruthy()

  // The inner call (remarkWithEvent) should have emitted a Remarked event
  const remarkedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'Remarked'
  })
  expect(remarkedEvents.length).toBe(1)

  await checkEvents(result, { section: 'proxy', method: 'ProxyExecuted' }).toMatchSnapshot(
    'remote_proxy dispatches inner call',
  )
}

/**
 * Test that `remote_proxy` fails when the proof references a relay block number that the pallet
 * does not know about (i.e. not present in `BlockToRoot`).
 *
 * 1. Fund Alice and Bob
 * 2. Build a valid proof but do NOT inject its root into `BlockToRoot`
 * 3. As Bob, call `remote_proxy` referencing relay block 1 (which is not in `BlockToRoot`)
 * 4. Verify that the extrinsic fails with `ExtrinsicFailed`
 */
async function remoteProxyUnknownAnchorBlockTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.Any)

  const innerCall = client.api.tx.system.remarkWithEvent('should fail')
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: proofNodes, block: 1 },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const failedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvents.length).toBe(1)

  const { event } = failedEvents[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  expect(dispatchError.isModule).toBeTruthy()
  expect((client.api.errors as any)[palletName].UnknownProofAnchorBlock.is(dispatchError.asModule)).toBe(true)

  await checkEvents(result, 'system').toMatchSnapshot('remote_proxy with unknown anchor block')
}

/**
 * Test that `remote_proxy` fails when the proof nodes are garbage and do not verify against the
 * stored state root.
 *
 * 1. Fund Alice and Bob
 * 2. Build a valid proof and inject its root into `BlockToRoot`
 * 3. As Bob, call `remote_proxy` with `['0xdeadbeef']` as proof nodes instead of the real ones
 * 4. Verify that the extrinsic fails with `ExtrinsicFailed`
 */
async function remoteProxyInvalidProofTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.Any)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const innerCall = client.api.tx.system.remarkWithEvent('should fail')
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: ['0xdeadbeef'], block: lastRelayBlock },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const failedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvents.length).toBe(1)

  const { event } = failedEvents[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  expect(dispatchError.isModule).toBeTruthy()
  expect((client.api.errors as any)[palletName].InvalidProof.is(dispatchError.asModule)).toBe(true)

  await checkEvents(result, 'system').toMatchSnapshot('remote_proxy with invalid proof')
}

/**
 * Test that `remote_proxy` rejects proxy definitions that have a non-zero delay.
 *
 * The pallet requires `delay == 0` for remote proxies because time-delayed announcements cannot
 * be enforced across chains.
 *
 * 1. Fund Alice and Bob
 * 2. Build a proof where Bob is a proxy for Alice with delay = 5
 * 3. Inject the synthetic root into `BlockToRoot`
 * 4. As Bob, call `remote_proxy` with the proof
 * 5. Verify that the extrinsic fails with `ExtrinsicFailed`
 */
async function remoteProxyNonZeroDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash, proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.Any, 5)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const innerCall = client.api.tx.system.remarkWithEvent('should fail')
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: proofNodes, block: lastRelayBlock },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const failedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvents.length).toBe(1)

  const { event } = failedEvents[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  expect(dispatchError.isModule).toBeTruthy()
  expect((client.api.errors as any)[palletName].Unannounced.is(dispatchError.asModule)).toBe(true)

  await checkEvents(result, 'system').toMatchSnapshot('remote_proxy with non-zero delay')
}

/**
 * Test the two-step flow: `register_remote_proxy_proof` followed by `remote_proxy_with_registered_proof`.
 *
 * This flow allows the (expensive) proof verification to happen once, and subsequent proxy calls
 * in the same block to reuse the result without re-supplying the proof.
 *
 * 1. Fund Alice and Bob
 * 2. Build a valid proof and inject its root into `BlockToRoot`
 * 3. Construct a `batchAll` containing:
 *    a. `register_remote_proxy_proof` with the proof
 *    b. `remote_proxy_with_registered_proof` dispatching `system.remarkWithEvent`
 * 4. As Bob, submit the batch
 * 5. Verify that `proxy.ProxyExecuted { result: Ok }` and `system.Remarked` events are emitted
 */
async function registeredProofCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash, proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.Any)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const registerTx = client.api.tx[palletName].registerRemoteProxyProof({
    RelayChain: { proof: proofNodes, block: lastRelayBlock },
  })
  const proxyTx = client.api.tx[palletName].remoteProxyWithRegisteredProof(
    alice.address,
    null,
    client.api.tx.system.remarkWithEvent('registered proof test'),
  )

  const batchTx = client.api.tx.utility.batchAll([registerTx, proxyTx])
  const result = await sendTransaction(batchTx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const proxyExecutedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'ProxyExecuted'
  })
  expect(proxyExecutedEvents.length).toBe(1)

  const proxyExecutedEvent = proxyExecutedEvents[0]
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecutedEvent.event))
  expect(proxyExecutedEvent.event.data.result.isOk).toBeTruthy()

  const remarkedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'Remarked'
  })
  expect(remarkedEvents.length).toBe(1)

  await checkEvents(result, { section: 'proxy', method: 'ProxyExecuted' }).toMatchSnapshot(
    'batch(register_proof, remote_proxy_with_registered_proof)',
  )
}

/**
 * Test that `remote_proxy_with_registered_proof` fails if no proof was registered beforehand.
 *
 * 1. Fund Alice and Bob
 * 2. As Bob, call `remote_proxy_with_registered_proof` directly (without a prior
 *    `register_remote_proxy_proof` in the same block)
 * 3. Verify that the extrinsic fails with `ExtrinsicFailed`
 */
async function unregisteredProofCallTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, _proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const proxyTx = client.api.tx[palletName].remoteProxyWithRegisteredProof(
    alice.address,
    null,
    client.api.tx.system.remarkWithEvent('should fail'),
  )

  const result = await sendTransaction(proxyTx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const failedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvents.length).toBe(1)

  const { event } = failedEvents[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  const { dispatchError } = event.data
  expect(dispatchError.isModule).toBeTruthy()
  expect((client.api.errors as any)[palletName].ProxyProofNotRegistered.is(dispatchError.asModule)).toBe(true)

  await checkEvents(result, 'system').toMatchSnapshot('remote_proxy_with_registered_proof without registration')
}

/**
 * Test that `remote_proxy` respects proxy type call filtering for allowed calls.
 *
 * A `NonTransfer` proxy should be able to dispatch `system.remarkWithEvent` because that call
 * is not a transfer operation.
 *
 * 1. Fund Alice (real) and Bob (delegate)
 * 2. Build a proof where Bob is a `NonTransfer` proxy for Alice
 * 3. Inject the synthetic root and dispatch `system.remarkWithEvent` via `remote_proxy`
 * 4. Verify that `proxy.ProxyExecuted { result: Ok }` is emitted
 */
async function remoteProxyFilteringAllowedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash, proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.NonTransfer)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const innerCall = client.api.tx.system.remarkWithEvent('filtering allowed test')
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: proofNodes, block: lastRelayBlock },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  const proxyExecutedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'ProxyExecuted'
  })
  expect(proxyExecutedEvents.length).toBe(1)

  const proxyExecutedEvent = proxyExecutedEvents[0]
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecutedEvent.event))
  expect(proxyExecutedEvent.event.data.result.isOk).toBeTruthy()

  await checkEvents(result, { section: 'proxy', method: 'ProxyExecuted' }).toMatchSnapshot(
    'NonTransfer proxy allows remark via remote_proxy',
  )
}

/**
 * Test that `remote_proxy` respects proxy type call filtering for blocked calls.
 *
 * A `NonTransfer` proxy must NOT be able to dispatch `balances.transferKeepAlive` because that
 * is a transfer operation.
 *
 * 1. Fund Alice (real) and Bob (delegate)
 * 2. Build a proof where Bob is a `NonTransfer` proxy for Alice
 * 3. Inject the synthetic root and dispatch `balances.transferKeepAlive` via `remote_proxy`
 * 4. Verify that `proxy.ProxyExecuted { result: Err(CallFiltered) }` is emitted
 */
async function remoteProxyFilteringBlockedTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, palletName: string, proxyTypes: ProxyTypeMap) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  await fundAccounts(client, [alice, bob])

  const { trieRootHash, proofNodes } = await buildSyntheticProxyProof(client.api, alice, bob, proxyTypes.NonTransfer)
  const lastRelayBlock = await injectSyntheticRoot(client, palletName, trieRootHash)

  const innerCall = client.api.tx.balances.transferKeepAlive(bob.address, 1_000_000_000n)
  const tx = client.api.tx[palletName].remoteProxy(alice.address, null, innerCall, {
    RelayChain: { proof: proofNodes, block: lastRelayBlock },
  })

  const result = await sendTransaction(tx.signAsync(bob))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()

  // The remote_proxy extrinsic itself succeeds, but the inner call is filtered
  const proxyExecutedEvents = events.filter((record: any) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'ProxyExecuted'
  })
  expect(proxyExecutedEvents.length).toBe(1)

  const proxyExecutedEvent = proxyExecutedEvents[0]
  assert(client.api.events.proxy.ProxyExecuted.is(proxyExecutedEvent.event))
  expect(proxyExecutedEvent.event.data.result.isErr).toBeTruthy()

  const error = proxyExecutedEvent.event.data.result.asErr
  expect(error.isModule).toBeTruthy()
  expect(client.api.errors.system.CallFiltered.is(error.asModule)).toBe(true)

  await checkEvents(result, { section: 'proxy', method: 'ProxyExecuted' }).toMatchSnapshot(
    'NonTransfer proxy blocks transfer via remote_proxy',
  )
}

/// -------
/// Test tree
/// -------

/**
 * Build the full remote proxy E2E test tree.
 *
 * The tree covers two groups of tests:
 * - tests for the `remote_proxy` extrinsic, which accepts an inline storage proof.
 *   Includes the successful path, and three rejection cases (unknown anchor block,
 *   invalid proof, non-zero delay).
 * - tests for the two-step flow where the proof is registered first and then reused.
 *   Includes the successful path and the rejection case when no proof was registered.
 */
export function remoteProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: TestConfig,
  palletName: string,
  proxyTypes: ProxyTypeMap,
): RootTestTree {
  return {
    kind: 'describe',
    label: `${testConfig.testSuiteName} remote proxy tests`,
    children: [
      {
        kind: 'describe',
        label: 'remote_proxy (direct proof)',
        children: [
          {
            kind: 'test',
            label: 'dispatch inner call with valid proof',
            testFn: async () => await remoteProxyCallTest(chain, palletName, proxyTypes),
          },
          {
            kind: 'test',
            label: 'reject unknown anchor block',
            testFn: async () => await remoteProxyUnknownAnchorBlockTest(chain, palletName, proxyTypes),
          },
          {
            kind: 'test',
            label: 'reject invalid proof',
            testFn: async () => await remoteProxyInvalidProofTest(chain, palletName, proxyTypes),
          },
          {
            kind: 'test',
            label: 'reject proxy with non-zero delay',
            testFn: async () => await remoteProxyNonZeroDelayTest(chain, palletName, proxyTypes),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'register + remote_proxy_with_registered_proof',
        children: [
          {
            kind: 'test',
            label: 'dispatch inner call via batch(register, proxy_with_registered_proof)',
            testFn: async () => await registeredProofCallTest(chain, palletName, proxyTypes),
          },
          {
            kind: 'test',
            label: 'reject call without prior proof registration',
            testFn: async () => await unregisteredProofCallTest(chain, palletName, proxyTypes),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'remote_proxy call filtering',
        children: [
          {
            kind: 'test',
            label: 'NonTransfer proxy allows remark',
            testFn: async () => await remoteProxyFilteringAllowedTest(chain, palletName, proxyTypes),
          },
          {
            kind: 'test',
            label: 'NonTransfer proxy blocks transfer',
            testFn: async () => await remoteProxyFilteringBlockedTest(chain, palletName, proxyTypes),
          },
        ],
      },
    ],
  }
}
