import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { Bytes, Option, u32, Vec } from '@polkadot/types'
import type { H256 } from '@polkadot/types/interfaces'
import type { PolkadotRuntimeParachainsParasParaPastCodeMeta } from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import { blake2AsHex } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'
import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin } from './index.js'
import type { Client, RootTestTree } from './types.js'

const devAccounts = testAccounts

/**
 * The Genesis Head is the first block header of a parachain.
 * It's a series of bytes that stores the hash of the starting state for that chain.
 */
const GENESIS_HEAD = new Uint8Array([0x00])

/**
 * This is the compiled WASM runtime that validators run to verify if a block is valid.
 * It is stored and executed by the relay chain.
 * It's the smallest structurally valid WASM binary for test purposes, it contains no actual content.
 * The breakdown is as follows;
 * WASM Magic Number (\0asm)             - 0x00, 0x61, 0x73, 0x6d
 * WASM Version (1 - little endian, u32) - 0x01, 0x00, 0x00, 0x00
 * Section ID (1)                        - 0x01
 * Section Byte length (1)               - 0x01
 * Content (0)                           - 0x00
 */
const MINIMAL_VALIDATION_CODE = u8aToHex(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]),
)

/**
 * Helper to send the force_register extrinsic via root with an inline call, advance the blockchain state
 *  and assert the register events.
 */
async function forceRegisterParaViaRoot(client: Client<any, any>, manager: string, paraId: number): Promise<void> {
  const tx = client.api.tx.registrar.forceRegister(manager, BigInt(0), paraId, GENESIS_HEAD, MINIMAL_VALIDATION_CODE)
  await scheduleInlineCallWithOrigin(
    client,
    tx.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  const [regEvent] = events.filter(({ event }) => event.section === 'registrar' && event.method === 'Registered')
  assert(client.api.events.registrar.Registered.is(regEvent.event))
  expect(regEvent.event.data[0].toString()).toBe(paraId.toString())
}

/**
 * Engine ID under which the relay chain deposits its consensus logs in the block digest (`b"POL1"`).
 */
const POLKADOT_ENGINE_ID = '0x504f4c31'

/**
 * Index of the `ParaUpgradeCode(ParaId, ValidationCodeHash)` variant of the relay chain `ConsensusLog` enum.
 */
const CONSENSUS_LOG_PARA_UPGRADE_CODE = 1

/**
 * Validation code that differs from `MINIMAL_VALIDATION_CODE` only in its section ID byte, so that it hashes
 * to a different value. The paras pallet does not check the contents of forced code.
 */
const NEW_VALIDATION_CODE = u8aToHex(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x04, 0x01, 0x00]))

/**
 * Test `paras.force_set_current_code`, which replaces a para's validation code immediately, without
 * a PVF pre-check or upgrade delay.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the para's current code hash is unchanged
 *
 *     1.3 asserting that the new code was not stored
 *
 * 2. Root origin, on a registered para
 *
 *     2.1 asserting the `CurrentCodeUpdated` event
 *
 *     2.2 asserting that the para's current code hash is the new code's hash
 *
 *     2.3 asserting that the new code is stored by hash, with one reference
 *
 *     2.4 asserting that the old code's reference count is unchanged
 *
 *     2.5 asserting that the old code hash is recorded as past code at the current block
 *
 *     2.6 asserting that the replacement is noted in the para's past code metadata
 *
 *     2.7 asserting that the past code is scheduled for pruning
 *
 *     2.8 asserting that the block digest carries a `ParaUpgradeCode` consensus log
 *
 * 3. Root origin, on an unregistered para, with code already stored
 *
 *     3.1 asserting the `CurrentCodeUpdated` event
 *
 *     3.2 asserting that the para's current code hash is set to the new code's hash
 *
 *     3.3 asserting that the new code's reference count is incremented
 *
 *     3.4 asserting that no past code is recorded, since the para had no prior code
 *
 *     3.5 asserting that the block digest carries a `ParaUpgradeCode` consensus log
 */
export async function parasForceSetCurrentCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)
  const unregisteredParaId = paraId + 1

  // Registering the para sets its current code hash to the hash of `MINIMAL_VALIDATION_CODE`
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const currentCodeHashBefore = (await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>
  expect(currentCodeHashBefore.unwrap().toHex()).toBe(oldCodeHash)
  const oldCodeRefsBefore = ((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.pastCodeMeta(paraId)) as PolkadotRuntimeParachainsParasParaPastCodeMeta).upgradeTimes
      .length,
  ).toBe(0)

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.forceSetCurrentCode(paraId, NEW_VALIDATION_CODE).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  await checkEvents(signedEvents, 'system').toMatchSnapshot('signed force set current code fails with BadOrigin')

  // 1.2 Assert that the current code hash is unchanged
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 1.3 Assert that the new code was not stored
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)

  // 2. Root origin, on a registered para
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceSetCurrentCode(paraId, NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled call runs in the block just built, so its number is the replacement block
  const header = await client.api.rpc.chain.getHeader()
  const replacedAt = header.number.toNumber()

  // 2.1 Assert the CurrentCodeUpdated event
  await checkSystemEvents(client, { section: 'paras', method: 'CurrentCodeUpdated' })
    .redact({ number: true })
    .toMatchSnapshot('root force set current code on registered para')

  // 2.2 Assert that the current code hash is the new code's hash
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 2.3 Assert that the new code is stored by hash, with one reference
  const storedCode = (await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>
  expect(storedCode.unwrap().toHex()).toBe(NEW_VALIDATION_CODE)
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(1)

  // 2.4 Assert that the old code's reference count is unchanged; it is only released once past code is pruned
  expect(((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()).toBe(oldCodeRefsBefore)

  // 2.5 Assert that the old code hash is recorded as past code at the replacement block
  const pastCodeHash = (await client.api.query.paras.pastCodeHash([paraId, replacedAt])) as Option<H256>
  expect(pastCodeHash.unwrap().toHex()).toBe(oldCodeHash)

  // 2.6 Assert that the replacement is noted in the para's past code metadata
  const pastCodeMeta = (await client.api.query.paras.pastCodeMeta(
    paraId,
  )) as PolkadotRuntimeParachainsParasParaPastCodeMeta
  expect(pastCodeMeta.upgradeTimes.length).toBe(1)
  expect(pastCodeMeta.upgradeTimes[0].expectedAt.toNumber()).toBe(replacedAt)
  expect(pastCodeMeta.upgradeTimes[0].activatedAt.toNumber()).toBe(replacedAt)
  expect(pastCodeMeta.lastPruned.isNone).toBe(true)

  // 2.7 Assert that the past code is scheduled for pruning
  const pastCodePruning = (await client.api.query.paras.pastCodePruning()) as Vec<ITuple<[u32, u32]>>
  const pruningEntries = pastCodePruning.filter(([id]) => id.toNumber() === paraId)
  expect(pruningEntries.length).toBe(1)
  expect(pruningEntries[0][1].toNumber()).toBe(replacedAt)

  // 2.8 Assert that the block digest carries a ParaUpgradeCode consensus log.
  // Chopsticks does not copy runtime-deposited logs into the block header, so read them from `System::Digest`,
  // which keeps the digest of the latest block until the next block is initialized.
  const expectedLog = u8aToHex(
    u8aConcat(
      new Uint8Array([CONSENSUS_LOG_PARA_UPGRADE_CODE]),
      client.api.createType('u32', paraId).toU8a(),
      hexToU8a(newCodeHash),
    ),
  )
  const consensusLogs = (await client.api.query.system.digest()).logs
    .filter((log) => log.isConsensus && log.asConsensus[0].toHex() === POLKADOT_ENGINE_ID)
    .map((log) => log.asConsensus[1].toHex())
  expect(consensusLogs).toContain(expectedLog)

  // 3. Root origin, on an unregistered para, with the new code already stored
  expect(((await client.api.query.paras.currentCodeHash(unregisteredParaId)) as Option<H256>).isNone).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceSetCurrentCode(unregisteredParaId, NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const unregisteredHeader = await client.api.rpc.chain.getHeader()
  const unregisteredReplacedAt = unregisteredHeader.number.toNumber()

  // 3.1 Assert the CurrentCodeUpdated event
  await checkSystemEvents(client, { section: 'paras', method: 'CurrentCodeUpdated' })
    .redact({ number: true })
    .toMatchSnapshot('root force set current code on unregistered para')

  // 3.2 Assert that the current code hash is set, even though the para is not registered
  expect(((await client.api.query.paras.currentCodeHash(unregisteredParaId)) as Option<H256>).unwrap().toHex()).toBe(
    newCodeHash,
  )

  // 3.3 Assert that the new code's reference count is incremented, and the stored code is unchanged
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(2)
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )

  // 3.4 Assert that no past code is recorded
  expect(
    ((await client.api.query.paras.pastCodeHash([unregisteredParaId, unregisteredReplacedAt])) as Option<H256>).isNone,
  ).toBe(true)
  expect(
    ((await client.api.query.paras.pastCodeMeta(unregisteredParaId)) as PolkadotRuntimeParachainsParasParaPastCodeMeta)
      .upgradeTimes.length,
  ).toBe(0)
  const unregisteredPruning = (await client.api.query.paras.pastCodePruning()) as Vec<ITuple<[u32, u32]>>
  expect(unregisteredPruning.filter(([id]) => id.toNumber() === unregisteredParaId).length).toBe(0)

  // 3.5 Assert that the block digest carries a ParaUpgradeCode consensus log, read from `System::Digest`
  const expectedUnregisteredLog = u8aToHex(
    u8aConcat(
      new Uint8Array([CONSENSUS_LOG_PARA_UPGRADE_CODE]),
      client.api.createType('u32', unregisteredParaId).toU8a(),
      hexToU8a(newCodeHash),
    ),
  )
  const unregisteredConsensusLogs = (await client.api.query.system.digest()).logs
    .filter((log) => log.isConsensus && log.asConsensus[0].toHex() === POLKADOT_ENGINE_ID)
    .map((log) => log.asConsensus[1].toHex())
  expect(unregisteredConsensusLogs).toContain(expectedUnregisteredLog)
}

/**
 * Test `paras.force_set_current_head`.
 */
export async function parasForceSetCurrentHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_schedule_code_upgrade`.
 */
export async function parasForceScheduleCodeUpgradeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_note_new_head`.
 */
export async function parasForceNoteNewHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_queue_action`.
 */
export async function parasForceQueueActionE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.add_trusted_validation_code` and `paras.poke_unused_validation_code`.
 */
export async function parasTrustedValidationCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_set_most_recent_context`.
 */
export async function parasForceSetMostRecentContextE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.remove_upgrade_cooldown`.
 */
export async function parasRemoveUpgradeCooldownE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.authorize_force_set_current_code_hash` and `paras.apply_authorized_force_set_current_code`.
 */
export async function parasAuthorizedForceSetCurrentCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

export function parasE2ETest<
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
        kind: 'test',
        label: 'pallet paras - force set current code',
        testFn: async () => await parasForceSetCurrentCodeE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - force set current head',
        testFn: async () => await parasForceSetCurrentHeadE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force schedule code upgrade',
        testFn: async () => await parasForceScheduleCodeUpgradeE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force note new head',
        testFn: async () => await parasForceNoteNewHeadE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force queue action',
        testFn: async () => await parasForceQueueActionE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - add trusted / poke unused validation code',
        testFn: async () => await parasTrustedValidationCodeE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force set most recent context',
        testFn: async () => await parasForceSetMostRecentContextE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - remove upgrade cooldown',
        testFn: async () => await parasRemoveUpgradeCooldownE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - authorize / apply force set current code',
        testFn: async () => await parasAuthorizedForceSetCurrentCodeE2ETest(client),
        flags: { skip: true },
      },
    ],
  }
}
