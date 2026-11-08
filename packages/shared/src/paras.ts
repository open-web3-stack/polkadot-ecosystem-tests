import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { Bytes, Option, u32, Vec } from '@polkadot/types'
import type { H256, TransactionValidity } from '@polkadot/types/interfaces'
import type {
  PolkadotPrimitivesV8UpgradeGoAhead,
  PolkadotPrimitivesV8UpgradeRestriction,
  PolkadotRuntimeCommonParasRegistrarParaInfo,
  PolkadotRuntimeParachainsConfigurationHostConfiguration,
  PolkadotRuntimeParachainsParasParaGenesisArgs,
  PolkadotRuntimeParachainsParasParaLifecycle,
  PolkadotRuntimeParachainsParasParaPastCodeMeta,
  PolkadotRuntimeParachainsParasPvfCheckActiveVoteState,
} from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
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
 * Validators whose sr25519 keys the PVF pre-checking tests write into `ParasShared::ActiveValidatorKeys`, so that the
 * tests can sign PVF check statements. A validator's index is its position in this list.
 */
const PVF_CHECK_VALIDATORS = [devAccounts.alice, devAccounts.bob, devAccounts.charlie, devAccounts.dave]

/**
 * Helper to build an unsigned `include_pvf_check_statement` extrinsic, with the statement signed by `signer`.
 * The signed payload is the magic bytes `VCPC` followed by the SCALE-encoded statement.
 */
function pvfCheckStatementTx(
  client: Client<any, any>,
  signer: KeyringPair,
  statement: { accept: boolean; subject: string; sessionIndex: number; validatorIndex: number },
) {
  // The statement type's name includes the primitives version it is defined in, which changes between runtimes, so it
  // is read from the call's metadata
  const statementType = client.api.tx.paras.includePvfCheckStatement.meta.args[0].type.toString()
  const stmt = client.api.createType(statementType, statement)
  const signature = signer.sign(u8aConcat(stringToU8a('VCPC'), stmt.toU8a()))
  return client.api.tx.paras.includePvfCheckStatement(stmt, signature)
}

/**
 * Helper to ask the runtime whether its transaction pool would accept `tx`, as an external transaction at the current
 * head, without submitting it.
 *
 * It calls the `TaggedTransactionQueue_validate_transaction` runtime API with the same raw arguments Chopsticks uses
 * to validate submitted extrinsics: the `External` source byte `0x02`, the encoded extrinsic, and the head's hash.
 */
async function validateExtrinsic(client: Client<any, any>, tx: SubmittableExtrinsic<'promise'>) {
  const headHash = await client.api.rpc.chain.getBlockHash()
  const args = u8aConcat(new Uint8Array([0x02]), tx.toU8a(), headHash.toU8a())
  const result = await client.api.rpc.state.call('TaggedTransactionQueue_validate_transaction', args)
  return client.api.createType<TransactionValidity>('TransactionValidity', result)
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
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed force set current code fails with BadOrigin')

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
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed force set current head fails with BadOrigin')

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
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed force schedule code upgrade fails with BadOrigin')

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
 * Test `paras.force_note_new_head`, which notes a new head for a para as if it had been executed in the context of
 * the current block, when the para has no pending upgrade.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the para's head, most recent context and go-ahead signal are unchanged
 *
 * 2. Root origin, on a registered para with no pending upgrade and an `Abort` go-ahead signal
 *
 *     2.1 asserting the `NewHeadNoted` event
 *
 *     2.2 asserting that the para's head is the new head
 *
 *     2.3 asserting that the para's most recent context is the current block
 *
 *     2.4 asserting that the `Abort` go-ahead signal is cleared
 *
 *     2.5 asserting that the registrar locks the para
 *
 *     2.6 asserting that the para's current code is unchanged
 *
 * 3. Root origin, on an unregistered para
 *
 *     3.1 asserting the `NewHeadNoted` event
 *
 *     3.2 asserting that the para's head and most recent context are set
 *
 *     3.3 asserting that the registrar does not create an entry for the para
 */
export async function parasForceNoteNewHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newHead = u8aToHex(new Uint8Array([0x01, 0x02, 0x03]))

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)
  const unregisteredParaId = paraId + 1

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  // A freshly registered para has no head or context until onboarding, and its registrar lock is unset
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>).isNone).toBe(true)
  const paraInfoBefore = (
    (await client.api.query.registrar.paras(paraId)) as Option<PolkadotRuntimeCommonParasRegistrarParaInfo>
  ).unwrap()
  expect(paraInfoBefore.locked.isNone).toBe(true)

  // The relay chain sets an `Abort` go-ahead signal when it rejects a para's upgrade. Setting it directly here lets the
  // test observe that noting a head with no pending upgrade clears it.
  await client.dev.setStorage({
    Paras: {
      upgradeGoAheadSignal: [[[paraId], 'Abort']],
    },
  })

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.forceNoteNewHead(paraId, newHead).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed force note new head fails with BadOrigin')

  // 1.2 Assert that the head, most recent context and go-ahead signal are unchanged
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.upgradeGoAheadSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeGoAhead>).unwrap()
      .isAbort,
  ).toBe(true)

  // 2. Root origin, on a registered para with no pending upgrade
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceNoteNewHead(paraId, newHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled call runs in the block just built, which is the context the head is noted in
  const notedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 2.1 Assert the NewHeadNoted event
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force note new head on registered para')

  // 2.2 Assert that the head is the new head
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).unwrap().toHex()).toBe(newHead)

  // 2.3 Assert that the most recent context is the current block
  expect(((await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>).unwrap().toNumber()).toBe(notedAt)

  // 2.4 Assert that the Abort go-ahead signal is cleared
  expect(
    ((await client.api.query.paras.upgradeGoAheadSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeGoAhead>).isNone,
  ).toBe(true)

  // 2.5 Assert that the registrar locks the para, leaving its manager and deposit as they were
  const paraInfoAfter = (
    (await client.api.query.registrar.paras(paraId)) as Option<PolkadotRuntimeCommonParasRegistrarParaInfo>
  ).unwrap()
  expect(paraInfoAfter.locked.unwrap().isTrue).toBe(true)
  expect(paraInfoAfter.manager.toString()).toBe(paraInfoBefore.manager.toString())
  expect(paraInfoAfter.deposit.toString()).toBe(paraInfoBefore.deposit.toString())

  // 2.6 Assert that the current code is unchanged
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 3. Root origin, on an unregistered para
  expect(((await client.api.query.paras.heads(unregisteredParaId)) as Option<Bytes>).isNone).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceNoteNewHead(unregisteredParaId, newHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const unregisteredNotedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 3.1 Assert the NewHeadNoted event
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force note new head on unregistered para')

  // 3.2 Assert that the head and most recent context are set, even though the para is not registered
  expect(((await client.api.query.paras.heads(unregisteredParaId)) as Option<Bytes>).unwrap().toHex()).toBe(newHead)
  expect(
    ((await client.api.query.paras.mostRecentContext(unregisteredParaId)) as Option<u32>).unwrap().toNumber(),
  ).toBe(unregisteredNotedAt)

  // 3.3 Assert that the registrar does not create an entry for the para
  expect(
    (
      (await client.api.query.registrar.paras(
        unregisteredParaId,
      )) as Option<PolkadotRuntimeCommonParasRegistrarParaInfo>
    ).isNone,
  ).toBe(true)
}

/**
 * Test `paras.force_note_new_head` on a para with an upgrade pending under the go-ahead signal strategy. Noting a head
 * in a context at or past the upgrade's expected block applies the upgrade.
 *
 * 1. Root origin, noting a head before the upgrade's expected block
 *
 *     1.1 asserting the `NewHeadNoted` event
 *
 *     1.2 asserting that the para's head and most recent context are set
 *
 *     1.3 asserting that the pending upgrade and its go-ahead signal are unchanged
 *
 *     1.4 asserting that the para's current code is unchanged
 *
 * 2. Root origin, noting a head at or past the upgrade's expected block
 *
 *     2.1 asserting that only the `NewHeadNoted` event is emitted
 *
 *     2.2 asserting that the para's head and most recent context are set
 *
 *     2.3 asserting that the pending upgrade and its go-ahead signal are cleared
 *
 *     2.4 asserting that the para's current code hash is the new code's hash
 *
 *     2.5 asserting that the old code hash is recorded as past code at the expected block
 *
 *     2.6 asserting that the replacement is noted in the para's past code metadata and scheduled for pruning
 *
 *     2.7 asserting that the block digest carries a `ParaUpgradeCode` consensus log
 */
export async function parasForceNoteNewHeadWithUpgradeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const firstHead = u8aToHex(new Uint8Array([0x01, 0x02, 0x03]))
  const secondHead = u8aToHex(new Uint8Array([0x04, 0x05, 0x06]))

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  // Write an upgrade pending well past the current block
  const currentBlock = (await client.api.rpc.chain.getHeader()).number.toNumber()
  const futureExpectedAt = currentBlock + 1000
  await client.dev.setStorage({
    Paras: {
      futureCodeHash: [[[paraId], newCodeHash]],
      futureCodeUpgrades: [[[paraId], futureExpectedAt]],
      upgradeGoAheadSignal: [[[paraId], 'GoAhead']],
    },
  })

  // 1. Root origin, noting a head before the upgrade's expected block
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceNoteNewHead(paraId, firstHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const firstNotedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 1.1 Assert the NewHeadNoted event
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force note new head before upgrade is due')

  // 1.2 Assert that the head and most recent context are set
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).unwrap().toHex()).toBe(firstHead)
  expect(((await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>).unwrap().toNumber()).toBe(
    firstNotedAt,
  )

  // 1.3 Assert that the pending upgrade and its go-ahead signal are unchanged
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)
  expect(((await client.api.query.paras.futureCodeUpgrades(paraId)) as Option<u32>).unwrap().toNumber()).toBe(
    futureExpectedAt,
  )
  expect(
    ((await client.api.query.paras.upgradeGoAheadSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeGoAhead>).unwrap()
      .isGoAhead,
  ).toBe(true)

  // 1.4 Assert that the current code is unchanged
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 2. Move the upgrade's expected block to the current block, so that the next noted head is at or past it
  const dueExpectedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await client.dev.setStorage({
    Paras: {
      futureCodeUpgrades: [[[paraId], dueExpectedAt]],
    },
  })

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceNoteNewHead(paraId, secondHead).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const secondNotedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 2.1 Assert that only the NewHeadNoted event is emitted; applying the upgrade does not emit `CurrentCodeUpdated`
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force note new head applies due upgrade')

  // 2.2 Assert that the head and most recent context are set
  expect(((await client.api.query.paras.heads(paraId)) as Option<Bytes>).unwrap().toHex()).toBe(secondHead)
  expect(((await client.api.query.paras.mostRecentContext(paraId)) as Option<u32>).unwrap().toNumber()).toBe(
    secondNotedAt,
  )

  // 2.3 Assert that the pending upgrade and its go-ahead signal are cleared
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).isNone).toBe(true)
  expect(((await client.api.query.paras.futureCodeUpgrades(paraId)) as Option<u32>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.upgradeGoAheadSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeGoAhead>).isNone,
  ).toBe(true)

  // 2.4 Assert that the current code hash is the new code's hash
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 2.5 Assert that the old code hash is recorded as past code at the expected block, not the block it was applied in
  const pastCodeHash = (await client.api.query.paras.pastCodeHash([paraId, dueExpectedAt])) as Option<H256>
  expect(pastCodeHash.unwrap().toHex()).toBe(oldCodeHash)

  // 2.6 Assert that the replacement is noted in the past code metadata, and pruning is counted from the block it
  // was applied in
  const pastCodeMeta = (await client.api.query.paras.pastCodeMeta(
    paraId,
  )) as PolkadotRuntimeParachainsParasParaPastCodeMeta
  expect(pastCodeMeta.upgradeTimes.length).toBe(1)
  expect(pastCodeMeta.upgradeTimes[0].expectedAt.toNumber()).toBe(dueExpectedAt)
  expect(pastCodeMeta.upgradeTimes[0].activatedAt.toNumber()).toBe(secondNotedAt)

  const pastCodePruning = (await client.api.query.paras.pastCodePruning()) as Vec<ITuple<[u32, u32]>>
  const pruningEntries = pastCodePruning.filter(([id]) => id.toNumber() === paraId)
  expect(pruningEntries.length).toBe(1)
  expect(pruningEntries[0][1].toNumber()).toBe(secondNotedAt)

  // 2.7 Assert that the block digest carries a ParaUpgradeCode consensus log, read from `System::Digest`
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
}

/**
 * Test `paras.force_queue_action`, which adds a para to the actions queue of the next session. At that session's
 * start, the paras pallet applies any pending lifecycle change for each queued para.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the next session's actions queue is unchanged
 *
 * 2. Root origin, on a registered para
 *
 *     2.1 asserting the `ActionQueued` event, naming the para and the next session
 *
 *     2.2 asserting that the para is added to the next session's actions queue, keeping existing entries
 *
 *     2.3 asserting that the para's lifecycle is unchanged until the session starts
 *
 * 3. Root origin, on the same para again
 *
 *     3.1 asserting the `ActionQueued` event
 *
 *     3.2 asserting that the para appears in the queue only once
 *
 * 4. Root origin, on an unregistered para
 *
 *     4.1 asserting the `ActionQueued` event
 *
 *     4.2 asserting that the para is added to the queue, which stays sorted by para ID
 */
export async function parasForceQueueActionE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)
  const unregisteredParaId = paraId + 1

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const currentSession = ((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()
  const nextSession = currentSession + 1

  const queueBefore = ((await client.api.query.paras.actionsQueue(nextSession)) as Vec<u32>).map((id) => id.toNumber())
  expect(queueBefore).not.toContain(paraId)
  expect(queueBefore).not.toContain(unregisteredParaId)

  const lifecycleBefore = (
    (await client.api.query.paras.paraLifecycles(paraId)) as Option<PolkadotRuntimeParachainsParasParaLifecycle>
  ).unwrap()

  // 1. Signed origin
  const signedEvents = await sendTransaction(client.api.tx.paras.forceQueueAction(paraId).signAsync(devAccounts.alice))
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed force queue action fails with BadOrigin')

  // 1.2 Assert that the next session's actions queue is unchanged
  let queue = ((await client.api.query.paras.actionsQueue(nextSession)) as Vec<u32>).map((id) => id.toNumber())
  expect(queue).toEqual(queueBefore)

  // 2. Root origin, on a registered para
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceQueueAction(paraId).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The test must not cross a session boundary, or the queue it inspects would no longer be the next session's
  expect(((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()).toBe(currentSession)

  // 2.1 Assert the ActionQueued event, naming the para and the next session
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force queue action on registered para')

  // 2.2 Assert that the para is added to the queue, keeping existing entries
  queue = ((await client.api.query.paras.actionsQueue(nextSession)) as Vec<u32>).map((id) => id.toNumber())
  expect(queue).toEqual([...queueBefore, paraId].sort((a, b) => a - b))

  // 2.3 Assert that the lifecycle is unchanged until the session starts
  const lifecycleAfter = (
    (await client.api.query.paras.paraLifecycles(paraId)) as Option<PolkadotRuntimeParachainsParasParaLifecycle>
  ).unwrap()
  expect(lifecycleAfter.type).toBe(lifecycleBefore.type)

  // 3. Root origin, on the same para again
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceQueueAction(paraId).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert the ActionQueued event; it is emitted even though the para is already queued
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force queue action on already queued para')

  // 3.2 Assert that the para appears in the queue only once
  queue = ((await client.api.query.paras.actionsQueue(nextSession)) as Vec<u32>).map((id) => id.toNumber())
  expect(queue).toEqual([...queueBefore, paraId].sort((a, b) => a - b))

  // 4. Root origin, on an unregistered para
  expect(
    (
      (await client.api.query.paras.paraLifecycles(
        unregisteredParaId,
      )) as Option<PolkadotRuntimeParachainsParasParaLifecycle>
    ).isNone,
  ).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceQueueAction(unregisteredParaId).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4.1 Assert the ActionQueued event
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root force queue action on unregistered para')

  // 4.2 Assert that the para is added to the queue, which stays sorted by para ID
  queue = ((await client.api.query.paras.actionsQueue(nextSession)) as Vec<u32>).map((id) => id.toNumber())
  expect(queue).toEqual([...queueBefore, paraId, unregisteredParaId].sort((a, b) => a - b))
}

/**
 * Test `paras.add_trusted_validation_code`, which marks validation code as trusted. The call emits no event of its
 * own. What it does depends on the code:
 * - unknown code, with no PVF pre-checking vote, is stored with no references
 * - code already stored, with no vote, is left as it is
 * - code under a PVF pre-checking vote is accepted at once: the vote is closed and every para waiting on it proceeds
 *   with its upgrade or onboarding
 *
 * Registering a para with code the chain has not seen opens a vote for that code, caused by the para's onboarding.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the code was not stored
 *
 * 2. Root origin, with unknown code and no vote
 *
 *     2.1 asserting that no paras event is emitted
 *
 *     2.2 asserting that the code is stored by hash, with no references
 *
 *     2.3 asserting that no vote is opened for the code
 *
 * 3. Root origin, with the same code again
 *
 *     3.1 asserting that no paras event is emitted
 *
 *     3.2 asserting that the stored code and its reference count are unchanged
 *
 * 4. Root origin, with code under a vote caused by a code upgrade
 *
 *     4.1 asserting the `PvfCheckAccepted` event for the upgrading para
 *
 *     4.2 asserting that the vote is closed
 *
 *     4.3 asserting that the upgrade is queued for enactment at the expected block
 *
 *     4.4 asserting that the code's storage, reference count and the para's future code hash are unchanged
 *
 * 5. Root origin, with code under a vote caused by a para's onboarding
 *
 *     5.1 asserting the `PvfCheckAccepted` event for the onboarding para
 *
 *     5.2 asserting that the vote is closed
 *
 *     5.3 asserting that the para is queued to onboard at the session the vote's age allows
 *
 *     5.4 asserting that the code's reference count is unchanged
 */
export async function parasAddTrustedValidationCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const secondCodeHash = blake2AsHex(SECOND_VALIDATION_CODE)

  const activeConfig =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const upgradeDelay = activeConfig.validationUpgradeDelay.toNumber()
  const minimumUpgradeDelay = activeConfig.minimumValidationUpgradeDelay.toNumber()

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const currentSession = ((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()

  // Registering the para opened a vote for its code, caused by its onboarding
  const onboardingVote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      oldCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(onboardingVote.causes.length).toBe(1)
  assert(onboardingVote.causes[0].isOnboarding)
  expect(onboardingVote.causes[0].asOnboarding.toNumber()).toBe(paraId)
  const oldCodeRefsBefore = ((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()

  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.addTrustedValidationCode(NEW_VALIDATION_CODE).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed add trusted validation code fails with BadOrigin')

  // 1.2 Assert that the code was not stored
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)

  // 2. Root origin, with unknown code and no vote
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 2.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('root add unknown trusted validation code')

  const unknownEvents = await client.api.query.system.events()
  expect(unknownEvents.filter(({ event }) => event.section === 'paras').length).toBe(0)

  // 2.2 Assert that the code is stored by hash, with no references; no para uses it yet
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)

  // 2.3 Assert that no vote is opened for the code
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)

  // 3. Root origin, with the same code again
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('root add already stored trusted validation code')

  // 3.2 Assert that the stored code and its reference count are unchanged
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)

  // 4. Root origin, with code under a vote caused by a code upgrade.
  // Scheduling an upgrade to unknown code opens that vote.
  const relayParent = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraId, SECOND_VALIDATION_CODE, relayParent).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const upgradeVote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      secondCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(upgradeVote.causes.length).toBe(1)
  assert(upgradeVote.causes[0].isUpgrade)
  expect(upgradeVote.causes[0].asUpgrade.id.toNumber()).toBe(paraId)
  const secondCodeRefsBefore = ((await client.api.query.paras.codeByHashRefs(secondCodeHash)) as u32).toNumber()

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(SECOND_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The scheduled call runs in the block just built
  const upgradeAcceptedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // 4.1 Assert the PvfCheckAccepted event for the upgrading para
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root add trusted code under upgrade vote')

  // 4.2 Assert that the vote is closed
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        secondCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  let voteList = ((await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>).map((hash) => hash.toHex())
  expect(voteList).not.toContain(secondCodeHash)

  // 4.3 Assert that the upgrade is queued for enactment at the expected block
  const futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  const upgrades = futureUpgradesAt.filter(([id]) => id.toNumber() === paraId)
  expect(upgrades.length).toBe(1)
  expect(upgrades[0][1].toNumber()).toBe(Math.max(relayParent + upgradeDelay, upgradeAcceptedAt + minimumUpgradeDelay))

  // 4.4 Assert that the code's storage, reference count and the para's future code hash are unchanged
  expect(((await client.api.query.paras.codeByHash(secondCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    SECOND_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(secondCodeHash)) as u32).toNumber()).toBe(secondCodeRefsBefore)
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(secondCodeHash)

  // 5. Root origin, with code under a vote caused by the para's onboarding
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(MINIMAL_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // The test must not cross a session boundary, or the onboarding session computed below would be off
  expect(((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()).toBe(currentSession)

  // 5.1 Assert the PvfCheckAccepted event for the onboarding para
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('root add trusted code under onboarding vote')

  // 5.2 Assert that the vote is closed
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        oldCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  voteList = ((await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>).map((hash) => hash.toHex())
  expect(voteList).not.toContain(oldCodeHash)

  // 5.3 Assert that the para is queued to onboard. Onboarding waits two sessions, less the sessions the vote has
  // already observed, but never less than one.
  const onboardAt = currentSession + Math.max(2 - onboardingVote.age.toNumber(), 1)
  const onboardingQueue = ((await client.api.query.paras.actionsQueue(onboardAt)) as Vec<u32>).map((id) =>
    id.toNumber(),
  )
  expect(onboardingQueue).toContain(paraId)

  // 5.4 Assert that the code's reference count is unchanged
  expect(((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()).toBe(oldCodeRefsBefore)
}

/**
 * Test `paras.poke_unused_validation_code`, which removes stored validation code by hash if no para references it.
 * The call emits no event of its own, and succeeds without effect on code that is in use or not stored.
 *
 * Code added with `add_trusted_validation_code` is stored with no references, and a registered para's code has at
 * least one.
 *
 * 1. signed origin
 *
 *     1.1 asserting that a signed (non-root) caller fails with `BadOrigin`
 *
 *     1.2 asserting that the unused code is still stored
 *
 * 2. Root origin, on code with no references
 *
 *     2.1 asserting that no paras event is emitted
 *
 *     2.2 asserting that the code is removed
 *
 * 3. Root origin, on code a registered para uses
 *
 *     3.1 asserting that no paras event is emitted
 *
 *     3.2 asserting that the code and its reference count are unchanged
 *
 * 4. Root origin, on a hash with no stored code
 *
 *     4.1 asserting that no paras event is emitted
 *
 *     4.2 asserting that nothing is stored under the hash
 */
export async function parasPokeUnusedValidationCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const usedCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const unusedCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const unknownCodeHash = blake2AsHex(SECOND_VALIDATION_CODE)

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  // Registering the para gives its code at least one reference
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const usedCodeRefs = ((await client.api.query.paras.codeByHashRefs(usedCodeHash)) as u32).toNumber()
  expect(usedCodeRefs).toBeGreaterThan(0)

  // Add code as trusted, so that it is stored with no references
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.addTrustedValidationCode(NEW_VALIDATION_CODE).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  expect(((await client.api.query.paras.codeByHash(unusedCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(unusedCodeHash)) as u32).toNumber()).toBe(0)

  // 1. Signed origin
  const signedEvents = await sendTransaction(
    client.api.tx.paras.pokeUnusedValidationCode(unusedCodeHash).signAsync(devAccounts.alice),
  )
  await client.dev.newBlock()

  // 1.1 Assert that a signed caller fails with BadOrigin
  // The weight in `dispatchInfo` is left out; it comes from runtime benchmarks and changes when they are re-run
  await checkEvents(signedEvents, 'system')
    .redact({ removeKeys: /dispatchInfo/ })
    .toMatchSnapshot('signed poke unused validation code fails with BadOrigin')

  // 1.2 Assert that the unused code is still stored
  expect(((await client.api.query.paras.codeByHash(unusedCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    NEW_VALIDATION_CODE,
  )

  // 2. Root origin, on code with no references
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.pokeUnusedValidationCode(unusedCodeHash).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 2.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('root poke unused validation code')

  // 2.2 Assert that the code is removed
  expect(((await client.api.query.paras.codeByHash(unusedCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.codeByHashRefs(unusedCodeHash)) as u32).toNumber()).toBe(0)

  // 3. Root origin, on code a registered para uses
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.pokeUnusedValidationCode(usedCodeHash).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('root poke validation code in use')

  const usedEvents = await client.api.query.system.events()
  expect(usedEvents.filter(({ event }) => event.section === 'paras').length).toBe(0)

  // 3.2 Assert that the code and its reference count are unchanged
  expect(((await client.api.query.paras.codeByHash(usedCodeHash)) as Option<Bytes>).unwrap().toHex()).toBe(
    MINIMAL_VALIDATION_CODE,
  )
  expect(((await client.api.query.paras.codeByHashRefs(usedCodeHash)) as u32).toNumber()).toBe(usedCodeRefs)

  // 4. Root origin, on a hash with no stored code
  expect(((await client.api.query.paras.codeByHash(unknownCodeHash)) as Option<Bytes>).isNone).toBe(true)

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.pokeUnusedValidationCode(unknownCodeHash).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 4.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('root poke validation code not stored')

  // 4.2 Assert that nothing is stored under the hash
  expect(((await client.api.query.paras.codeByHash(unknownCodeHash)) as Option<Bytes>).isNone).toBe(true)
  expect(((await client.api.query.paras.codeByHashRefs(unknownCodeHash)) as u32).toNumber()).toBe(0)
}

/**
 * Test `paras.include_pvf_check_statement` up to a vote that accepts an upgrade's code.
 *
 * Validators submit PVF check statements as unsigned extrinsics. The test writes four of its own keys as the active
 * validators before any vote is opened, since each vote's ballots are sized to the validator set when it opens.
 * With four validators, three accepting statements reach the supermajority that accepts the code.
 *
 * Invalid statements are rejected by the runtime's unsigned transaction validation, before they can be included in a
 * block, so they are checked through the `TaggedTransactionQueue_validate_transaction` runtime API.
 *
 * 1. invalid statements
 *
 *     1.1 asserting that a statement for a past session is `Stale`
 *
 *     1.2 asserting that a statement for a future session is `Future`
 *
 *     1.3 asserting that a statement from a validator index outside the set is rejected with custom error 1
 *
 *     1.4 asserting that a statement signed by a different validator than its index names is `BadProof`
 *
 *     1.5 asserting that a statement about code with no open vote is rejected with custom error 2
 *
 * 2. the first validator accepts
 *
 *     2.1 asserting that no paras event is emitted
 *
 *     2.2 asserting that the vote stays open, with the validator's accepting ballot recorded
 *
 * 3. the first validator submits a second statement
 *
 *     3.1 asserting that a second statement, accepting or rejecting, is rejected with custom error 3
 *
 * 4. the second validator accepts
 *
 *     4.1 asserting that no paras event is emitted
 *
 *     4.2 asserting that the vote stays open, with both accepting ballots recorded
 *
 * 5. the third validator accepts, reaching the supermajority
 *
 *     5.1 asserting the `PvfCheckAccepted` event for the upgrading para
 *
 *     5.2 asserting that the vote is closed
 *
 *     5.3 asserting that the upgrade is queued for enactment at the expected block
 *
 *     5.4 asserting that the code's reference count and the para's future code hash are unchanged
 *
 *     5.5 asserting that a statement from the fourth validator is now rejected with custom error 2
 */
export async function parasIncludePvfCheckStatementAcceptE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const secondCodeHash = blake2AsHex(SECOND_VALIDATION_CODE)
  const [alice, bob, charlie, dave] = PVF_CHECK_VALIDATORS

  const activeConfig =
    (await client.api.query.configuration.activeConfig()) as PolkadotRuntimeParachainsConfigurationHostConfiguration
  const upgradeDelay = activeConfig.validationUpgradeDelay.toNumber()
  const minimumUpgradeDelay = activeConfig.minimumValidationUpgradeDelay.toNumber()

  // Make the test's keys the active validators before any vote is opened
  await client.dev.setStorage({
    ParasShared: {
      activeValidatorKeys: PVF_CHECK_VALIDATORS.map((validator) => u8aToHex(validator.publicKey)),
    },
  })

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  // Scheduling an upgrade to unknown code opens a vote for it
  const relayParent = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraId, NEW_VALIDATION_CODE, relayParent).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  let vote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(vote.causes.length).toBe(1)
  assert(vote.causes[0].isUpgrade)
  expect(vote.causes[0].asUpgrade.id.toNumber()).toBe(paraId)
  const newCodeRefsBefore = ((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()

  const currentSession = ((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()

  // 1. Invalid statements

  // 1.1 Assert that a statement for a past session is Stale
  const staleValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, alice, {
      accept: true,
      subject: newCodeHash,
      sessionIndex: currentSession - 1,
      validatorIndex: 0,
    }),
  )
  assert(staleValidity.isErr && staleValidity.asErr.isInvalid)
  expect(staleValidity.asErr.asInvalid.isStale).toBe(true)

  // 1.2 Assert that a statement for a future session is Future
  const futureValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, alice, {
      accept: true,
      subject: newCodeHash,
      sessionIndex: currentSession + 1,
      validatorIndex: 0,
    }),
  )
  assert(futureValidity.isErr && futureValidity.asErr.isInvalid)
  expect(futureValidity.asErr.asInvalid.isFuture).toBe(true)

  // 1.3 Assert that a statement from a validator index outside the set is rejected with custom error 1
  const outOfBoundsValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, alice, {
      accept: true,
      subject: newCodeHash,
      sessionIndex: currentSession,
      validatorIndex: PVF_CHECK_VALIDATORS.length,
    }),
  )
  assert(outOfBoundsValidity.isErr && outOfBoundsValidity.asErr.isInvalid)
  assert(outOfBoundsValidity.asErr.asInvalid.isCustom)
  expect(outOfBoundsValidity.asErr.asInvalid.asCustom.toNumber()).toBe(1)

  // 1.4 Assert that a statement naming the first validator but signed by the second is BadProof
  const badProofValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, bob, {
      accept: true,
      subject: newCodeHash,
      sessionIndex: currentSession,
      validatorIndex: 0,
    }),
  )
  assert(badProofValidity.isErr && badProofValidity.asErr.isInvalid)
  expect(badProofValidity.asErr.asInvalid.isBadProof).toBe(true)

  // 1.5 Assert that a statement about code with no open vote is rejected with custom error 2
  const noVoteValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, alice, {
      accept: true,
      subject: secondCodeHash,
      sessionIndex: currentSession,
      validatorIndex: 0,
    }),
  )
  assert(noVoteValidity.isErr && noVoteValidity.asErr.isInvalid)
  assert(noVoteValidity.asErr.asInvalid.isCustom)
  expect(noVoteValidity.asErr.asInvalid.asCustom.toNumber()).toBe(2)

  // 2. The first validator accepts
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, alice, {
        accept: true,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 0,
      }),
    ),
  )
  await client.dev.newBlock()

  // 2.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('first accepting pvf check statement')

  // 2.2 Assert that the vote stays open with the first validator's accepting ballot recorded. Ballots are bit fields
  // with bit `i` (least significant first) set once validator `i` has voted.
  vote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(vote.votesAccept.toU8a(true)[0]).toBe(0b0001)
  expect(vote.votesReject.toU8a(true)[0]).toBe(0b0000)

  // 3. The first validator submits a second statement

  // 3.1 Assert that a second statement, accepting or rejecting, is rejected with custom error 3
  for (const accept of [true, false]) {
    const doubleVoteValidity = await validateExtrinsic(
      client,
      pvfCheckStatementTx(client, alice, {
        accept,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 0,
      }),
    )
    assert(doubleVoteValidity.isErr && doubleVoteValidity.asErr.isInvalid)
    assert(doubleVoteValidity.asErr.asInvalid.isCustom)
    expect(doubleVoteValidity.asErr.asInvalid.asCustom.toNumber()).toBe(3)
  }

  // 4. The second validator accepts
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, bob, {
        accept: true,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 1,
      }),
    ),
  )
  await client.dev.newBlock()

  // 4.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('second accepting pvf check statement')

  // 4.2 Assert that the vote stays open, with both accepting ballots recorded
  vote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(vote.votesAccept.toU8a(true)[0]).toBe(0b0011)
  expect(vote.votesReject.toU8a(true)[0]).toBe(0b0000)

  // 5. The third validator accepts, reaching the supermajority
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, charlie, {
        accept: true,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 2,
      }),
    ),
  )
  await client.dev.newBlock()

  // The statement is included in the block just built
  const acceptedAt = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // The test must not cross a session boundary, or the statements' session index would be stale
  expect(((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()).toBe(currentSession)

  // 5.1 Assert the PvfCheckAccepted event for the upgrading para
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('third accepting pvf check statement accepts code')

  const acceptEvents = await client.api.query.system.events()
  const acceptParasEvents = acceptEvents.filter(({ event }) => event.section === 'paras')
  expect(acceptParasEvents.length).toBe(1)
  assert(client.api.events.paras.PvfCheckAccepted.is(acceptParasEvents[0].event))
  expect(acceptParasEvents[0].event.data[0].toHex()).toBe(newCodeHash)
  expect(acceptParasEvents[0].event.data[1].toString()).toBe(paraId.toString())

  // 5.2 Assert that the vote is closed
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  const voteList = ((await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>).map((hash) => hash.toHex())
  expect(voteList).not.toContain(newCodeHash)

  // 5.3 Assert that the upgrade is queued for enactment at the expected block
  const futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  const upgrades = futureUpgradesAt.filter(([id]) => id.toNumber() === paraId)
  expect(upgrades.length).toBe(1)
  expect(upgrades[0][1].toNumber()).toBe(Math.max(relayParent + upgradeDelay, acceptedAt + minimumUpgradeDelay))

  // 5.4 Assert that the code's reference count and the para's future code hash are unchanged
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(newCodeRefsBefore)
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(newCodeHash)

  // 5.5 Assert that a statement from the fourth validator is now rejected with custom error 2, as the vote is closed
  const closedVoteValidity = await validateExtrinsic(
    client,
    pvfCheckStatementTx(client, dave, {
      accept: true,
      subject: newCodeHash,
      sessionIndex: currentSession,
      validatorIndex: 3,
    }),
  )
  assert(closedVoteValidity.isErr && closedVoteValidity.asErr.isInvalid)
  assert(closedVoteValidity.asErr.asInvalid.isCustom)
  expect(closedVoteValidity.asErr.asInvalid.asCustom.toNumber()).toBe(2)
}

/**
 * Test `paras.include_pvf_check_statement` up to votes that reject code, for an upgrade and for an onboarding.
 *
 * As in the accepting test, the test's own keys are written as the four active validators before any vote is opened.
 * With four validators, two rejecting statements make a supermajority of accepting ones impossible, which rejects the
 * code.
 *
 * Registering the para opens a vote for its code, caused by its onboarding. Scheduling an upgrade to unknown code
 * opens a second vote, caused by the upgrade.
 *
 * 1. the first validator rejects the upgrade's code
 *
 *     1.1 asserting that no paras event is emitted
 *
 *     1.2 asserting that the vote stays open, with the validator's rejecting ballot recorded
 *
 * 2. the second validator rejects the upgrade's code
 *
 *     2.1 asserting the `PvfCheckRejected` event for the upgrading para
 *
 *     2.2 asserting that the vote is closed
 *
 *     2.3 asserting that the upgrade is aborted: the para's future code hash is removed and its go-ahead signal is
 *         `Abort`
 *
 *     2.4 asserting that the code loses its only reference and is removed
 *
 *     2.5 asserting that the para's current code is unchanged
 *
 * 3. the first two validators reject the onboarding's code
 *
 *     3.1 asserting that the first rejection emits no paras event
 *
 *     3.2 asserting the `PvfCheckRejected` event for the onboarding para on the second rejection
 *
 *     3.3 asserting that the vote is closed
 *
 *     3.4 asserting that the onboarding is undone: the para's genesis data, current code hash and lifecycle are removed
 *
 *     3.5 asserting that the code loses its only reference and is removed
 *
 *     3.6 asserting that the registrar keeps its entry for the para
 */
export async function parasIncludePvfCheckStatementRejectE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const oldCodeHash = blake2AsHex(MINIMAL_VALIDATION_CODE)
  const newCodeHash = blake2AsHex(NEW_VALIDATION_CODE)
  const [alice, bob] = PVF_CHECK_VALIDATORS

  // Make the test's keys the active validators before any vote is opened
  await client.dev.setStorage({
    ParasShared: {
      activeValidatorKeys: PVF_CHECK_VALIDATORS.map((validator) => u8aToHex(validator.publicKey)),
    },
  })

  // Query the next free para ID so we don't collide with an already-registered para
  const nextFreeParaId = await client.api.query.registrar.nextFreeParaId()
  const paraId = parseInt(nextFreeParaId.toString(), 10)

  // Registering the para opens a vote for its code, caused by its onboarding
  await forceRegisterParaViaRoot(client, devAccounts.alice.address, paraId)

  const onboardingVote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      oldCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(onboardingVote.causes.length).toBe(1)
  assert(onboardingVote.causes[0].isOnboarding)
  expect(onboardingVote.causes[0].asOnboarding.toNumber()).toBe(paraId)
  expect(((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()).toBe(1)

  // Scheduling an upgrade to unknown code opens a vote for it, caused by the upgrade
  const relayParent = (await client.api.rpc.chain.getHeader()).number.toNumber()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.paras.forceScheduleCodeUpgrade(paraId, NEW_VALIDATION_CODE, relayParent).method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const upgradeVote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(upgradeVote.causes.length).toBe(1)
  assert(upgradeVote.causes[0].isUpgrade)
  expect(upgradeVote.causes[0].asUpgrade.id.toNumber()).toBe(paraId)
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(1)

  const currentSession = ((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()

  // 1. The first validator rejects the upgrade's code
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, alice, {
        accept: false,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 0,
      }),
    ),
  )
  await client.dev.newBlock()

  // 1.1 Assert that no paras event is emitted
  await checkSystemEvents(client, 'paras').toMatchSnapshot('first rejecting pvf check statement on upgrade code')

  // 1.2 Assert that the vote stays open with the first validator's rejecting ballot recorded. Ballots are bit fields
  // with bit `i` (least significant first) set once validator `i` has voted.
  const openUpgradeVote = (
    (await client.api.query.paras.pvfActiveVoteMap(
      newCodeHash,
    )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
  ).unwrap()
  expect(openUpgradeVote.votesReject.toU8a(true)[0]).toBe(0b0001)
  expect(openUpgradeVote.votesAccept.toU8a(true)[0]).toBe(0b0000)

  // 2. The second validator rejects the upgrade's code
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, bob, {
        accept: false,
        subject: newCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 1,
      }),
    ),
  )
  await client.dev.newBlock()

  // 2.1 Assert the PvfCheckRejected event for the upgrading para
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('second rejecting pvf check statement rejects upgrade code')

  const upgradeRejectEvents = await client.api.query.system.events()
  const upgradeRejectParasEvents = upgradeRejectEvents.filter(({ event }) => event.section === 'paras')
  expect(upgradeRejectParasEvents.length).toBe(1)
  assert(client.api.events.paras.PvfCheckRejected.is(upgradeRejectParasEvents[0].event))
  expect(upgradeRejectParasEvents[0].event.data[0].toHex()).toBe(newCodeHash)
  expect(upgradeRejectParasEvents[0].event.data[1].toString()).toBe(paraId.toString())

  // 2.2 Assert that the vote is closed
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        newCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  let voteList = ((await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>).map((hash) => hash.toHex())
  expect(voteList).not.toContain(newCodeHash)

  // 2.3 Assert that the upgrade is aborted
  expect(((await client.api.query.paras.futureCodeHash(paraId)) as Option<H256>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.upgradeGoAheadSignal(paraId)) as Option<PolkadotPrimitivesV8UpgradeGoAhead>).unwrap()
      .isAbort,
  ).toBe(true)
  const futureUpgradesAt = (await client.api.query.paras.futureCodeUpgradesAt()) as Vec<ITuple<[u32, u32]>>
  expect(futureUpgradesAt.filter(([id]) => id.toNumber() === paraId).length).toBe(0)

  // 2.4 Assert that the code loses its only reference and is removed
  expect(((await client.api.query.paras.codeByHashRefs(newCodeHash)) as u32).toNumber()).toBe(0)
  expect(((await client.api.query.paras.codeByHash(newCodeHash)) as Option<Bytes>).isNone).toBe(true)

  // 2.5 Assert that the current code is unchanged
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).unwrap().toHex()).toBe(oldCodeHash)

  // 3. The first two validators reject the onboarding's code
  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, alice, {
        accept: false,
        subject: oldCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 0,
      }),
    ),
  )
  await client.dev.newBlock()

  // 3.1 Assert that the first rejection emits no paras event
  await checkSystemEvents(client, 'paras').toMatchSnapshot('first rejecting pvf check statement on onboarding code')

  await sendTransaction(
    Promise.resolve(
      pvfCheckStatementTx(client, bob, {
        accept: false,
        subject: oldCodeHash,
        sessionIndex: currentSession,
        validatorIndex: 1,
      }),
    ),
  )
  await client.dev.newBlock()

  // The test must not cross a session boundary, or the statements' session index would be stale
  expect(((await client.api.query.parasShared.currentSessionIndex()) as u32).toNumber()).toBe(currentSession)

  // 3.2 Assert the PvfCheckRejected event for the onboarding para
  await checkSystemEvents(client, 'paras')
    .redact({ number: true })
    .toMatchSnapshot('second rejecting pvf check statement rejects onboarding code')

  const onboardingRejectEvents = await client.api.query.system.events()
  const onboardingRejectParasEvents = onboardingRejectEvents.filter(({ event }) => event.section === 'paras')
  expect(onboardingRejectParasEvents.length).toBe(1)
  assert(client.api.events.paras.PvfCheckRejected.is(onboardingRejectParasEvents[0].event))
  expect(onboardingRejectParasEvents[0].event.data[0].toHex()).toBe(oldCodeHash)
  expect(onboardingRejectParasEvents[0].event.data[1].toString()).toBe(paraId.toString())

  // 3.3 Assert that the vote is closed
  expect(
    (
      (await client.api.query.paras.pvfActiveVoteMap(
        oldCodeHash,
      )) as Option<PolkadotRuntimeParachainsParasPvfCheckActiveVoteState>
    ).isNone,
  ).toBe(true)
  voteList = ((await client.api.query.paras.pvfActiveVoteList()) as Vec<H256>).map((hash) => hash.toHex())
  expect(voteList).not.toContain(oldCodeHash)

  // 3.4 Assert that the onboarding is undone
  expect(
    (
      (await client.api.query.paras.upcomingParasGenesis(
        paraId,
      )) as Option<PolkadotRuntimeParachainsParasParaGenesisArgs>
    ).isNone,
  ).toBe(true)
  expect(((await client.api.query.paras.currentCodeHash(paraId)) as Option<H256>).isNone).toBe(true)
  expect(
    ((await client.api.query.paras.paraLifecycles(paraId)) as Option<PolkadotRuntimeParachainsParasParaLifecycle>)
      .isNone,
  ).toBe(true)

  // 3.5 Assert that the code loses its only reference and is removed
  expect(((await client.api.query.paras.codeByHashRefs(oldCodeHash)) as u32).toNumber()).toBe(0)
  expect(((await client.api.query.paras.codeByHash(oldCodeHash)) as Option<Bytes>).isNone).toBe(true)

  // 3.6 Assert that the registrar keeps its entry for the para; rejecting the code only undoes the paras pallet's state
  expect(
    ((await client.api.query.registrar.paras(paraId)) as Option<PolkadotRuntimeCommonParasRegistrarParaInfo>).isSome,
  ).toBe(true)
}

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
      },
      {
        kind: 'test',
        label: 'pallet paras - force note new head with pending upgrade',
        testFn: async () => await parasForceNoteNewHeadWithUpgradeE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - force queue action',
        testFn: async () => await parasForceQueueActionE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - add trusted validation code',
        testFn: async () => await parasAddTrustedValidationCodeE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - poke unused validation code',
        testFn: async () => await parasPokeUnusedValidationCodeE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - include pvf check statement accepting code',
        testFn: async () => await parasIncludePvfCheckStatementAcceptE2ETest(client),
      },
      {
        kind: 'test',
        label: 'pallet paras - include pvf check statement rejecting code',
        testFn: async () => await parasIncludePvfCheckStatementRejectE2ETest(client),
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
