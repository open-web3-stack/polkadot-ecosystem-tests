import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { Bytes, Option, u32, Vec } from '@polkadot/types'
import type { H256 } from '@polkadot/types/interfaces'
import type {
  PolkadotPrimitivesV8UpgradeRestriction,
  PolkadotRuntimeParachainsConfigurationHostConfiguration,
  PolkadotRuntimeParachainsParasParaPastCodeMeta,
  PolkadotRuntimeParachainsParasPvfCheckActiveVoteState,
} from '@polkadot/types/lookup'
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
 * Validation code that differs from both `MINIMAL_VALIDATION_CODE` and `NEW_VALIDATION_CODE` in its section ID byte.
 */
const SECOND_VALIDATION_CODE = u8aToHex(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x00]),
)

/**
 * Validation code of 8 bytes (magic number and version only), one byte below the relay chain's `MIN_CODE_SIZE` of 9.
 */
const UNDERSIZED_VALIDATION_CODE = u8aToHex(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))

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
 * Test `paras.force_set_current_head`, which overwrites a para's head data immediately.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the para's head is unchanged
 *
 * 2. Root origin, on a registered para
 *
 *     2.1 asserting the `CurrentHeadUpdated` event
 *
 *     2.2 asserting that the para's head is the new head
 *
 *     2.3 asserting that the para's most recent context is unchanged
 *
 * 3. Root origin, on an unregistered para
 *
 *     3.1 asserting the `CurrentHeadUpdated` event
 *
 *     3.2 asserting that the para's head is set to the new head
 */
export async function parasForceSetCurrentHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const newHead = u8aToHex(new Uint8Array([0x01, 0x02, 0x03]))

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)
  const unregisteredParaId = paraId + 1

  // Registering the para queues its genesis head for onboarding at the next session; `Heads` is not set yet
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).isNone).toBe(true)
  const mostRecentContextBefore = (await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.forceSetCurrentHead(paraId, newHead).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  await checkEvents(signedEvents, 'system').toMatchSnapshot('signed force set current head fails with BadOrigin')

  // 1.2 Assert that the head is unchanged
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).isNone).toBe(true)

  // 2. Root origin, on a registered para
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceSetCurrentHead(paraId, newHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 2.1 Assert the CurrentHeadUpdated event
  await checkSystemEvents(client, { section: 'paras', method: 'CurrentHeadUpdated' })
    .redact({ number: true })
    .toMatchSnapshot('root force set current head on registered para')

  // 2.2 Assert that the head is the new head
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).unwrap().toHex()).toBe(newHead)

  // 2.3 Assert that the most recent context is unchanged; only noting a new head updates it
  const mostRecentContextAfter = (await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>
  expect(mostRecentContextAfter.toHex()).toBe(mostRecentContextBefore.toHex())

  // 3. Root origin, on an unregistered para
  expect(((await client.api.query.paras.heads(unregisteredParaId)) as Option<Bytes>).isNone).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceSetCurrentHead(unregisteredParaId, newHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert the CurrentHeadUpdated event
  await checkSystemEvents(client, { section: 'paras', method: 'CurrentHeadUpdated' })
    .redact({ number: true })
    .toMatchSnapshot('root force set current head on unregistered para')

  // 3.2 Assert that the head is set, even though the para is not registered
  expect(((await client.api.query.paras.heads(unregisteredParaId)) as Option<Bytes>).unwrap().toHex()).toBe(newHead)
}

/**
 * Test `paras.force_schedule_code_upgrade` with validation code the relay chain has not seen before, which starts a
 * PVF pre-checking vote instead of queueing the upgrade.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that no upgrade is pending for the para
 *
 * 2. Root origin, scheduling unknown code for para A
 *
 *     2.1 asserting the `PvfCheckStarted` and `CodeUpgradeScheduled` events
 *
 *     2.2 asserting that the new code hash is pending as para A's future code, and its current code is unchanged
 *
 *     2.3 asserting that further upgrades of para A are restricted
 *
 *     2.4 asserting that an upgrade cooldown is recorded for para A
 *
 *     2.5 asserting that a PVF pre-checking vote is open for the new code, with para A's upgrade as its cause
 *
 *     2.6 asserting that the new code is stored by hash, with one reference
 *
 *     2.7 asserting that the upgrade is not yet queued for enactment
 *
 * 3. Root origin, scheduling other code for para A while its upgrade is pending
 *
 *     3.1 asserting that only the `CodeUpgradeScheduled` event is emitted
 *
 *     3.2 asserting that para A's future code hash is unchanged
 *
 *     3.3 asserting that the other code was not stored
 *
 *     3.4 asserting that no further upgrade cooldown is recorded for para A
 *
 * 4. Root origin, scheduling the same unknown code for para B
 *
 *     4.1 asserting the `PvfCheckStarted` and `CodeUpgradeScheduled` events
 *
 *     4.2 asserting that the new code hash is pending as para B's future code
 *
 *     4.3 asserting that para B's upgrade joins the open vote as a second cause, without opening a new vote
 *
 *     4.4 asserting that the new code's reference count is incremented
 */
export async function parasForceScheduleCodeUpgradeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const secondCodeHash = blake2AsHex(SECOND_VALIDATION_CODE)

  const activeConfig =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const cooldown = activeConfig.validationUpgradeCooldown.toNumber()

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraIdA = parseInt(nextFreeParaId.toString(), 10)
  const paraIdB = paraIdA + 1

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraIdA)
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraIdB)

  // The new code must be unknown to the chain, so that scheduling it starts a PVF pre-checking vote
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdA, NEW_VALIDATION_CODE, 0).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  await checkEvents(signedEvents, 'system').toMatchSnapshot('signed force schedule code upgrade fails with BadOrigin')

  // 1.2 Assert that no upgrade is pending
  expect(((await client.api.query.paras.futureCodeHash(paraIdA)) as Option<H256>).isNone).toBe(true)

  // 2. Root origin, scheduling unknown code for para A, as if included at the current block
  const relayParentA = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdA, NEW_VALIDATION_CODE, relayParentA).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled call runs in the block just built
  const scheduledAtA = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 2.1 Assert the PvfCheckStarted and CodeUpgradeScheduled events
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule unknown code for para A')

  const eventsA = await client.api.query.system.events()
  const [pvfCheckStartedA] = eventsA.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckStarted',
  )
  assert(client.api.events.paras.PvfCheckStarted.is(pvfCheckStartedA.event))
  expect(pvfCheckStartedA.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckStartedA.event.data[1].toString()).toBe(paraIdA.toString())
  const [scheduledEventA] = eventsA.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(scheduledEventA.event))
  expect(scheduledEventA.event.data[0].toString()).toBe(paraIdA.toString())
  expect(eventsA.filter(({ event }) => event.section === 'paras' && event.method === 'PvfCheckAccepted').length).toBe(0)

  // 2.2 Assert that the new code hash is pending as future code, and the current code is unchanged
  expect(((await client.api.query.paras.futureCodeHash(paraIdA)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)
  expect(((await client.api.query.paras.currentCodeHash(paraIdA)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 2.3 Assert that further upgrades are restricted
  const restrictionA = (await client.api.query.paras.upgradeRestrictionSignal(
    paraIdA,
  )) as Option<PolkadotPrimitivesV8UpgradeRestriction>
  expect(restrictionA.unwrap().isPresent).toBe(true)

  // 2.4 Assert that an upgrade cooldown is recorded, counted from the given relay parent
  let upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  let cooldownsA = upgradeCooldowns.filter(([id]) => id.toNumber() === paraIdA)
  expect(cooldownsA.length).toBe(1)
  expect(cooldownsA[0][1].toNumber()).toBe(relayParentA + cooldown)

  // 2.5 Assert that a PVF pre-checking vote is open for the new code, caused by para A's upgrade
  let vote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(vote.age.toNumber()).toBe(0)
  expect(vote.createdAt.toNumber()).toBe(scheduledAtA)
  expect(vote.causes.length).toBe(1)
  assert(vote.causes[0].isUpgrade)
  expect(vote.causes[0].asUpgrade.id.toNumber()).toBe(paraIdA)
  expect(vote.causes[0].asUpgrade.includedAt.toNumber()).toBe(relayParentA)
  expect(vote.causes[0].asUpgrade.upgradeStrategy.isApplyAtExpectedBlock).toBe(true)

  let voteList = (await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>
  expect(voteList.map((hash) => hash.toHex())).toContain(newCodeHash)

  // 2.6 Assert that the new code is stored by hash, with one reference
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(1)

  // 2.7 Assert that the upgrade is not yet queued for enactment; that waits on the vote's outcome
  let futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  expect(futureUpgradesAt.filter(([id]) => id.toNumber() === paraIdA).length).toBe(0)

  // 3. Root origin, scheduling other code for para A while its upgrade is pending
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdA, SECOND_VALIDATION_CODE, relayParentA).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert that only the CodeUpgradeScheduled event is emitted; the event does not mean an upgrade was scheduled
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule while upgrade pending for para A')

  const pendingEvents = await client.api.query.system.events()
  const pendingParasEvents = pendingEvents.filter(({ event }) => event.section === 'paras')
  expect(pendingParasEvents.length).toBe(1)
  assert(client.api.events.paras.CodeUpgradeScheduled.is(pendingParasEvents[0].event))
  expect(pendingParasEvents[0].event.data[0].toString()).toBe(paraIdA.toString())

  // 3.2 Assert that the future code hash is unchanged
  expect(((await client.api.query.paras.futureCodeHash(paraIdA)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 3.3 Assert that the other code was not stored and no vote was opened for it
  expect(((await client.api.query.paras.codeByHash(secondCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.codeByHashRefs(secondCodeHash)) as u32).toNumber()).toBe(0)
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        secondCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)

  // 3.4 Assert that no further upgrade cooldown is recorded
  upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  cooldownsA = upgradeCooldowns.filter(([id]) => id.toNumber() === paraIdA)
  expect(cooldownsA.length).toBe(1)

  // 4. Root origin, scheduling the same unknown code for para B
  const relayParentB = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdB, NEW_VALIDATION_CODE, relayParentB).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4.1 Assert the PvfCheckStarted and CodeUpgradeScheduled events
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule same unknown code for para B')

  const eventsB = await client.api.query.system.events()
  const [pvfCheckStartedB] = eventsB.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckStarted',
  )
  assert(client.api.events.paras.PvfCheckStarted.is(pvfCheckStartedB.event))
  expect(pvfCheckStartedB.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckStartedB.event.data[1].toString()).toBe(paraIdB.toString())
  const [scheduledEventB] = eventsB.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(scheduledEventB.event))
  expect(scheduledEventB.event.data[0].toString()).toBe(paraIdB.toString())

  // 4.2 Assert that the new code hash is pending as para B's future code
  expect(((await client.api.query.paras.futureCodeHash(paraIdB)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 4.3 Assert that para B's upgrade joins the open vote as a second cause, and no second vote is opened
  vote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(vote.createdAt.toNumber()).toBe(scheduledAtA)
  expect(vote.causes.length).toBe(2)
  assert(vote.causes[1].isUpgrade)
  expect(vote.causes[1].asUpgrade.id.toNumber()).toBe(paraIdB)
  expect(vote.causes[1].asUpgrade.includedAt.toNumber()).toBe(relayParentB)
  expect(vote.causes[1].asUpgrade.upgradeStrategy.isApplyAtExpectedBlock).toBe(true)

  voteList = (await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>
  expect(voteList.filter((hash) => hash.toHex() === newCodeHash).length).toBe(1)

  futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  expect(futureUpgradesAt.filter(([id]) => id.toNumber() === paraIdB).length).toBe(0)

  // 4.4 Assert that the new code's reference count is incremented
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(2)
}

/**
 * Test `paras.force_schedule_code_upgrade` with validation code the relay chain already knows, which skips the PVF
 * pre-checking vote and queues the upgrade for enactment at once.
 *
 * The upgrade is expected at `max(relay_parent + validation_upgrade_delay, now + minimum_validation_upgrade_delay)`.
 * Para A uses the current block as relay parent, and para B uses block 0, so that the minimum delay applies to B.
 *
 * 1. Root origin, adding the new code as trusted
 *
 *     1.1 asserting that the new code is stored by hash, with no references and no vote
 *
 * 2. Root origin, scheduling the known code for para A, as if included at the current block
 *
 *     2.1 asserting the `PvfCheckStarted`, `PvfCheckAccepted` and `CodeUpgradeScheduled` events
 *
 *     2.2 asserting that the new code hash is pending as para A's future code, and its current code is unchanged
 *
 *     2.3 asserting that further upgrades of para A are restricted, with a cooldown recorded
 *
 *     2.4 asserting that the upgrade is queued for enactment at the expected block
 *
 *     2.5 asserting that no PVF pre-checking vote is opened
 *
 *     2.6 asserting that the new code has one reference
 *
 * 3. Root origin, scheduling the known code for para B, as if included at block 0
 *
 *     3.1 asserting the `PvfCheckStarted`, `PvfCheckAccepted` and `CodeUpgradeScheduled` events
 *
 *     3.2 asserting that the new code hash is pending as para B's future code
 *
 *     3.3 asserting that the upgrade is queued for enactment after the minimum delay
 *
 *     3.4 asserting that para B's cooldown, already expired, is cleared in the same block along with its restriction
 *
 *     3.5 asserting that the new code's reference count is incremented
 */
export async function parasForceScheduleCodeUpgradeFastTrackE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)

  const activeConfig =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const cooldown = activeConfig.validationUpgradeCooldown.toNumber()
  const upgradeDelay = activeConfig.validationUpgradeDelay.toNumber()
  const minimumUpgradeDelay = activeConfig.minimumValidationUpgradeDelay.toNumber()

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraIdA = parseInt(nextFreeParaId.toString(), 10)
  const paraIdB = paraIdA + 1

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraIdA)
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraIdB)

  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)

  // 1. Root origin, adding the new code as trusted
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 1.1 Assert that the new code is stored by hash, with no references and no vote
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)

  // 2. Root origin, scheduling the known code for para A, as if included at the current block
  const relayParentA = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdA, NEW_VALIDATION_CODE, relayParentA).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled call runs in the block just built
  const scheduledAtA = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 2.1 Assert the PvfCheckStarted, PvfCheckAccepted and CodeUpgradeScheduled events
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule known code for para A')

  const eventsA = await client.api.query.system.events()
  const [pvfCheckStartedA] = eventsA.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckStarted',
  )
  assert(client.api.events.paras.PvfCheckStarted.is(pvfCheckStartedA.event))
  expect(pvfCheckStartedA.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckStartedA.event.data[1].toString()).toBe(paraIdA.toString())
  const [pvfCheckAcceptedA] = eventsA.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckAccepted',
  )
  assert(client.api.events.paras.PvfCheckAccepted.is(pvfCheckAcceptedA.event))
  expect(pvfCheckAcceptedA.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckAcceptedA.event.data[1].toString()).toBe(paraIdA.toString())
  const [scheduledEventA] = eventsA.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(scheduledEventA.event))
  expect(scheduledEventA.event.data[0].toString()).toBe(paraIdA.toString())

  // 2.2 Assert that the new code hash is pending as future code, and the current code is unchanged
  expect(((await client.api.query.paras.futureCodeHash(paraIdA)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)
  expect(((await client.api.query.paras.currentCodeHash(paraIdA)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 2.3 Assert that further upgrades are restricted, with a cooldown counted from the given relay parent
  const restrictionA = (await client.api.query.paras.upgradeRestrictionSignal(
    paraIdA,
  )) as Option<PolkadotPrimitivesV8UpgradeRestriction>
  expect(restrictionA.unwrap().isPresent).toBe(true)

  let upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  const cooldownsA = upgradeCooldowns.filter(([id]) => id.toNumber() === paraIdA)
  expect(cooldownsA.length).toBe(1)
  expect(cooldownsA[0][1].toNumber()).toBe(relayParentA + cooldown)

  // 2.4 Assert that the upgrade is queued for enactment at the expected block
  let futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  const upgradesA = futureUpgradesAt.filter(([id]) => id.toNumber() === paraIdA)
  expect(upgradesA.length).toBe(1)
  expect(upgradesA[0][1].toNumber()).toBe(Math.max(relayParentA + upgradeDelay, scheduledAtA + minimumUpgradeDelay))

  // 2.5 Assert that no PVF pre-checking vote is opened
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  const voteList = (await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>
  expect(voteList.map((hash) => hash.toHex())).not.toContain(newCodeHash)

  // 2.6 Assert that the new code has one reference
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(1)

  // 3. Root origin, scheduling the known code for para B, as if included at block 0
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraIdB, NEW_VALIDATION_CODE, 0).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const scheduledAtB = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3.1 Assert the PvfCheckStarted, PvfCheckAccepted and CodeUpgradeScheduled events
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule known code for para B')

  const eventsB = await client.api.query.system.events()
  const [pvfCheckStartedB] = eventsB.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckStarted',
  )
  assert(client.api.events.paras.PvfCheckStarted.is(pvfCheckStartedB.event))
  expect(pvfCheckStartedB.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckStartedB.event.data[1].toString()).toBe(paraIdB.toString())
  const [pvfCheckAcceptedB] = eventsB.filter(
    ({ event }) => event.section === 'paras' && event.method === 'PvfCheckAccepted',
  )
  assert(client.api.events.paras.PvfCheckAccepted.is(pvfCheckAcceptedB.event))
  expect(pvfCheckAcceptedB.event.data[0].toHex()).toBe(newCodeHash)
  expect(pvfCheckAcceptedB.event.data[1].toString()).toBe(paraIdB.toString())
  const [scheduledEventB] = eventsB.filter(
    ({ event }) => event.section === 'paras' && event.method === 'CodeUpgradeScheduled',
  )
  assert(client.api.events.paras.CodeUpgradeScheduled.is(scheduledEventB.event))
  expect(scheduledEventB.event.data[0].toString()).toBe(paraIdB.toString())

  // 3.2 Assert that the new code hash is pending as para B's future code
  expect(((await client.api.query.paras.futureCodeHash(paraIdB)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 3.3 Assert that the upgrade is queued after the minimum delay, which outweighs a delay counted from block 0
  expect(upgradeDelay).toBeLessThan(scheduledAtB + minimumUpgradeDelay)
  futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  const upgradesB = futureUpgradesAt.filter(([id]) => id.toNumber() === paraIdB)
  expect(upgradesB.length).toBe(1)
  expect(upgradesB[0][1].toNumber()).toBe(scheduledAtB + minimumUpgradeDelay)

  // 3.4 Assert that the cooldown, counted from block 0, has already expired. The paras pallet clears expired
  // cooldowns, and the upgrade restrictions they hold, at the end of every block, including this one.
  expect(cooldown).toBeLessThanOrEqual(scheduledAtB)
  upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  expect(upgradeCooldowns.filter(([id]) => id.toNumber() === paraIdB).length).toBe(0)
  expect(
    ((await client.api.query.paras.upgradeRestrictionSignal(paraIdB)) as Option<PolkadotPrimitivesV8UpgradeRestriction>)
      .isNone,
  ).toBe(true)

  // 3.5 Assert that the new code's reference count is incremented
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(2)
}

/**
 * Test `paras.force_schedule_code_upgrade` with code the paras pallet rejects. The call still succeeds and emits
 * `CodeUpgradeScheduled`, but nothing is scheduled.
 *
 * 1. Root origin, scheduling the para's current code
 *
 *     1.1 asserting that only the `CodeUpgradeScheduled` event is emitted
 *
 *     1.2 asserting that no upgrade is pending, restricted or cooling down for the para
 *
 *     1.3 asserting that the current code's reference count is unchanged
 *
 * 2. Root origin, scheduling code below the minimum code size
 *
 *     2.1 asserting that only the `CodeUpgradeScheduled` event is emitted
 *
 *     2.2 asserting that no upgrade is pending, restricted or cooling down for the para
 *
 *     2.3 asserting that the undersized code was not stored
 */
export async function parasForceScheduleCodeUpgradeAbortedE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const undersizedCodeHash = blake2AsHex(UNDERSIZED_VALIDATION_CODE)

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const oldCodeRefsBefore = ((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()

  // 1. Root origin, scheduling the para's current code
  const relayParent = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraId, MINIMAL_VALIDATION_CODE, relayParent).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 1.1 Assert that only the CodeUpgradeScheduled event is emitted
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule current code is aborted')

  const sameCodeEvents = await client.api.query.system.events()
  const sameCodeParasEvents = sameCodeEvents.filter(({ event }) => event.section === 'paras')
  expect(sameCodeParasEvents.length).toBe(1)
  assert(client.api.events.paras.CodeUpgradeScheduled.is(sameCodeParasEvents[0].event))
  expect(sameCodeParasEvents[0].event.data[0].toString()).toBe(paraId.toString())

  // 1.2 Assert that no upgrade is pending, restricted or cooling down
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.upgradeRestrictionSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeRestriction>)
      .isNone,
  ).toBe(true)
  let upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  expect(upgradeCooldowns.filter(([id]) => id.toNumber() === paraId).length).toBe(0)
  let futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  expect(futureUpgradesAt.filter(([id]) => id.toNumber() === paraId).length).toBe(0)

  // 1.3 Assert that the current code's reference count is unchanged
  expect(((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()).toBe(oldCodeRefsBefore)

  // 2. Root origin, scheduling code below the minimum code size
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraId, UNDERSIZED_VALIDATION_CODE, relayParent).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 2.1 Assert that only the CodeUpgradeScheduled event is emitted
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force schedule undersized code is aborted')

  const undersizedEvents = await client.api.query.system.events()
  const undersizedParasEvents = undersizedEvents.filter(({ event }) => event.section === 'paras')
  expect(undersizedParasEvents.length).toBe(1)
  assert(client.api.events.paras.CodeUpgradeScheduled.is(undersizedParasEvents[0].event))
  expect(undersizedParasEvents[0].event.data[0].toString()).toBe(paraId.toString())

  // 2.2 Assert that no upgrade is pending, restricted or cooling down
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.upgradeRestrictionSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeRestriction>)
      .isNone,
  ).toBe(true)
  upgradeCooldowns = (await client.api.query.paras.upgradeCooldowns()) as Vec<ITuple<[u32, u32]>>
  expect(upgradeCooldowns.filter(([id]) => id.toNumber() === paraId).length).toBe(0)
  futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  expect(futureUpgradesAt.filter(([id]) => id.toNumber() === paraId).length).toBe(0)

  // 2.3 Assert that the undersized code was not stored
  expect(((await client.api.query.paras.codeByHash(undersizedCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.codeByHashRefs(undersizedCodeHash)) as u32).toNumber()).toBe(0)
}

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
      },
      {
        kind: 'test',
        label: 'pallet paras - force schedule code upgrade with unknown code',
        testFn: async () => await parasForceScheduleCodeUpgradeE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - force schedule code upgrade with known code',
        testFn: async () => await parasForceScheduleCodeUpgradeFastTrackE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - force schedule code upgrade with rejected code',
        testFn: async () => await parasForceScheduleCodeUpgradeAbortedE2ETest(client),
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
