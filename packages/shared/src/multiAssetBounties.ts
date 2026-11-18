/**
 * E2E tests for `pallet-multi-asset-bounties`.
 *
 * The pallet funds bounties in any asset the treasury holds and the `AssetRate` pallet can price
 * in the native token. Each bounty gets its own account, derived from the treasury's pallet id,
 * and the treasury pays the bounty's value into that account when the bounty is funded. A curator
 * then pays the value out to a beneficiary, splits part of it into child bounties, or closes the
 * bounty so the value returns to the treasury.
 *
 * Payments go through `LocalPay`, which transfers at once and always reports success. Every
 * funding, payout and refund therefore completes inside the call that starts it, and leaves the
 * bounty in a `*Attempted` state until a `check_status` call confirms the payment. The tests make
 * that second call explicitly.
 *
 * Origins:
 * - `fund_bounty`, and `propose_curator` on a parent bounty, take the treasury's spend origin: Root
 *   or a spender track, each capped at a native amount that the bounty value is converted to first.
 * - `unassign_curator` and `close_bounty` accept the reject origin (Root or `Treasurer`), as well
 *   as the curator.
 * - `check_status` and `retry_payment` accept any signed account. Every other call is signed, and
 *   checked against the bounty's curator or its parent's curator.
 *
 * Privileged origins are injected through the scheduler. The pallet has no block-number logic, so
 * no test moves time. Bounty indices and bounty accounts depend on how many bounties the live
 * chain has created, so snapshots redact the index and keep events that name bounty accounts out.
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { SpRuntimeDispatchError } from '@polkadot/types/lookup'
import { bnToU8a, stringToHex, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect, type TestContext } from 'vitest'

import {
  checkSystemEvents,
  nextSchedulableBlockNum,
  scheduleInlineCallWithOrigin,
  scheduleLookupCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'

/// -------
/// Constants
/// -------

/**
 * Value of the parent bounties most tests create, as a multiple of `BountyValueMinimum`.
 *
 * Three times the minimum keeps the curator deposit strictly between its floor and its cap on
 * every chain the suite runs on, so the deposit formula is exercised rather than a bound, and keeps
 * the value within the `SmallTipper` spend limit.
 */
const PARENT_VALUE_MULTIPLE = 3n

/**
 * Native balance given to every signer, as a multiple of `BountyValueMinimum`. Covers the largest
 * curator deposit, which the runtimes cap well below this, plus transaction fees.
 */
const ENDOWMENT_MULTIPLE = 1_000n

/** `FixedU128` representation of 1, the scale of `AssetRate` conversion rates. */
const RATE_ONE = 10n ** 18n

/** `Permill` representation of 100%. */
const PERMILL_ONE = 1_000_000n

/**
 * Payment id `LocalPay` returns for every payment. It pays at once, so the id is never needed to
 * find a payment again.
 */
const LOCAL_PAY_ID = 2n ** 64n - 1n

/** Index of the trust-backed `Assets` pallet on every Asset Hub, as asset locations name it. */
const ASSETS_PALLET_INSTANCE = 50

/**
 * Bounty description, noted as a preimage before every test. `fund_bounty` and
 * `fund_child_bounty` take only its hash, and reject a hash with no noted preimage.
 */
const METADATA = stringToHex('multi-asset bounties e2e')
const METADATA_HASH = blake2AsHex(METADATA, 256)

/** Origins injected through the scheduler. */
const ROOT = { system: 'Root' }
const TREASURER = { Origins: 'Treasurer' }
const SMALL_TIPPER = { Origins: 'SmallTipper' }

/**
 * Roles of the test accounts:
 * - alice curates parent bounties;
 * - bob is the beneficiary of every payout;
 * - charlie curates child bounties, or takes over a parent bounty;
 * - dave holds no role, and settles payments with `check_status`;
 * - eve is a curator who cannot afford the deposit.
 */
const { alice, bob, charlie, dave, eve } = testAccounts
const SIGNERS = [alice, bob, charlie, dave]

/// -------
/// Test configuration
/// -------

/**
 * An asset a bounty can be denominated in, and the pallet that holds its balances.
 *
 * `LocalPay` only pays assets held on this chain, so every bounty asset is located `Here`.
 */
export type BountyAsset =
  | { symbol: string; pallet: 'balances' }
  | { symbol: string; pallet: 'assets'; id: number }
  | { symbol: string; pallet: 'foreignAssets'; location: Record<string, any> }

/**
 * Multi-asset bounty test parameters.
 *
 * Values not exposed in metadata (spend limits and curator deposit parameters) are runtime
 * configuration. Each network file cites where it read them.
 */
export interface MultiAssetBountiesTestConfig extends TestConfig {
  /**
   * Asset of the lifecycle tests. It must be native or have an `AssetRate` entry, and the
   * treasury must hold at least a few bounties' worth of it.
   */
  primaryAsset: BountyAsset
  /**
   * A second fundable asset, priced through `AssetRate`. Leave it out on chains with no second
   * priced asset in the treasury; the tests that need it then skip.
   */
  secondaryAsset?: BountyAsset
  /** An asset with no `AssetRate` entry, so its value cannot be converted to native. */
  unratedAsset: BountyAsset
  /** Native spend limit of the `SmallTipper` track. */
  smallTipperLimit: bigint
  /**
   * Curator deposit: `multiplier` (parts per million) of the bounty's native value, clamped to
   * `[min, max]`.
   */
  curatorDeposit: { multiplier: bigint; min: bigint; max: bigint }
  /**
   * Whether closing a parent bounty refunds its value minus the value already paid out to child
   * bounties. When false, the runtime asks for the full value, which the bounty account no longer
   * holds, and the close fails with `RefundError`.
   */
  parentRefundNetOfChildren: boolean
}

/// -------
/// Helpers
/// -------

/**
 * The pallet's extrinsics, storage and constants. The installed `@polkadot/api-augment` predates
 * the pallet, so these are untyped.
 */
const bountiesTx = (client: Client<any, any>) => (client.api.tx as any).multiAssetBounties
const bountiesQuery = (client: Client<any, any>) => (client.api.query as any).multiAssetBounties
const bountiesConsts = (client: Client<any, any>) => (client.api.consts as any).multiAssetBounties

/** Smallest native value a parent bounty may have. */
const bountyMinimum = (client: Client<any, any>): bigint => bountiesConsts(client).bountyValueMinimum.toBigInt()

/** Smallest native value a child bounty may have. */
const childBountyMinimum = (client: Client<any, any>): bigint =>
  bountiesConsts(client).childBountyValueMinimum.toBigInt()

/** `who`'s address in the chain's SS58 format, as storage and events render it. */
function addressOf(client: Client<any, any>, who: KeyringPair | string): string {
  return encodeAddress(typeof who === 'string' ? who : who.address, client.config.properties.addressEncoding)
}

/** The treasury pot, which funds every bounty and receives every refund. */
function treasuryPot(client: Client<any, any>): string {
  return client.api.consts.treasury.potAccount.toString()
}

/**
 * Account holding a bounty's funds.
 *
 * Mirrors the runtime's derivation: the treasury's pallet id as a sub-account, with the prefix
 * `mbt` and the bounty index for a parent, or `mcb`, the parent index and the child index for a
 * child bounty, padded with zeroes to 32 bytes.
 */
function bountyAccount(client: Client<any, any>, index: number, childIndex?: number): string {
  const palletId = client.api.consts.treasury.palletId.toU8a()
  const sub =
    childIndex === undefined
      ? u8aConcat(stringToU8a('mbt'), bnToU8a(index, { bitLength: 32 }))
      : u8aConcat(stringToU8a('mcb'), bnToU8a(index, { bitLength: 32 }), bnToU8a(childIndex, { bitLength: 32 }))
  const raw = u8aConcat(stringToU8a('modl'), palletId, sub, new Uint8Array(32)).slice(0, 32)
  return encodeAddress(raw, client.config.properties.addressEncoding)
}

/** The asset's id as an XCM location relative to this chain. */
function assetIdOf(asset: BountyAsset): Record<string, any> {
  switch (asset.pallet) {
    case 'balances':
      return { parents: 1, interior: 'Here' }
    case 'assets':
      return { parents: 0, interior: { X2: [{ PalletInstance: ASSETS_PALLET_INSTANCE }, { GeneralIndex: asset.id }] } }
    case 'foreignAssets':
      return asset.location
  }
}

/**
 * The `asset_kind` naming `asset` in calls and storage. `LocalPay` pays only from this chain, and
 * `AssetRate` keys its rates by the exact versioned value, so this always uses V5 located `Here`.
 */
function assetKind(asset: BountyAsset) {
  return { V5: { location: { parents: 0, interior: 'Here' }, assetId: assetIdOf(asset) } }
}

/** A payout target: `who`'s account on this chain. */
function localBeneficiary(who: KeyringPair) {
  return {
    V5: {
      location: { parents: 0, interior: 'Here' },
      accountId: { parents: 0, interior: { X1: [{ AccountId32: { network: null, id: who.addressRaw } }] } },
    },
  }
}

/** `who`'s spendable balance of `asset`. For the native token this is the free balance. */
async function balanceOf(client: Client<any, any>, asset: BountyAsset, who: string): Promise<bigint> {
  switch (asset.pallet) {
    case 'balances':
      return (await client.api.query.system.account(who)).data.free.toBigInt()
    case 'assets': {
      const entry = await client.api.query.assets.account(asset.id, who)
      return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
    }
    case 'foreignAssets': {
      const entry = (await client.api.query.foreignAssets.account(asset.location as any, who)) as any
      return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
    }
  }
}

/**
 * How many native units one unit of `asset` is worth, scaled by `RATE_ONE`. The native token
 * converts one to one; any other asset needs an `AssetRate` entry, which this asserts.
 */
async function rateOf(client: Client<any, any>, asset: BountyAsset): Promise<bigint> {
  if (asset.pallet === 'balances') {
    return RATE_ONE
  }
  const rate = (await client.api.query.assetRate.conversionRateToNative(assetKind(asset) as any)) as any
  assert(rate.isSome, `no AssetRate for ${asset.symbol}`)
  return rate.unwrap().toBigInt()
}

/** Native value of `amount` units at `rate`, rounded down as the runtime's converter does. */
function toNative(amount: bigint, rate: bigint): bigint {
  return (amount * rate) / RATE_ONE
}

/** Smallest amount of an asset at `rate` whose native value is at least `native`. */
function fromNative(native: bigint, rate: bigint): bigint {
  return (native * RATE_ONE + rate - 1n) / rate
}

/** Value, in `asset` units, of the parent bounties most tests create. */
async function parentValue(client: Client<any, any>, asset: BountyAsset): Promise<bigint> {
  return fromNative(PARENT_VALUE_MULTIPLE * bountyMinimum(client), await rateOf(client, asset))
}

/** Curator deposit the runtime takes for a bounty worth `native`. */
function curatorDepositFor(testConfig: MultiAssetBountiesTestConfig, native: bigint): bigint {
  const { multiplier, min, max } = testConfig.curatorDeposit
  const deposit = (native * multiplier) / PERMILL_ONE
  return deposit < min ? min : deposit > max ? max : deposit
}

/** Balance `who` has on hold as curator deposits, across all of their bounties. */
async function curatorHold(client: Client<any, any>, who: KeyringPair): Promise<bigint> {
  const holds = await client.api.query.balances.holds(who.address)
  const entry = holds.find((hold) => (hold.id.toJSON() as any)?.multiAssetBounties === 'CuratorDeposit')
  return entry ? entry.amount.toBigInt() : 0n
}

/** Stored bounty `index`, asserting it exists. */
async function getBounty(client: Client<any, any>, index: number) {
  const bounty = await bountiesQuery(client).bounties(index)
  assert(bounty.isSome, `bounty ${index} does not exist`)
  return bounty.unwrap()
}

/** Index the next funded bounty will get. */
async function nextBountyIndex(client: Client<any, any>): Promise<number> {
  return (await bountiesQuery(client).bountyCount()).toNumber()
}

/**
 * The pallet event `method` about bounty `index` in the latest block.
 *
 * Fails if the runtime has no such event, so a renamed variant cannot pass unnoticed.
 */
async function bountyEvent(client: Client<any, any>, method: string, index: number): Promise<any> {
  const type = (client.api.events as any).multiAssetBounties[method]
  assert(type, `runtime has no multiAssetBounties.${method} event`)
  const events = await client.api.query.system.events()
  const record = events.find(({ event }) => type.is(event) && (event.data as any).index.toNumber() === index)
  assert(record, `no multiAssetBounties.${method} for bounty ${index}`)
  return record.event
}

/**
 * Dispatch `call` from `origin` through the scheduler in a new block, and return the dispatch
 * result.
 *
 * The scheduler drops inline calls above 128 bytes without a trace, so this refuses them; larger
 * calls go through `notePreimage` and a lookup instead.
 */
async function dispatchAs(client: Client<any, any>, call: any, origin: object) {
  assert(call.method.encodedLength <= 128, `call is ${call.method.encodedLength} bytes, too long to schedule inline`)
  const provider = client.config.properties.schedulerBlockProvider
  const when = await nextSchedulableBlockNum(client.api, provider)
  await scheduleInlineCallWithOrigin(client, call.method.toHex(), origin, provider)
  await client.dev.newBlock()
  return dispatchResultAt(client, when)
}

/**
 * Result of the call the suite scheduled for agenda block `when`. The suite schedules one call
 * per block, so it is the first task of that agenda.
 */
async function dispatchResultAt(client: Client<any, any>, when: number) {
  const events = await client.api.query.system.events()
  const record = events.find(({ event }) => {
    if (!client.api.events.scheduler.Dispatched.is(event)) return false
    const [block, position] = event.data.task
    return block.toNumber() === when && position.toNumber() === 0
  })
  assert(record, `the scheduler did not dispatch the call scheduled for ${when}`)
  assert(client.api.events.scheduler.Dispatched.is(record.event))
  return record.event.data.result
}

/** Assert a scheduled call succeeded. */
function expectDispatchOk(result: any) {
  expect(result.isOk, `scheduled call failed: ${JSON.stringify(result.toHuman())}`).toBe(true)
}

/**
 * Assert `error` is the pallet error `name`. The name is looked up in the runtime's metadata, so a
 * renamed or removed variant fails the test rather than matching nothing.
 */
function expectBountyError(client: Client<any, any>, error: SpRuntimeDispatchError, name: string) {
  assert(error.isModule, `expected a module error, got ${JSON.stringify(error.toHuman())}`)
  const variant = (client.api.errors as any).multiAssetBounties[name]
  assert(variant, `runtime has no multiAssetBounties error named ${name}`)
  expect(variant.is(error.asModule), `expected ${name}, got ${JSON.stringify(error.toHuman())}`).toBe(true)
}

/** The dispatch error of the only failed extrinsic in the latest block. */
async function extrinsicError(client: Client<any, any>): Promise<SpRuntimeDispatchError> {
  const events = await client.api.query.system.events()
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures).toHaveLength(1)
  const { event } = failures[0]
  assert(client.api.events.system.ExtrinsicFailed.is(event))
  return event.data.dispatchError
}

/** Assert no extrinsic failed in the latest block. `sendTransaction` resolves even when dispatch fails. */
async function expectNoExtrinsicFailure(client: Client<any, any>) {
  const events = await client.api.query.system.events()
  const failures = events.filter(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  expect(failures.map(({ event }) => event.toHuman())).toEqual([])
}

/**
 * Events a step snapshot keeps: the pallet's own, plus the outcome of the step's dispatch, so a
 * failed step never records as an empty list.
 */
const BOUNTY_EVENTS = [
  'multiAssetBounties',
  { section: 'scheduler', method: 'Dispatched' },
  { section: 'system', method: 'ExtrinsicFailed' },
] as const

/**
 * `BOUNTY_EVENTS` plus balance holds, for steps that take, release or burn a curator deposit.
 * Steps that empty a bounty account leave these out: the account's removal releases an empty
 * hold whose event names the account, and the account depends on the live bounty count.
 */
const DEPOSIT_EVENTS = [
  ...BOUNTY_EVENTS,
  { section: 'balances', method: 'Held' },
  { section: 'balances', method: 'Released' },
  { section: 'balances', method: 'BurnedHeld' },
] as const

/**
 * Snapshot transform replacing the bounty index in the pallet's own events, since it depends on
 * how many bounties the live chain has. Other `index` fields, such as the pallet index inside a
 * module error, are kept.
 */
function redactBountyIndex(events: any[]) {
  return events.map((event) =>
    event.section === 'multiAssetBounties' ? { ...event, data: { ...event.data, index: '(bounty index)' } } : event,
  )
}

/** Snapshot redaction of a scheduled task's agenda block, which follows the live relay chain. */
const VOLATILE_KEYS = { redactKeys: /^task$/ }

/**
 * `VOLATILE_KEYS`, plus the amounts in the events of a bounty in `asset`. For steps whose events
 * carry the bounty's value or a curator deposit computed from it.
 *
 * For an asset priced through `AssetRate`, both follow the asset's live rate, so a rate update
 * would change the snapshot of a correct run. They are redacted there, and the test asserts each
 * of them exactly against the rate it read. A native bounty's amounts come from chain constants
 * alone, and stay in the snapshot.
 */
function volatileKeysWithAmounts(asset: BountyAsset) {
  return asset.pallet === 'balances' ? VOLATILE_KEYS : { redactKeys: /^(task|value|oldValue|newValue|amount)$/ }
}

/**
 * Fund a bounty as `Treasurer`, and return its index as `BountyCreated` reports it. The bounty
 * is left `FundingAttempted`, with `curator` proposed.
 */
async function fundBounty(
  client: Client<any, any>,
  asset: BountyAsset,
  value: bigint,
  curator: KeyringPair,
): Promise<number> {
  const index = await nextBountyIndex(client)
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, curator.address, METADATA_HASH)
  expectDispatchOk(await dispatchAs(client, call, TREASURER))
  const created = await bountyEvent(client, 'BountyCreated', index)
  return created.data.index.toNumber()
}

/** Fund a bounty and settle the funding, leaving it `Funded` with `curator` proposed. */
async function fundedBounty(
  client: Client<any, any>,
  asset: BountyAsset,
  value: bigint,
  curator: KeyringPair,
): Promise<number> {
  const index = await fundBounty(client, asset, value, curator)
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  return index
}

/**
 * Fund a bounty and have `curator` settle the funding and accept in one batch, leaving it `Active`
 * with the curator's deposit on hold.
 */
async function activeBounty(
  client: Client<any, any>,
  asset: BountyAsset,
  value: bigint,
  curator: KeyringPair,
): Promise<number> {
  const index = await fundBounty(client, asset, value, curator)
  const settleAndAccept = client.api.tx.utility.batchAll([
    bountiesTx(client).checkStatus(index, null),
    bountiesTx(client).acceptCurator(index, null),
  ])
  await sendTransaction(settleAndAccept.signAsync(curator))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  return index
}

/** Value, in `asset` units, of the child bounties tests create: the smallest a child may have. */
async function childValue(client: Client<any, any>, asset: BountyAsset): Promise<bigint> {
  return fromNative(childBountyMinimum(client), await rateOf(client, asset))
}

/**
 * Fund a child bounty of `parent` as the parent's curator, alice, and return its index as
 * `ChildBountyCreated` reports it. With no `curator`, alice curates the child as well.
 */
async function fundChildBounty(
  client: Client<any, any>,
  parent: number,
  value: bigint,
  curator: KeyringPair | null,
): Promise<number> {
  const call = bountiesTx(client).fundChildBounty(parent, value, METADATA_HASH, curator?.address ?? null)
  await sendTransaction(call.signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  const created = await bountyEvent(client, 'ChildBountyCreated', parent)
  return created.data.childIndex.toNumber()
}

/**
 * Fund a child bounty curated by the parent's curator, alice, and settle the funding. A child
 * whose curator already curates the parent goes straight to `Active`, with no deposit.
 */
async function childOfParentCurator(client: Client<any, any>, parent: number, value: bigint): Promise<number> {
  const child = await fundChildBounty(client, parent, value, null)
  await sendTransaction(bountiesTx(client).checkStatus(parent, child).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  return child
}

/**
 * Fund a child bounty proposing `curator`, who settles the funding and accepts in one batch,
 * leaving the child `Active` with the curator's deposit on hold.
 */
async function childWithOwnCurator(
  client: Client<any, any>,
  parent: number,
  value: bigint,
  curator: KeyringPair,
): Promise<number> {
  const child = await fundChildBounty(client, parent, value, curator)
  const settleAndAccept = client.api.tx.utility.batchAll([
    bountiesTx(client).checkStatus(parent, child),
    bountiesTx(client).acceptCurator(parent, child),
  ])
  await sendTransaction(settleAndAccept.signAsync(curator))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  return child
}

/**
 * The `balances` event `method` naming `who` in the latest block. The installed type augmentation
 * lacks the hold events, so they are looked up by name, and a missing one fails the test.
 */
async function balancesEvent(client: Client<any, any>, method: string, who: KeyringPair): Promise<any> {
  const type = (client.api.events as any).balances[method]
  assert(type, `runtime has no balances.${method} event`)
  const events = await client.api.query.system.events()
  const records = events.filter(
    ({ event }) => type.is(event) && (event.data as any).who.toString() === addressOf(client, who),
  )
  expect(records).toHaveLength(1)
  return records[0].event
}

/**
 * Native tokens the treasury inflation pallet (`dap`) minted in the latest block. Zero on chains
 * without it.
 */
async function mintedInLatestBlock(client: Client<any, any>): Promise<bigint> {
  const issuanceMinted = (client.api.events as any).dap?.IssuanceMinted
  if (!issuanceMinted) {
    return 0n
  }
  const events = await client.api.query.system.events()
  return events
    .filter(({ event }) => issuanceMinted.is(event))
    .reduce((sum, { event }) => sum + (event.data[0] as any).toBigInt(), 0n)
}

/** Assert `beneficiary` names `who`'s account on this chain. */
function expectLocalBeneficiary(beneficiary: any, who: KeyringPair) {
  assert(beneficiary.isV5, `expected a V5 beneficiary, got ${beneficiary.type}`)
  const { location, accountId } = beneficiary.asV5
  expect(location.parents.toNumber()).toBe(0)
  expect(location.interior.isHere).toBe(true)
  expect(accountId.interior.asX1[0].asAccountId32.id.toHex()).toBe(u8aToHex(who.addressRaw))
}

/**
 * One-off setup shared by every test: endow the signers with native tokens, and note the bounty
 * metadata. It runs before the suite's snapshot is taken, so no test spends a block on it.
 */
async function prepareSuite(client: Client<any, any>) {
  const endowment = ENDOWMENT_MULTIPLE * bountyMinimum(client)
  await client.dev.setStorage({
    System: {
      account: SIGNERS.map((who) => [[who.address], { providers: 1, data: { free: endowment } }]),
    },
  })
  await sendTransaction(client.api.tx.preimage.notePreimage(METADATA).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
}

/// -------
/// Funding
/// -------

/**
 * Funding a bounty moves its value from the treasury pot to the bounty's own account at once.
 *
 * `LocalPay` pays synchronously, so the transfer happens inside `fund_bounty`. The bounty then
 * waits in `FundingAttempted` only until a `check_status` call confirms the payment.
 *
 * 1. Fund a bounty as `Treasurer`, proposing alice as curator
 * 2. Verify the call dispatched, and `Paid` and `BountyCreated` name the new bounty
 * 3. Verify the treasury lost exactly the value and the bounty account gained it
 * 4. Verify the bounty is stored as `FundingAttempted`, with the curator and the payment id
 * 5. Verify the metadata preimage is now requested, so it cannot be removed while the bounty lives
 */
async function fundBountyMovesFunds(client: Client<any, any>, asset: BountyAsset) {
  const value = await parentValue(client, asset)
  const index = await nextBountyIndex(client)
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))
  const accountBefore = await balanceOf(client, asset, bountyAccount(client, index))
  expect(treasuryBefore).toBeGreaterThan(value)

  // 1. Fund as Treasurer
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, TREASURER)

  // 2. Dispatched, with Paid and BountyCreated
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot(`fund bounty in ${asset.symbol}: events`)
  expectDispatchOk(result)
  const paid = await bountyEvent(client, 'Paid', index)
  expect(paid.data.childIndex.isNone).toBe(true)
  expect(paid.data.paymentId.toBigInt()).toBe(LOCAL_PAY_ID)
  await bountyEvent(client, 'BountyCreated', index)

  // 3. Funds moved from the treasury to the bounty account
  expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore - value)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(accountBefore + value)

  // 4. Stored as FundingAttempted
  const bounty = await getBounty(client, index)
  expect(bounty.value.toBigInt()).toBe(value)
  expect(bounty.metadata.toHex()).toBe(METADATA_HASH)
  assert(bounty.status.isFundingAttempted)
  const { curator, paymentStatus } = bounty.status.asFundingAttempted
  expect(curator.toString()).toBe(addressOf(client, alice))
  assert(paymentStatus.isAttempted)
  expect(paymentStatus.asAttempted.id.toBigInt()).toBe(LOCAL_PAY_ID)
  expect(await nextBountyIndex(client)).toBe(index + 1)

  // 5. Metadata preimage requested
  const request = await client.api.query.preimage.requestStatusFor(METADATA_HASH)
  expect(request.unwrap().isRequested).toBe(true)
}

/**
 * The `SmallTipper` track may fund a bounty worth up to its spend limit, measured in native value
 * after conversion.
 *
 * The value funded is the largest the limit admits. For the native asset that is the limit itself.
 * For a priced asset the limit need not be a whole number of asset units, so it is the last value
 * whose native worth, rounded down, still fits.
 *
 * 1. Fund a bounty of the largest value within the track's limit as `SmallTipper`
 * 2. Verify the call dispatched and created the bounty with that value
 */
async function fundAtSmallTipperLimit(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const value = fromNative(testConfig.smallTipperLimit + 1n, rate) - 1n
  expect(toNative(value, rate)).toBeLessThanOrEqual(testConfig.smallTipperLimit)
  expect(toNative(value + 1n, rate)).toBeGreaterThan(testConfig.smallTipperLimit)
  const index = await nextBountyIndex(client)

  // 1. Fund at the limit as SmallTipper
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, SMALL_TIPPER)

  // 2. Bounty created
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund at SmallTipper limit: events')
  expectDispatchOk(result)
  await bountyEvent(client, 'BountyCreated', index)
  expect((await getBounty(client, index)).value.toBigInt()).toBe(value)
}

/**
 * One unit above the largest value the `SmallTipper` limit admits, the track may not fund the
 * bounty.
 *
 * 1. Fund a bounty of the smallest value whose native worth exceeds the track's limit as
 *    `SmallTipper`
 * 2. Verify the call failed with `InsufficientPermission`
 * 3. Verify no bounty was created and the treasury kept its funds
 */
async function fundAboveSmallTipperLimitFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const value = fromNative(testConfig.smallTipperLimit + 1n, rate)
  expect(toNative(value, rate)).toBeGreaterThan(testConfig.smallTipperLimit)
  expect(toNative(value - 1n, rate)).toBeLessThanOrEqual(testConfig.smallTipperLimit)
  const index = await nextBountyIndex(client)
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))

  // 1. Fund above the limit as SmallTipper
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, SMALL_TIPPER)

  // 2. InsufficientPermission
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund above SmallTipper limit: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'InsufficientPermission')

  // 3. Nothing created or moved
  expect(await nextBountyIndex(client)).toBe(index)
  expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore)
}

/**
 * A spend limit caps the total funded within one dispatch, not each call: two bounties that each
 * fit the `SmallTipper` limit cannot be funded together in one batch when their sum does not.
 *
 * 1. Note a batch of two such fundings as a preimage, since it is too long to schedule inline
 * 2. Dispatch the batch as `SmallTipper`
 * 3. Verify the batch failed with `InsufficientPermission`, and neither bounty was created
 */
async function batchedFundsShareSmallTipperLimit(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const limit = testConfig.smallTipperLimit
  const value = fromNative((limit * 3n) / 5n, rate)
  expect(toNative(value, rate)).toBeLessThanOrEqual(limit)
  expect(2n * toNative(value, rate)).toBeGreaterThan(limit)
  const index = await nextBountyIndex(client)

  const fund = (curator: KeyringPair) =>
    bountiesTx(client).fundBounty(assetKind(asset), value, curator.address, METADATA_HASH)
  const batch = client.api.tx.utility.batchAll([fund(alice), fund(charlie)])
  const encoded = batch.method.toHex()

  // 1. Note the batch
  await sendTransaction(client.api.tx.preimage.notePreimage(encoded).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 2. Dispatch it as SmallTipper
  const provider = client.config.properties.schedulerBlockProvider
  const when = await nextSchedulableBlockNum(client.api, provider)
  await scheduleLookupCallWithOrigin(
    client,
    { hash: blake2AsHex(encoded, 256), len: batch.method.encodedLength },
    SMALL_TIPPER,
    provider,
  )
  await client.dev.newBlock()
  const result = await dispatchResultAt(client, when)

  // 3. InsufficientPermission, nothing created
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('batched funds over SmallTipper limit: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'InsufficientPermission')
  expect(await nextBountyIndex(client)).toBe(index)
}

/**
 * Only the treasury's spend origin may fund a bounty. A signed account is refused, however much
 * it holds.
 *
 * 1. Fund a bounty from alice's signed origin
 * 2. Verify the extrinsic failed with `BadOrigin`
 */
async function fundAsSignedFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)

  // 1. Fund as a signed account
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  await sendTransaction(call.signAsync(alice))
  await client.dev.newBlock()

  // 2. BadOrigin
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund as signed: events')
  expect((await extrinsicError(client)).isBadOrigin).toBe(true)
}

/**
 * A bounty must be worth at least `BountyValueMinimum` in native value.
 *
 * 1. Fund a bounty one unit below the minimum as `Treasurer`
 * 2. Verify the call failed with `InvalidValue`
 */
async function fundBelowMinimumFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const value = fromNative(bountyMinimum(client), rate) - 1n
  expect(toNative(value, rate)).toBeLessThan(bountyMinimum(client))

  // 1. Fund below the minimum
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, TREASURER)

  // 2. InvalidValue
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund below minimum: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'InvalidValue')
}

/**
 * A bounty's metadata hash must have a noted preimage, so its description can always be read.
 *
 * 1. Fund a bounty whose metadata hash has no preimage as `Treasurer`
 * 2. Verify the call failed with `PreimageNotExist`
 */
async function fundWithUnnotedMetadataFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const unnoted = blake2AsHex(stringToHex('a description nobody noted'), 256)
  expect((await client.api.query.preimage.requestStatusFor(unnoted)).isNone).toBe(true)

  // 1. Fund with an unnoted hash
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, unnoted)
  const result = await dispatchAs(client, call, TREASURER)

  // 2. PreimageNotExist
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund with unnoted metadata: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'PreimageNotExist')
}

/**
 * Spend limits and the value minimum are native amounts, so an asset that `AssetRate` cannot price
 * cannot fund a bounty.
 *
 * 1. Fund a bounty in an asset with no rate as `Treasurer`
 * 2. Verify the call failed with `FailedToConvertBalance`
 */
async function fundInUnratedAssetFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const kind = assetKind(testConfig.unratedAsset)
  expect(((await client.api.query.assetRate.conversionRateToNative(kind as any)) as any).isNone).toBe(true)

  // 1. Fund in the unrated asset
  const value = PARENT_VALUE_MULTIPLE * bountyMinimum(client)
  const call = bountiesTx(client).fundBounty(kind, value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, TREASURER)

  // 2. FailedToConvertBalance
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund in unrated asset: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'FailedToConvertBalance')
}

/**
 * The treasury pays a bounty at once, so it cannot fund one worth more than it holds. Root has no
 * spend limit, which leaves the payment as the only check.
 *
 * 1. Fund a bounty worth one unit more than the treasury holds, as Root
 * 2. Verify the call failed with `FundingError`
 * 3. Verify the treasury kept its funds and no bounty was created
 */
async function fundBeyondTreasuryFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))
  const value = treasuryBefore + 1n
  const index = await nextBountyIndex(client)

  // 1. Fund more than the treasury holds
  const call = bountiesTx(client).fundBounty(assetKind(asset), value, alice.address, METADATA_HASH)
  const result = await dispatchAs(client, call, ROOT)

  // 2. FundingError
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund beyond treasury: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'FundingError')

  // 3. Nothing moved or created
  expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore)
  expect(await nextBountyIndex(client)).toBe(index)
}

/// -------
/// Payment status
/// -------

/**
 * Anyone may confirm a funding payment. Once confirmed, the bounty is `Funded`, waiting for its
 * proposed curator to accept.
 *
 * 1. Fund a bounty as `Treasurer`, proposing alice
 * 2. Confirm the funding as dave, who has no role in the bounty
 * 3. Verify `BountyFundingProcessed`, and that the bounty is `Funded` with alice proposed
 */
async function checkStatusAfterFunding(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Fund
  const index = await fundBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Confirm as dave
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 3. Funded
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('check status after funding: events')
  await expectNoExtrinsicFailure(client)
  const processed = await bountyEvent(client, 'BountyFundingProcessed', index)
  expect(processed.data.childIndex.isNone).toBe(true)
  const { status } = await getBounty(client, index)
  assert(status.isFunded)
  expect(status.asFunded.curator.toString()).toBe(addressOf(client, alice))
}

/**
 * `check_status` only settles a pending payment. A `Funded` bounty has none.
 *
 * 1. Fund a bounty and confirm the funding
 * 2. Call `check_status` on it again
 * 3. Verify the extrinsic failed with `UnexpectedStatus`
 */
async function checkStatusOnFundedFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Check again
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 3. UnexpectedStatus
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('check status on funded bounty: events')
  expectBountyError(client, await extrinsicError(client), 'UnexpectedStatus')
}

/**
 * `retry_payment` resends only a payment that failed. A `LocalPay` payment never fails, so a retry
 * is refused rather than paying twice.
 *
 * 1. Fund a bounty, leaving its funding payment attempted
 * 2. Retry the payment as dave
 * 3. Verify the extrinsic failed with `UnexpectedStatus`
 * 4. Verify the treasury paid nothing more and the bounty is still `FundingAttempted`
 */
async function retryAttemptedPaymentFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Fund
  const index = await fundBounty(client, asset, await parentValue(client, asset), alice)
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))

  // 2. Retry
  await sendTransaction(bountiesTx(client).retryPayment(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 3. UnexpectedStatus
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('retry attempted payment: events')
  expectBountyError(client, await extrinsicError(client), 'UnexpectedStatus')

  // 4. Nothing paid twice
  expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore)
  expect((await getBounty(client, index)).status.isFundingAttempted).toBe(true)
}

/**
 * `check_status` on an index no bounty has is refused.
 *
 * 1. Call `check_status` on the next unused bounty index
 * 2. Verify the extrinsic failed with `InvalidIndex`
 */
async function checkStatusOnUnknownBountyFails(client: Client<any, any>) {
  const index = await nextBountyIndex(client)

  // 1. Check an unused index
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 2. InvalidIndex
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('check status on unknown bounty: events')
  expectBountyError(client, await extrinsicError(client), 'InvalidIndex')
}

/// -------
/// Curator
/// -------

/**
 * Accepting the curator role puts a deposit on hold: a share of the bounty's native value, between
 * a floor and a cap. It is the stake a curator loses if governance removes them.
 *
 * 1. Fund a bounty proposing alice, and settle the funding
 * 2. Accept as alice
 * 3. Verify `BountyBecameActive`, and `balances.Held` from alice for the deposit the formula gives
 * 4. Verify alice's hold and the bounty's recorded deposit both equal that deposit
 * 5. Verify the bounty is `Active` with alice as curator
 */
async function acceptCuratorHoldsDeposit(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const deposit = curatorDepositFor(testConfig, toNative(value, await rateOf(client, asset)))
  expect(deposit).toBeGreaterThan(testConfig.curatorDeposit.min)
  expect(deposit).toBeLessThan(testConfig.curatorDeposit.max)

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, value, alice)
  const holdBefore = await curatorHold(client, alice)

  // 2. Accept
  await sendTransaction(bountiesTx(client).acceptCurator(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. BountyBecameActive and Held
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('accept curator: events')
  await expectNoExtrinsicFailure(client)
  const active = await bountyEvent(client, 'BountyBecameActive', index)
  expect(active.data.childIndex.isNone).toBe(true)
  expect(active.data.curator.toString()).toBe(addressOf(client, alice))
  expect((await balancesEvent(client, 'Held', alice)).data.amount.toBigInt()).toBe(deposit)

  // 4. Deposit held and recorded
  expect(await curatorHold(client, alice)).toBe(holdBefore + deposit)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()).toBe(deposit)

  // 5. Active
  const { status } = await getBounty(client, index)
  assert(status.isActive)
  expect(status.asActive.curator.toString()).toBe(addressOf(client, alice))
}

/**
 * However large the bounty, the curator deposit stops at its cap.
 *
 * 1. Fund a bounty worth twice the value at which the deposit reaches its cap, and settle it
 * 2. Accept as alice
 * 3. Verify the deposit held is exactly the cap
 */
async function curatorDepositCappedAtMax(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const { multiplier, max } = testConfig.curatorDeposit
  const rate = await rateOf(client, asset)
  const value = fromNative((2n * max * PERMILL_ONE) / multiplier, rate)
  expect((toNative(value, rate) * multiplier) / PERMILL_ONE).toBeGreaterThan(max)

  // 1. Funded bounty above the cap
  const index = await fundedBounty(client, asset, value, alice)
  const holdBefore = await curatorHold(client, alice)

  // 2. Accept
  await sendTransaction(bountiesTx(client).acceptCurator(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. Capped deposit
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('accept curator above deposit cap: events')
  await expectNoExtrinsicFailure(client)
  expect(await curatorHold(client, alice)).toBe(holdBefore + max)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()).toBe(max)
}

/**
 * Only the proposed curator may accept the role.
 *
 * 1. Fund a bounty proposing alice, and settle the funding
 * 2. Accept as charlie
 * 3. Verify the extrinsic failed with `RequireCurator`, and the bounty is still `Funded`
 */
async function acceptByOtherAccountFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Accept as charlie
  await sendTransaction(bountiesTx(client).acceptCurator(index, null).signAsync(charlie))
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('accept by other account: events')
  expectBountyError(client, await extrinsicError(client), 'RequireCurator')
  expect((await getBounty(client, index)).status.isFunded).toBe(true)
}

/**
 * A curator who cannot put the deposit on hold cannot accept, so no bounty is curated without
 * stake.
 *
 * 1. Fund a bounty proposing eve, and settle the funding
 * 2. Give eve half the deposit, enough for fees but not for the hold
 * 3. Accept as eve
 * 4. Verify the extrinsic failed with `FundsUnavailable`, and the bounty is still `Funded` with no
 *    deposit recorded
 */
async function acceptWithoutDepositFundsFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const deposit = curatorDepositFor(testConfig, toNative(value, await rateOf(client, asset)))

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, value, eve)

  // 2. Half the deposit
  await client.dev.setStorage({
    System: { account: [[[eve.address], { providers: 1, data: { free: deposit / 2n } }]] },
  })

  // 3. Accept
  await sendTransaction(bountiesTx(client).acceptCurator(index, null).signAsync(eve))
  await client.dev.newBlock()

  // 4. FundsUnavailable, nothing held
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('accept without funds for deposit: events')
  const error = await extrinsicError(client)
  assert(error.isToken, `expected a token error, got ${JSON.stringify(error.toHuman())}`)
  expect(error.asToken.isFundsUnavailable).toBe(true)
  expect((await getBounty(client, index)).status.isFunded).toBe(true)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).isNone).toBe(true)
  expect(await curatorHold(client, eve)).toBe(0n)
}

/**
 * A curator may step down, and gets their deposit back.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Unassign as alice
 * 3. Verify `CuratorUnassigned`, and `balances.Released` returning alice's deposit
 * 4. Verify alice's hold dropped by the deposit, no deposit is recorded, and the bounty is
 *    `CuratorUnassigned`
 */
async function curatorUnassignsSelf(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const deposit = (await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()
  const holdBefore = await curatorHold(client, alice)

  // 2. Unassign as alice
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. CuratorUnassigned and Released
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('curator unassigns self: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'CuratorUnassigned', index)
  expect((await balancesEvent(client, 'Released', alice)).data.amount.toBigInt()).toBe(deposit)

  // 4. Deposit returned
  expect(await curatorHold(client, alice)).toBe(holdBefore - deposit)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).isNone).toBe(true)
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)
}

/**
 * The reject origin may remove an active curator, and the curator's deposit is burned: it leaves
 * total issuance rather than going to the curator or the treasury.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Unassign alice as `Treasurer`
 * 3. Verify `CuratorUnassigned`, and `balances.BurnedHeld` for alice's deposit
 * 4. Verify alice's hold dropped by the deposit while alice's free balance did not change
 * 5. Verify total issuance fell by the deposit
 */
async function treasurerUnassignsCuratorBurnsDeposit(
  client: Client<any, any>,
  testConfig: MultiAssetBountiesTestConfig,
) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const deposit = (await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()
  const holdBefore = await curatorHold(client, alice)
  const freeBefore = (await client.api.query.system.account(alice.address)).data.free.toBigInt()
  const issuanceBefore = (await client.api.query.balances.totalIssuance()).toBigInt()

  // 2. Unassign as Treasurer
  const result = await dispatchAs(client, bountiesTx(client).unassignCurator(index, null), TREASURER)

  // 3. CuratorUnassigned and BurnedHeld
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('treasurer unassigns curator: events')
  expectDispatchOk(result)
  await bountyEvent(client, 'CuratorUnassigned', index)
  expect((await balancesEvent(client, 'BurnedHeld', alice)).data.amount.toBigInt()).toBe(deposit)

  // 4. Hold gone, nothing returned to alice
  expect(await curatorHold(client, alice)).toBe(holdBefore - deposit)
  expect((await client.api.query.system.account(alice.address)).data.free.toBigInt()).toBe(freeBefore)

  // 5. Issuance fell by the deposit. Treasury inflation, which some Asset Hubs mint
  // periodically, can land in the same block; it is unrelated to the burn, so it is added back.
  const minted = await mintedInLatestBlock(client)
  expect((await client.api.query.balances.totalIssuance()).toBigInt()).toBe(issuanceBefore - deposit + minted)
}

/**
 * Spender tracks may fund bounties, but only the reject origin may remove a curator.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Unassign alice as `SmallTipper`
 * 3. Verify the call failed with `BadOrigin`, and alice is still the active curator with her
 *    deposit held
 */
async function smallTipperUnassignFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const holdBefore = await curatorHold(client, alice)

  // 2. Unassign as SmallTipper
  const result = await dispatchAs(client, bountiesTx(client).unassignCurator(index, null), SMALL_TIPPER)

  // 3. BadOrigin
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('small tipper unassigns curator: events')
  assert(result.isErr)
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await getBounty(client, index)).status.isActive).toBe(true)
  expect(await curatorHold(client, alice)).toBe(holdBefore)
}

/**
 * A proposed curator may decline before accepting. No deposit was taken, so none moves.
 *
 * 1. Fund a bounty proposing alice, and settle the funding
 * 2. Unassign as alice
 * 3. Verify `CuratorUnassigned`, no balance hold event, and the bounty is `CuratorUnassigned`
 */
async function proposedCuratorUnassignsBeforeAccepting(
  client: Client<any, any>,
  testConfig: MultiAssetBountiesTestConfig,
) {
  const asset = testConfig.primaryAsset

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)
  const holdBefore = await curatorHold(client, alice)

  // 2. Unassign as alice
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. CuratorUnassigned, no deposit moved
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('proposed curator unassigns: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'CuratorUnassigned', index)
  expect(await curatorHold(client, alice)).toBe(holdBefore)
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)
}

/**
 * Once a bounty has no curator, a spender track within its limit may propose a new one, who can
 * then accept as usual.
 *
 * 1. Fund a bounty proposing alice, settle it, and have alice step down
 * 2. Propose charlie as `SmallTipper`
 * 3. Verify `CuratorProposed` names charlie, and the bounty is `Funded` with charlie proposed
 * 4. Accept as charlie, and verify the bounty is `Active` with charlie as curator
 */
async function proposeCuratorAfterUnassign(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  expect(toNative(value, await rateOf(client, asset))).toBeLessThanOrEqual(testConfig.smallTipperLimit)

  // 1. Bounty without a curator
  const index = await fundedBounty(client, asset, value, alice)
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 2. Propose charlie as SmallTipper
  const result = await dispatchAs(client, bountiesTx(client).proposeCurator(index, null, charlie.address), SMALL_TIPPER)

  // 3. CuratorProposed
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('propose curator after unassign: events')
  expectDispatchOk(result)
  const proposed = await bountyEvent(client, 'CuratorProposed', index)
  expect(proposed.data.childIndex.isNone).toBe(true)
  expect(proposed.data.curator.toString()).toBe(addressOf(client, charlie))
  const { status } = await getBounty(client, index)
  assert(status.isFunded)
  expect(status.asFunded.curator.toString()).toBe(addressOf(client, charlie))

  // 4. Charlie accepts
  await sendTransaction(bountiesTx(client).acceptCurator(index, null).signAsync(charlie))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  const accepted = await getBounty(client, index)
  assert(accepted.status.isActive)
  expect(accepted.status.asActive.curator.toString()).toBe(addressOf(client, charlie))
}

/**
 * A signed account may not propose the curator of a parent bounty: that is the spend origin's
 * decision.
 *
 * 1. Fund a bounty proposing alice, settle it, and have alice step down
 * 2. Propose charlie from dave's signed origin
 * 3. Verify the extrinsic failed with `BadOrigin`, and the bounty still has no curator
 */
async function proposeCuratorAsSignedFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Bounty without a curator
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 2. Propose as dave
  await sendTransaction(bountiesTx(client).proposeCurator(index, null, charlie.address).signAsync(dave))
  await client.dev.newBlock()

  // 3. BadOrigin
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('propose curator as signed: events')
  expect((await extrinsicError(client)).isBadOrigin).toBe(true)
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)
}

/**
 * Proposing a curator is a spend decision, so a track may only do it for bounties within its
 * spend limit.
 *
 * 1. Fund a bounty worth twice the `SmallTipper` limit, settle it, and have alice step down
 * 2. Propose charlie as `SmallTipper`
 * 3. Verify the call failed with `InsufficientPermission`, and the bounty still has no curator
 */
async function proposeCuratorAboveSmallTipperFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = fromNative(2n * testConfig.smallTipperLimit, await rateOf(client, asset))

  // 1. Bounty above the limit, without a curator
  const index = await fundedBounty(client, asset, value, alice)
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 2. Propose as SmallTipper
  const result = await dispatchAs(client, bountiesTx(client).proposeCurator(index, null, charlie.address), SMALL_TIPPER)

  // 3. InsufficientPermission
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('propose curator above SmallTipper limit: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'InsufficientPermission')
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)
}

/**
 * A curator can only be proposed for a bounty that has none. An active curator must be removed
 * first.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Propose charlie as `Treasurer`
 * 3. Verify the call failed with `UnexpectedStatus`, and alice is still the curator
 */
async function proposeCuratorOnActiveFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Propose as Treasurer
  const result = await dispatchAs(client, bountiesTx(client).proposeCurator(index, null, charlie.address), TREASURER)

  // 3. UnexpectedStatus
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('propose curator on active bounty: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'UnexpectedStatus')
  const { status } = await getBounty(client, index)
  assert(status.isActive)
  expect(status.asActive.curator.toString()).toBe(addressOf(client, alice))
}

/// -------
/// Award
/// -------

/**
 * The curator pays a bounty out to a beneficiary. The transfer happens in `award_bounty`; a
 * `check_status` call then confirms it, returns the curator's deposit and removes the bounty.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Award it to bob as alice
 * 3. Verify `Paid` and `BountyAwarded`, that bob received the whole value, and that the bounty is
 *    `PayoutAttempted`
 * 4. Confirm the payout as dave
 * 5. Verify `BountyPayoutProcessed` with the value paid, and `balances.Released` for alice's deposit
 * 6. Verify the bounty and its deposit record are gone, alice's hold is released, the metadata
 *    preimage is no longer requested, and dave paid no fee for the confirmation
 */
async function awardAndSettle(client: Client<any, any>, asset: BountyAsset) {
  const value = await parentValue(client, asset)

  // 1. Active bounty
  const index = await activeBounty(client, asset, value, alice)
  const deposit = (await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()
  const holdBefore = await curatorHold(client, alice)
  const bobBefore = await balanceOf(client, asset, addressOf(client, bob))

  // 2. Award to bob
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()

  // 3. Paid, BountyAwarded, bob paid
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot(`award bounty in ${asset.symbol}: events`)
  await expectNoExtrinsicFailure(client)
  const paid = await bountyEvent(client, 'Paid', index)
  expect(paid.data.paymentId.toBigInt()).toBe(LOCAL_PAY_ID)
  const awarded = await bountyEvent(client, 'BountyAwarded', index)
  expect(awarded.data.childIndex.isNone).toBe(true)
  expectLocalBeneficiary(awarded.data.beneficiary, bob)
  expect(await balanceOf(client, asset, addressOf(client, bob))).toBe(bobBefore + value)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(0n)
  expect((await getBounty(client, index)).status.isPayoutAttempted).toBe(true)

  // 4. Confirm as dave
  const daveBefore = (await client.api.query.system.account(dave.address)).data.free.toBigInt()
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 5. BountyPayoutProcessed and Released
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot(`settle payout in ${asset.symbol}: events`)
  await expectNoExtrinsicFailure(client)
  const processed = await bountyEvent(client, 'BountyPayoutProcessed', index)
  expect(processed.data.value.toBigInt()).toBe(value)
  expectLocalBeneficiary(processed.data.beneficiary, bob)
  expect((await balancesEvent(client, 'Released', alice)).data.amount.toBigInt()).toBe(deposit)

  // 6. Bounty removed, deposit returned, preimage released, no fee
  expect((await bountiesQuery(client).bounties(index)).isNone).toBe(true)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).isNone).toBe(true)
  expect(await curatorHold(client, alice)).toBe(holdBefore - deposit)
  expect((await client.api.query.preimage.requestStatusFor(METADATA_HASH)).unwrap().isUnrequested).toBe(true)
  expect((await client.api.query.system.account(dave.address)).data.free.toBigInt()).toBe(daveBefore)
}

/**
 * Only the bounty's curator may award it.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Award it to bob as charlie
 * 3. Verify the extrinsic failed with `RequireCurator`, and the bounty is still `Active`
 */
async function awardByNonCuratorFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Award as charlie
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(charlie))
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award by non-curator: events')
  expectBountyError(client, await extrinsicError(client), 'RequireCurator')
  expect((await getBounty(client, index)).status.isActive).toBe(true)
}

/**
 * `LocalPay` pays only accounts on this chain. A beneficiary located on another chain cannot be
 * paid, so the award fails and the funds stay in the bounty.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Award it to bob's account on parachain 2000
 * 3. Verify the extrinsic failed with `PayoutError`, the bounty is still `Active`, and its account
 *    kept the value
 */
async function awardToRemoteBeneficiaryFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)

  // 1. Active bounty
  const index = await activeBounty(client, asset, value, alice)
  const remote = localBeneficiary(bob)
  remote.V5.location = { parents: 1, interior: { X1: [{ Parachain: 2000 }] } } as any

  // 2. Award to a remote beneficiary
  await sendTransaction(bountiesTx(client).awardBounty(index, null, remote).signAsync(alice))
  await client.dev.newBlock()

  // 3. PayoutError, funds kept
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award to remote beneficiary: events')
  expectBountyError(client, await extrinsicError(client), 'PayoutError')
  expect((await getBounty(client, index)).status.isActive).toBe(true)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value)
}

/**
 * A parent bounty cannot be paid out while one of its child bounties is still open, since the
 * child's value is set aside from the parent's.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Fund a child bounty from it as alice
 * 3. Award the parent to bob as alice
 * 4. Verify the extrinsic failed with `HasActiveChildBounty`
 */
async function awardParentWithActiveChildFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Child bounty
  await fundChildBounty(client, index, await childValue(client, asset), null)

  // 3. Award the parent
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()

  // 4. HasActiveChildBounty
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award parent with active child: events')
  expectBountyError(client, await extrinsicError(client), 'HasActiveChildBounty')
}

/// -------
/// Close
/// -------

/**
 * The reject origin may cancel a bounty, and its value returns to the treasury. As with every
 * payment, the refund happens in `close_bounty`, and a `check_status` call removes the bounty.
 *
 * 1. Fund a bounty proposing alice, and settle the funding
 * 2. Close it as `Treasurer`
 * 3. Verify `BountyCanceled` and `Paid`, that the treasury got the whole value back, and that the
 *    bounty is `RefundAttempted`
 * 4. Confirm the refund as dave
 * 5. Verify `BountyRefundProcessed`, that the bounty is gone, and that its metadata preimage is no
 *    longer requested
 */
async function treasurerClosesFundedBounty(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, value, alice)
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))

  // 2. Close as Treasurer
  const result = await dispatchAs(client, bountiesTx(client).closeBounty(index, null), TREASURER)

  // 3. BountyCanceled, Paid, refunded
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('treasurer closes funded bounty: events')
  expectDispatchOk(result)
  const canceled = await bountyEvent(client, 'BountyCanceled', index)
  expect(canceled.data.childIndex.isNone).toBe(true)
  expect((await bountyEvent(client, 'Paid', index)).data.paymentId.toBigInt()).toBe(LOCAL_PAY_ID)
  expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore + value)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(0n)
  expect((await getBounty(client, index)).status.isRefundAttempted).toBe(true)

  // 4. Confirm as dave
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 5. BountyRefundProcessed, bounty removed
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('settle refund of funded bounty: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'BountyRefundProcessed', index)
  expect((await bountiesQuery(client).bounties(index)).isNone).toBe(true)
  expect((await client.api.query.preimage.requestStatusFor(METADATA_HASH)).unwrap().isUnrequested).toBe(true)
}

/**
 * A curator may cancel their own bounty. Unlike removal by governance, this returns the curator's
 * deposit once the refund is confirmed.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Close it as alice
 * 3. Verify `BountyCanceled`, and that the bounty account was emptied
 * 4. Confirm the refund as dave
 * 5. Verify `BountyRefundProcessed` and `balances.Released` for alice's whole deposit, with nothing
 *    burned
 */
async function curatorClosesOwnBounty(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active bounty
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const deposit = (await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()
  const holdBefore = await curatorHold(client, alice)

  // 2. Close as alice
  await sendTransaction(bountiesTx(client).closeBounty(index, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. BountyCanceled, account emptied
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('curator closes own bounty: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'BountyCanceled', index)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(0n)

  // 4. Confirm as dave
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()

  // 5. Deposit released, not burned
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('settle refund of curator-closed bounty: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'BountyRefundProcessed', index)
  expect((await balancesEvent(client, 'Released', alice)).data.amount.toBigInt()).toBe(deposit)
  const burned = (await client.api.query.system.events()).filter(({ event }) =>
    (client.api.events as any).balances.BurnedHeld.is(event),
  )
  expect(burned).toHaveLength(0)
  expect(await curatorHold(client, alice)).toBe(holdBefore - deposit)
}

/**
 * Spender tracks may fund bounties, but only the reject origin or the curator may close one.
 *
 * 1. Fund a bounty proposing alice, and settle the funding
 * 2. Close it as `SmallTipper`
 * 3. Verify the call failed with `BadOrigin`, and the bounty is still `Funded`
 */
async function smallTipperCloseFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Funded bounty
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Close as SmallTipper
  const result = await dispatchAs(client, bountiesTx(client).closeBounty(index, null), SMALL_TIPPER)

  // 3. BadOrigin
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('small tipper closes bounty: events')
  assert(result.isErr)
  expect(result.asErr.isBadOrigin).toBe(true)
  expect((await getBounty(client, index)).status.isFunded).toBe(true)
}

/**
 * A parent bounty cannot be closed while one of its child bounties is still open.
 *
 * 1. Make alice the active curator of a bounty, and fund a child bounty from it
 * 2. Close the parent as `Treasurer`
 * 3. Verify the call failed with `HasActiveChildBounty`
 */
async function closeParentWithActiveChildFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active parent with a child
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  await fundChildBounty(client, index, await childValue(client, asset), null)

  // 2. Close the parent
  const result = await dispatchAs(client, bountiesTx(client).closeBounty(index, null), TREASURER)

  // 3. HasActiveChildBounty
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('close parent with active child: events')
  assert(result.isErr)
  expectBountyError(client, result.asErr, 'HasActiveChildBounty')
}

/**
 * After a child bounty is paid out, the parent's account holds only the parent's value minus the
 * child's. Closing the parent should refund that remainder to the treasury.
 *
 * Earlier versions of the pallet ask for the parent's full value instead. The account cannot pay
 * it, so the close fails with `RefundError` and the parent can never be closed.
 * `parentRefundNetOfChildren` records which behaviour the chain runs. The test asserts that
 * behaviour, so it fails when a runtime upgrade changes it and the flag needs updating.
 *
 * 1. Make alice the active curator of a bounty
 * 2. As alice, in one batch: fund a child bounty alice curates, settle it, award it to bob, and
 *    settle the payout
 * 3. Verify the parent's account holds the parent's value minus the child's
 * 4. Close the parent as `Treasurer`
 * 5. With the net refund, verify the close succeeded and the treasury got the remainder back.
 *    Without it, verify `RefundError`, and that the parent and its account are unchanged
 */
async function closeParentAfterChildPayout(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const cv = await childValue(client, asset)

  // 1. Active parent
  const index = await activeBounty(client, asset, value, alice)
  const child = (await bountiesQuery(client).totalChildBountiesPerParent(index)).toNumber()

  // 2. Pay out a child
  const tx = bountiesTx(client)
  const payOutChild = client.api.tx.utility.batchAll([
    tx.fundChildBounty(index, cv, METADATA_HASH, null),
    tx.checkStatus(index, child),
    tx.awardBounty(index, child, localBeneficiary(bob)),
    tx.checkStatus(index, child),
  ])
  await sendTransaction(payOutChild.signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  expect((await bountiesQuery(client).childBounties(index, child)).isNone).toBe(true)

  // 3. Parent account holds the remainder
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value - cv)
  const treasuryBefore = await balanceOf(client, asset, treasuryPot(client))

  // 4. Close the parent
  const result = await dispatchAs(client, bountiesTx(client).closeBounty(index, null), TREASURER)

  // 5. Net refund, or RefundError
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('close parent after child payout: events')
  if (testConfig.parentRefundNetOfChildren) {
    expectDispatchOk(result)
    await bountyEvent(client, 'BountyCanceled', index)
    expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore + value - cv)
    expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(0n)
  } else {
    assert(result.isErr)
    expectBountyError(client, result.asErr, 'RefundError')
    expect((await getBounty(client, index)).status.isActive).toBe(true)
    expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value - cv)
    expect(await balanceOf(client, asset, treasuryPot(client))).toBe(treasuryBefore)
  }
}

/**
 * Once a bounty has no curator, only the reject origin may close it: its former curator no
 * longer can.
 *
 * 1. Fund a bounty proposing alice, settle it, and have alice step down
 * 2. Close it as alice, and verify the extrinsic failed with `BadOrigin`
 * 3. Close it as `Treasurer`, and verify `BountyCanceled` and a refund recorded with no curator
 */
async function closeUnassignedBountyNeedsRejectOrigin(
  client: Client<any, any>,
  testConfig: MultiAssetBountiesTestConfig,
) {
  const asset = testConfig.primaryAsset

  // 1. Bounty without a curator
  const index = await fundedBounty(client, asset, await parentValue(client, asset), alice)
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 2. Former curator refused
  await sendTransaction(bountiesTx(client).closeBounty(index, null).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('former curator closes unassigned bounty: events')
  expect((await extrinsicError(client)).isBadOrigin).toBe(true)
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)

  // 3. Treasurer closes
  const result = await dispatchAs(client, bountiesTx(client).closeBounty(index, null), TREASURER)
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('treasurer closes unassigned bounty: events')
  expectDispatchOk(result)
  await bountyEvent(client, 'BountyCanceled', index)
  const { status } = await getBounty(client, index)
  assert(status.isRefundAttempted)
  expect(status.asRefundAttempted.curator.isNone).toBe(true)
}

/// -------
/// Child bounties
/// -------

/**
 * The parent's curator may set part of the parent's value aside as a child bounty. The value moves
 * to the child's own account, and the parent records it so it cannot be paid out twice. A child
 * curated by the parent's curator needs no acceptance and no deposit.
 *
 * 1. Make alice the active curator of a parent bounty
 * 2. Fund a child bounty from it as alice, naming no curator
 * 3. Verify `Paid` and `ChildBountyCreated`, that the value moved from the parent's account to the
 *    child's, and that the parent's child counters and child value went up
 * 4. Settle the child's funding as dave
 * 5. Verify `BountyFundingProcessed`, that the child is `Active` with alice as curator, and that no
 *    `BountyBecameActive` was emitted and no deposit taken
 */
async function fundChildWithParentCurator(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const cv = await childValue(client, asset)

  // 1. Active parent
  const index = await activeBounty(client, asset, value, alice)
  const holdBefore = await curatorHold(client, alice)

  // 2. Fund a child
  await sendTransaction(bountiesTx(client).fundChildBounty(index, cv, METADATA_HASH, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. Paid, ChildBountyCreated, value set aside
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund child with parent curator: events')
  await expectNoExtrinsicFailure(client)
  const created = await bountyEvent(client, 'ChildBountyCreated', index)
  const child = created.data.childIndex.toNumber()
  expect((await bountyEvent(client, 'Paid', index)).data.childIndex.unwrap().toNumber()).toBe(child)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value - cv)
  expect(await balanceOf(client, asset, bountyAccount(client, index, child))).toBe(cv)
  const query = bountiesQuery(client)
  expect((await query.childBountiesValuePerParent(index)).toBigInt()).toBe(cv)
  expect((await query.childBountiesPerParent(index)).toNumber()).toBe(1)
  expect((await query.totalChildBountiesPerParent(index)).toNumber()).toBe(child + 1)

  // 4. Settle as dave
  await sendTransaction(bountiesTx(client).checkStatus(index, child).signAsync(dave))
  await client.dev.newBlock()

  // 5. Active straight away, no deposit
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('settle child with parent curator: events')
  await expectNoExtrinsicFailure(client)
  const processed = await bountyEvent(client, 'BountyFundingProcessed', index)
  expect(processed.data.childIndex.unwrap().toNumber()).toBe(child)
  const { status } = (await query.childBounties(index, child)).unwrap()
  assert(status.isActive)
  expect(status.asActive.curator.toString()).toBe(addressOf(client, alice))
  const becameActive = (await client.api.query.system.events()).filter(({ event }) =>
    (client.api.events as any).multiAssetBounties.BountyBecameActive.is(event),
  )
  expect(becameActive).toHaveLength(0)
  expect((await query.curatorDeposit(index, child)).isNone).toBe(true)
  expect(await curatorHold(client, alice)).toBe(holdBefore)
}

/**
 * A child bounty may have its own curator, who accepts and puts down a deposit just as a parent's
 * curator does. A child at the minimum value costs the minimum deposit.
 *
 * 1. Make alice the active curator of a parent bounty
 * 2. Fund a child naming charlie as curator, and settle its funding
 * 3. Accept as charlie
 * 4. Verify `BountyBecameActive` for the child, and `balances.Held` from charlie for the minimum
 *    deposit
 * 5. Verify charlie's hold and the child's deposit record, and that the child is `Active`
 */
async function fundChildWithOwnCurator(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const cv = await childValue(client, asset)
  const deposit = curatorDepositFor(testConfig, toNative(cv, await rateOf(client, asset)))
  expect(deposit).toBe(testConfig.curatorDeposit.min)

  // 1. Active parent
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Child proposing charlie, settled
  const child = await fundChildBounty(client, index, cv, charlie)
  await sendTransaction(bountiesTx(client).checkStatus(index, child).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  const funded = (await bountiesQuery(client).childBounties(index, child)).unwrap()
  assert(funded.status.isFunded)
  expect(funded.status.asFunded.curator.toString()).toBe(addressOf(client, charlie))

  // 3. Accept as charlie
  await sendTransaction(bountiesTx(client).acceptCurator(index, child).signAsync(charlie))
  await client.dev.newBlock()

  // 4. BountyBecameActive and Held
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('accept child curator: events')
  await expectNoExtrinsicFailure(client)
  const active = await bountyEvent(client, 'BountyBecameActive', index)
  expect(active.data.childIndex.unwrap().toNumber()).toBe(child)
  expect(active.data.curator.toString()).toBe(addressOf(client, charlie))
  expect((await balancesEvent(client, 'Held', charlie)).data.amount.toBigInt()).toBe(deposit)

  // 5. Deposit held, child Active
  expect(await curatorHold(client, charlie)).toBe(deposit)
  expect((await bountiesQuery(client).curatorDeposit(index, child)).unwrap().toBigInt()).toBe(deposit)
  expect((await bountiesQuery(client).childBounties(index, child)).unwrap().status.isActive).toBe(true)
}

/**
 * Paying out a child bounty spends part of the parent's value for good: the parent's later payout
 * is its value minus the child's.
 *
 * 1. Make alice the active curator of a parent bounty and of an active child bounty under it
 * 2. Award the child to bob as alice
 * 3. Verify `BountyAwarded` for the child, and that bob received the child's value
 * 4. Settle the child's payout as dave
 * 5. Verify `BountyPayoutProcessed` for the child's value, that the child is gone, and that the
 *    parent still counts the child's value as spent but no longer counts the child as open
 * 6. Award the parent to bob as alice, and settle the payout as dave
 * 7. Verify bob received the parent's value minus the child's
 */
async function awardChildThenParent(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const cv = await childValue(client, asset)
  const query = bountiesQuery(client)

  // 1. Active parent and child
  const index = await activeBounty(client, asset, value, alice)
  const child = await childOfParentCurator(client, index, cv)
  const bobBefore = await balanceOf(client, asset, addressOf(client, bob))

  // 2. Award the child
  await sendTransaction(bountiesTx(client).awardBounty(index, child, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()

  // 3. BountyAwarded, bob paid
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award child: events')
  await expectNoExtrinsicFailure(client)
  const awarded = await bountyEvent(client, 'BountyAwarded', index)
  expect(awarded.data.childIndex.unwrap().toNumber()).toBe(child)
  expect(await balanceOf(client, asset, addressOf(client, bob))).toBe(bobBefore + cv)

  // 4. Settle the child payout
  await sendTransaction(bountiesTx(client).checkStatus(index, child).signAsync(dave))
  await client.dev.newBlock()

  // 5. BountyPayoutProcessed, child removed
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('settle child payout: events')
  await expectNoExtrinsicFailure(client)
  expect((await bountyEvent(client, 'BountyPayoutProcessed', index)).data.value.toBigInt()).toBe(cv)
  expect((await query.childBounties(index, child)).isNone).toBe(true)
  expect((await query.childBountiesValuePerParent(index)).toBigInt()).toBe(cv)
  expect((await query.childBountiesPerParent(index)).toNumber()).toBe(0)

  // 6. Award and settle the parent
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  await sendTransaction(bountiesTx(client).checkStatus(index, null).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 7. Parent paid its value minus the child's
  expect((await bountyEvent(client, 'BountyPayoutProcessed', index)).data.value.toBigInt()).toBe(value - cv)
  expect(await balanceOf(client, asset, addressOf(client, bob))).toBe(bobBefore + value)
}

/**
 * Closing a child bounty returns its value to the parent's account, not to the treasury, and the
 * parent may set it aside again.
 *
 * 1. Make alice the active curator of a parent bounty and of an active child bounty under it
 * 2. Close the child as alice
 * 3. Verify `BountyCanceled` for the child, and that its value moved back to the parent's account
 * 4. Settle the refund as dave
 * 5. Verify `BountyRefundProcessed`, that the child is gone, and that the parent no longer counts
 *    the child or its value
 */
async function closeChildReturnsValueToParent(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const cv = await childValue(client, asset)
  const query = bountiesQuery(client)

  // 1. Active parent and child
  const index = await activeBounty(client, asset, value, alice)
  const child = await childOfParentCurator(client, index, cv)

  // 2. Close the child
  await sendTransaction(bountiesTx(client).closeBounty(index, child).signAsync(alice))
  await client.dev.newBlock()

  // 3. BountyCanceled, value back with the parent
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('close child: events')
  await expectNoExtrinsicFailure(client)
  const canceled = await bountyEvent(client, 'BountyCanceled', index)
  expect(canceled.data.childIndex.unwrap().toNumber()).toBe(child)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value)
  expect(await balanceOf(client, asset, bountyAccount(client, index, child))).toBe(0n)

  // 4. Settle the refund
  await sendTransaction(bountiesTx(client).checkStatus(index, child).signAsync(dave))
  await client.dev.newBlock()

  // 5. BountyRefundProcessed, parent's headroom restored
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('settle child refund: events')
  await expectNoExtrinsicFailure(client)
  await bountyEvent(client, 'BountyRefundProcessed', index)
  expect((await query.childBounties(index, child)).isNone).toBe(true)
  expect((await query.childBountiesValuePerParent(index)).toBigInt()).toBe(0n)
  expect((await query.childBountiesPerParent(index)).toNumber()).toBe(0)
}

/**
 * Only the parent's curator may fund a child bounty from it.
 *
 * 1. Make alice the active curator of a parent bounty
 * 2. Fund a child from it as charlie
 * 3. Verify the extrinsic failed with `RequireCurator`
 */
async function fundChildByNonCuratorFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active parent
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Fund as charlie
  const cv = await childValue(client, asset)
  await sendTransaction(bountiesTx(client).fundChildBounty(index, cv, METADATA_HASH, null).signAsync(charlie))
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund child by non-curator: events')
  expectBountyError(client, await extrinsicError(client), 'RequireCurator')
}

/**
 * A child bounty must be worth at least `ChildBountyValueMinimum` in native value.
 *
 * 1. Make alice the active curator of a parent bounty
 * 2. Fund a child one unit below the minimum as alice
 * 3. Verify the extrinsic failed with `InvalidValue`
 */
async function fundChildBelowMinimumFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const value = (await childValue(client, asset)) - 1n
  expect(toNative(value, rate)).toBeLessThan(childBountyMinimum(client))

  // 1. Active parent
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Fund below the minimum
  await sendTransaction(bountiesTx(client).fundChildBounty(index, value, METADATA_HASH, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. InvalidValue
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund child below minimum: events')
  expectBountyError(client, await extrinsicError(client), 'InvalidValue')
}

/**
 * A parent can only set aside what its open and paid child bounties have not already taken.
 *
 * 1. Make alice the active curator of a parent bounty, and fund one child from it
 * 2. Fund a second child worth one unit more than the parent has left, as alice
 * 3. Verify the extrinsic failed with `InsufficientBountyValue`
 */
async function fundChildAboveRemainingFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const cv = await childValue(client, asset)

  // 1. Active parent with one child
  const index = await activeBounty(client, asset, value, alice)
  await fundChildBounty(client, index, cv, null)

  // 2. Fund more than remains
  const tooMuch = value - cv + 1n
  await sendTransaction(bountiesTx(client).fundChildBounty(index, tooMuch, METADATA_HASH, null).signAsync(alice))
  await client.dev.newBlock()

  // 3. InsufficientBountyValue
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund child above remaining value: events')
  expectBountyError(client, await extrinsicError(client), 'InsufficientBountyValue')
}

/**
 * A parent may have at most `MaxActiveChildBountyCount` open child bounties.
 *
 * Opening that many takes as many extrinsics, so the parent's open-child count is written
 * directly. The count is the only state the limit reads.
 *
 * 1. Make alice the active curator of a parent bounty
 * 2. Set the parent's open-child count to the limit
 * 3. Fund a child as alice
 * 4. Verify the extrinsic failed with `TooManyChildBounties`
 */
async function fundChildAtActiveLimitFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const limit = bountiesConsts(client).maxActiveChildBountyCount.toNumber()

  // 1. Active parent
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)

  // 2. Open-child count at the limit
  await client.dev.setStorage({ MultiAssetBounties: { childBountiesPerParent: [[[index], limit]] } })
  expect((await bountiesQuery(client).childBountiesPerParent(index)).toNumber()).toBe(limit)

  // 3. Fund a child
  const cv = await childValue(client, asset)
  await sendTransaction(bountiesTx(client).fundChildBounty(index, cv, METADATA_HASH, null).signAsync(alice))
  await client.dev.newBlock()

  // 4. TooManyChildBounties
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('fund child at active limit: events')
  expectBountyError(client, await extrinsicError(client), 'TooManyChildBounties')
}

/**
 * The parent's curator may remove a child's curator, and the child curator's deposit is burned,
 * as when governance removes a curator.
 *
 * 1. Make alice the active curator of a parent bounty, and charlie the active curator of a child
 * 2. Unassign charlie from the child as alice
 * 3. Verify `CuratorUnassigned` for the child, and `balances.BurnedHeld` for charlie's deposit
 * 4. Verify charlie's hold is gone, nothing was returned to charlie, and the child has no curator
 */
async function parentCuratorUnassignsChildCurator(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active parent and child
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const child = await childWithOwnCurator(client, index, await childValue(client, asset), charlie)
  const deposit = (await bountiesQuery(client).curatorDeposit(index, child)).unwrap().toBigInt()
  const freeBefore = (await client.api.query.system.account(charlie.address)).data.free.toBigInt()

  // 2. Unassign charlie as alice
  await sendTransaction(bountiesTx(client).unassignCurator(index, child).signAsync(alice))
  await client.dev.newBlock()

  // 3. CuratorUnassigned and BurnedHeld
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('parent curator unassigns child curator: events')
  await expectNoExtrinsicFailure(client)
  const unassigned = await bountyEvent(client, 'CuratorUnassigned', index)
  expect(unassigned.data.childIndex.unwrap().toNumber()).toBe(child)
  expect((await balancesEvent(client, 'BurnedHeld', charlie)).data.amount.toBigInt()).toBe(deposit)

  // 4. Deposit gone
  expect(await curatorHold(client, charlie)).toBe(0n)
  expect((await client.api.query.system.account(charlie.address)).data.free.toBigInt()).toBe(freeBefore)
  expect((await bountiesQuery(client).childBounties(index, child)).unwrap().status.isCuratorUnassigned).toBe(true)
}

/**
 * The parent's curator has power over child curators only while curating the parent. After alice
 * steps down from the parent, alice can no longer remove the child's curator.
 *
 * 1. Make alice the active curator of a parent bounty, and charlie the active curator of a child
 * 2. Unassign alice from the parent, as alice
 * 3. Unassign charlie from the child, as alice
 * 4. Verify the extrinsic failed with `BadOrigin`, and charlie still curates the child with the
 *    deposit held
 */
async function formerParentCuratorCannotUnassignChildCurator(
  client: Client<any, any>,
  testConfig: MultiAssetBountiesTestConfig,
) {
  const asset = testConfig.primaryAsset

  // 1. Active parent and child
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const child = await childWithOwnCurator(client, index, await childValue(client, asset), charlie)
  const holdBefore = await curatorHold(client, charlie)

  // 2. Alice leaves the parent
  await sendTransaction(bountiesTx(client).unassignCurator(index, null).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  expect((await getBounty(client, index)).status.isCuratorUnassigned).toBe(true)

  // 3. Alice tries to unassign charlie
  await sendTransaction(bountiesTx(client).unassignCurator(index, child).signAsync(alice))
  await client.dev.newBlock()

  // 4. BadOrigin
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('former parent curator unassigns child curator: events')
  expect((await extrinsicError(client)).isBadOrigin).toBe(true)
  const { status } = (await bountiesQuery(client).childBounties(index, child)).unwrap()
  assert(status.isActive)
  expect(status.asActive.curator.toString()).toBe(addressOf(client, charlie))
  expect(await curatorHold(client, charlie)).toBe(holdBefore)
}

/**
 * Only the parent's curator may propose a child's curator. Not even Root may.
 *
 * 1. Make alice the active curator of a parent bounty, and fund a child proposing charlie
 * 2. Settle the child's funding, and have charlie decline
 * 3. Propose dave as the child's curator as Root, and verify the call failed with `BadOrigin`
 * 4. Propose dave as alice, and verify `CuratorProposed` names dave and the child is `Funded` with
 *    dave proposed
 */
async function proposeChildCuratorAsParentCurator(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset

  // 1. Active parent, child proposing charlie
  const index = await activeBounty(client, asset, await parentValue(client, asset), alice)
  const child = await fundChildBounty(client, index, await childValue(client, asset), charlie)

  // 2. Settle, then charlie declines
  await sendTransaction(bountiesTx(client).checkStatus(index, child).signAsync(dave))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  await sendTransaction(bountiesTx(client).unassignCurator(index, child).signAsync(charlie))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)

  // 3. Root refused
  const result = await dispatchAs(client, bountiesTx(client).proposeCurator(index, child, dave.address), ROOT)
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('root proposes child curator: events')
  assert(result.isErr)
  expect(result.asErr.isBadOrigin).toBe(true)

  // 4. Alice proposes dave
  await sendTransaction(bountiesTx(client).proposeCurator(index, child, dave.address).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('parent curator proposes child curator: events')
  await expectNoExtrinsicFailure(client)
  const proposed = await bountyEvent(client, 'CuratorProposed', index)
  expect(proposed.data.childIndex.unwrap().toNumber()).toBe(child)
  expect(proposed.data.curator.toString()).toBe(addressOf(client, dave))
  const { status } = (await bountiesQuery(client).childBounties(index, child)).unwrap()
  assert(status.isFunded)
  expect(status.asFunded.curator.toString()).toBe(addressOf(client, dave))
}

/// -------
/// Increase value
/// -------

/** A transfer of `amount` of `asset` to `dest`, from whichever account signs it. */
function transferCall(client: Client<any, any>, asset: BountyAsset, dest: string, amount: bigint) {
  switch (asset.pallet) {
    case 'balances':
      return client.api.tx.balances.transferKeepAlive(dest, amount)
    case 'assets':
      return client.api.tx.assets.transferKeepAlive(asset.id, dest, amount)
    case 'foreignAssets':
      return (client.api.tx.foreignAssets as any).transferKeepAlive(asset.location, dest, amount)
  }
}

/**
 * The curator may raise a bounty's value. The curator deposit is re-priced for the new value, but
 * no funds move: the bounty account must be topped up separately before the extra can be paid.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Raise its value by one `BountyValueMinimum`'s worth, as alice
 * 3. Verify `BountyValueIncreased` with the old and new values, and `balances.Held` from alice for
 *    the deposit difference
 * 4. Verify the stored value, deposit record and alice's hold were updated, and the bounty account
 *    did not change
 */
async function increaseValueRepricesDeposit(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const rate = await rateOf(client, asset)
  const value = await parentValue(client, asset)
  const amount = fromNative(bountyMinimum(client), rate)
  const oldDeposit = curatorDepositFor(testConfig, toNative(value, rate))
  const newDeposit = curatorDepositFor(testConfig, toNative(value + amount, rate))
  expect(newDeposit).toBeGreaterThan(oldDeposit)

  // 1. Active bounty
  const index = await activeBounty(client, asset, value, alice)
  const holdBefore = await curatorHold(client, alice)
  const accountBefore = await balanceOf(client, asset, bountyAccount(client, index))

  // 2. Raise the value
  await sendTransaction(bountiesTx(client).increaseValue(index, amount).signAsync(alice))
  await client.dev.newBlock()

  // 3. BountyValueIncreased and Held
  await checkSystemEvents(client, ...DEPOSIT_EVENTS)
    .map(redactBountyIndex)
    .redact(volatileKeysWithAmounts(asset))
    .toMatchSnapshot('increase value: events')
  await expectNoExtrinsicFailure(client)
  const increased = await bountyEvent(client, 'BountyValueIncreased', index)
  expect(increased.data.oldValue.toBigInt()).toBe(value)
  expect(increased.data.newValue.toBigInt()).toBe(value + amount)
  expect((await balancesEvent(client, 'Held', alice)).data.amount.toBigInt()).toBe(newDeposit - oldDeposit)

  // 4. Value and deposit updated, no funds moved
  expect((await getBounty(client, index)).value.toBigInt()).toBe(value + amount)
  expect((await bountiesQuery(client).curatorDeposit(index, null)).unwrap().toBigInt()).toBe(newDeposit)
  expect(await curatorHold(client, alice)).toBe(holdBefore + newDeposit - oldDeposit)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(accountBefore)
}

/**
 * Raising a bounty's value does not fund the increase. Until the bounty account is topped up, an
 * award of the new value cannot be paid; once it is, the beneficiary receives the new value.
 *
 * 1. Make alice the active curator of a bounty, and raise its value by one child minimum's worth
 * 2. Award it to bob as alice, and verify the extrinsic failed with `PayoutError`
 * 3. Move the increase from the treasury to the bounty account: Root dispatches a transfer as the
 *    treasury pot
 * 4. Award it to bob as alice, and verify bob received the new value
 */
async function increaseValueThenAwardNeedsTopUp(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)
  const amount = await childValue(client, asset)

  // 1. Active bounty, value raised
  const index = await activeBounty(client, asset, value, alice)
  await sendTransaction(bountiesTx(client).increaseValue(index, amount).signAsync(alice))
  await client.dev.newBlock()
  await expectNoExtrinsicFailure(client)
  const bobBefore = await balanceOf(client, asset, addressOf(client, bob))

  // 2. Award fails
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award increased bounty before top-up: events')
  expectBountyError(client, await extrinsicError(client), 'PayoutError')
  expect((await getBounty(client, index)).status.isActive).toBe(true)

  // 3. Top up from the treasury. `dispatch_as` succeeds whatever the inner call does, so the
  // transfer's own result is read from `DispatchedAs`.
  const transfer = transferCall(client, asset, bountyAccount(client, index), amount)
  const topUp = client.api.tx.utility.dispatchAs({ system: { Signed: treasuryPot(client) } }, transfer)
  expectDispatchOk(await dispatchAs(client, topUp, ROOT))
  const dispatchedAs = (await client.api.query.system.events()).find(({ event }) =>
    client.api.events.utility.DispatchedAs.is(event),
  )
  assert(dispatchedAs && client.api.events.utility.DispatchedAs.is(dispatchedAs.event))
  expect(dispatchedAs.event.data.result.isOk, JSON.stringify(dispatchedAs.event.data.result.toHuman())).toBe(true)
  expect(await balanceOf(client, asset, bountyAccount(client, index))).toBe(value + amount)

  // 4. Award pays the new value
  await sendTransaction(bountiesTx(client).awardBounty(index, null, localBeneficiary(bob)).signAsync(alice))
  await client.dev.newBlock()
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('award increased bounty after top-up: events')
  await expectNoExtrinsicFailure(client)
  expect(await balanceOf(client, asset, addressOf(client, bob))).toBe(bobBefore + value + amount)
}

/**
 * Raising a bounty's value by nothing is refused.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Raise its value by zero, as alice
 * 3. Verify the extrinsic failed with `InvalidValue`, and the value is unchanged
 */
async function increaseValueByZeroFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)

  // 1. Active bounty
  const index = await activeBounty(client, asset, value, alice)

  // 2. Raise by zero
  await sendTransaction(bountiesTx(client).increaseValue(index, 0).signAsync(alice))
  await client.dev.newBlock()

  // 3. InvalidValue
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('increase value by zero: events')
  expectBountyError(client, await extrinsicError(client), 'InvalidValue')
  expect((await getBounty(client, index)).value.toBigInt()).toBe(value)
}

/**
 * Only the bounty's curator may raise its value, since the curator's deposit grows with it.
 *
 * 1. Make alice the active curator of a bounty
 * 2. Raise its value as charlie
 * 3. Verify the extrinsic failed with `RequireCurator`, and the value is unchanged
 */
async function increaseValueByNonCuratorFails(client: Client<any, any>, testConfig: MultiAssetBountiesTestConfig) {
  const asset = testConfig.primaryAsset
  const value = await parentValue(client, asset)

  // 1. Active bounty
  const index = await activeBounty(client, asset, value, alice)

  // 2. Raise as charlie
  await sendTransaction(
    bountiesTx(client)
      .increaseValue(index, await childValue(client, asset))
      .signAsync(charlie),
  )
  await client.dev.newBlock()

  // 3. RequireCurator
  await checkSystemEvents(client, ...BOUNTY_EVENTS)
    .map(redactBountyIndex)
    .redact(VOLATILE_KEYS)
    .toMatchSnapshot('increase value by non-curator: events')
  expectBountyError(client, await extrinsicError(client), 'RequireCurator')
  expect((await getBounty(client, index)).value.toBigInt()).toBe(value)
}

/// ----------
/// Test tree
/// ----------

/** Run `body`, or skip the test when the chain has no secondary asset configured. */
function withSecondaryAsset(
  testConfig: MultiAssetBountiesTestConfig,
  body: (asset: BountyAsset) => Promise<void>,
): (ctx?: TestContext) => Promise<void> {
  return async (ctx) => {
    if (!testConfig.secondaryAsset) {
      ctx?.skip('no second asset with a conversion rate is configured for this chain')
      return
    }
    await body(testConfig.secondaryAsset)
  }
}

export function multiAssetBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: MultiAssetBountiesTestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      await prepareSuite(client)
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
        label: 'Funding',
        children: [
          {
            kind: 'test',
            label: 'fund bounty in primary asset - BountyCreated, funds move',
            testFn: () => fundBountyMovesFunds(client, testConfig.primaryAsset),
          },
          {
            kind: 'test',
            label: 'fund bounty in secondary asset - BountyCreated, funds move',
            testFn: withSecondaryAsset(testConfig, (asset) => fundBountyMovesFunds(client, asset)),
          },
          {
            kind: 'test',
            label: 'fund at SmallTipper limit - BountyCreated',
            testFn: () => fundAtSmallTipperLimit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund above SmallTipper limit - InsufficientPermission',
            testFn: () => fundAboveSmallTipperLimitFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'two funds in one batch over SmallTipper limit - InsufficientPermission',
            testFn: () => batchedFundsShareSmallTipperLimit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund as signed account - BadOrigin',
            testFn: () => fundAsSignedFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund below BountyValueMinimum - InvalidValue',
            testFn: () => fundBelowMinimumFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund with unnoted metadata - PreimageNotExist',
            testFn: () => fundWithUnnotedMetadataFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund in unrated asset - FailedToConvertBalance',
            testFn: () => fundInUnratedAssetFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund more than the treasury holds - FundingError',
            testFn: () => fundBeyondTreasuryFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Payment status',
        children: [
          {
            kind: 'test',
            label: 'check status after funding - Funded',
            testFn: () => checkStatusAfterFunding(client, testConfig),
          },
          {
            kind: 'test',
            label: 'check status on Funded bounty - UnexpectedStatus',
            testFn: () => checkStatusOnFundedFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'retry payment already attempted - UnexpectedStatus',
            testFn: () => retryAttemptedPaymentFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'check status on unknown bounty - InvalidIndex',
            testFn: () => checkStatusOnUnknownBountyFails(client),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Curator',
        children: [
          {
            kind: 'test',
            label: 'accept curator - deposit held, Active',
            testFn: () => acceptCuratorHoldsDeposit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'accept curator of a large bounty - deposit capped at max',
            testFn: () => curatorDepositCappedAtMax(client, testConfig),
          },
          {
            kind: 'test',
            label: 'accept by account not proposed - RequireCurator',
            testFn: () => acceptByOtherAccountFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'accept without funds for the deposit - FundsUnavailable',
            testFn: () => acceptWithoutDepositFundsFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'curator unassigns self while Active - deposit released',
            testFn: () => curatorUnassignsSelf(client, testConfig),
          },
          {
            kind: 'test',
            label: 'Treasurer unassigns active curator - deposit burned',
            testFn: () => treasurerUnassignsCuratorBurnsDeposit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'SmallTipper unassigns curator - BadOrigin',
            testFn: () => smallTipperUnassignFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'proposed curator unassigns before accepting - no deposit moves',
            testFn: () => proposedCuratorUnassignsBeforeAccepting(client, testConfig),
          },
          {
            kind: 'test',
            label: 'propose curator after unassign as SmallTipper - CuratorProposed, then accepted',
            testFn: () => proposeCuratorAfterUnassign(client, testConfig),
          },
          {
            kind: 'test',
            label: 'propose curator as signed account - BadOrigin',
            testFn: () => proposeCuratorAsSignedFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'propose curator above SmallTipper limit - InsufficientPermission',
            testFn: () => proposeCuratorAboveSmallTipperFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'propose curator on Active bounty - UnexpectedStatus',
            testFn: () => proposeCuratorOnActiveFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Award',
        children: [
          {
            kind: 'test',
            label: 'award and settle in primary asset - beneficiary paid, bounty removed',
            testFn: () => awardAndSettle(client, testConfig.primaryAsset),
          },
          {
            kind: 'test',
            label: 'award and settle in secondary asset - beneficiary paid, bounty removed',
            testFn: withSecondaryAsset(testConfig, (asset) => awardAndSettle(client, asset)),
          },
          {
            kind: 'test',
            label: 'award by non-curator - RequireCurator',
            testFn: () => awardByNonCuratorFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'award to beneficiary on another chain - PayoutError',
            testFn: () => awardToRemoteBeneficiaryFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'award parent with active child - HasActiveChildBounty',
            testFn: () => awardParentWithActiveChildFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Close',
        children: [
          {
            kind: 'test',
            label: 'Treasurer closes Funded bounty - full refund',
            testFn: () => treasurerClosesFundedBounty(client, testConfig),
          },
          {
            kind: 'test',
            label: 'curator closes own Active bounty - refund, deposit released',
            testFn: () => curatorClosesOwnBounty(client, testConfig),
          },
          {
            kind: 'test',
            label: 'SmallTipper closes bounty - BadOrigin',
            testFn: () => smallTipperCloseFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'close parent with active child - HasActiveChildBounty',
            testFn: () => closeParentWithActiveChildFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'close parent after child payout - refund net of children, or RefundError',
            testFn: () => closeParentAfterChildPayout(client, testConfig),
          },
          {
            kind: 'test',
            label: 'close bounty with no curator - only the reject origin',
            testFn: () => closeUnassignedBountyNeedsRejectOrigin(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Child bounties',
        children: [
          {
            kind: 'test',
            label: 'fund child curated by parent curator - Active without deposit',
            testFn: () => fundChildWithParentCurator(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund child with its own curator - accept holds minimum deposit',
            testFn: () => fundChildWithOwnCurator(client, testConfig),
          },
          {
            kind: 'test',
            label: 'award child, then parent - parent payout reduced by child value',
            testFn: () => awardChildThenParent(client, testConfig),
          },
          {
            kind: 'test',
            label: 'close child - value returns to parent',
            testFn: () => closeChildReturnsValueToParent(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund child by non-curator - RequireCurator',
            testFn: () => fundChildByNonCuratorFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund child below ChildBountyValueMinimum - InvalidValue',
            testFn: () => fundChildBelowMinimumFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund child above remaining parent value - InsufficientBountyValue',
            testFn: () => fundChildAboveRemainingFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'fund child at active child limit - TooManyChildBounties',
            testFn: () => fundChildAtActiveLimitFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'parent curator unassigns child curator - deposit burned',
            testFn: () => parentCuratorUnassignsChildCurator(client, testConfig),
          },
          {
            kind: 'test',
            label: 'former parent curator unassigns child curator - BadOrigin',
            testFn: () => formerParentCuratorCannotUnassignChildCurator(client, testConfig),
          },
          {
            kind: 'test',
            label: 'propose child curator - Root BadOrigin, parent curator succeeds',
            testFn: () => proposeChildCuratorAsParentCurator(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Increase value',
        children: [
          {
            kind: 'test',
            label: 'increase value - deposit re-priced, no funds move',
            testFn: () => increaseValueRepricesDeposit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'increase value then award - PayoutError until topped up',
            testFn: () => increaseValueThenAwardNeedsTopUp(client, testConfig),
          },
          {
            kind: 'test',
            label: 'increase value by zero - InvalidValue',
            testFn: () => increaseValueByZeroFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'increase value by non-curator - RequireCurator',
            testFn: () => increaseValueByNonCuratorFails(client, testConfig),
          },
        ],
      },
    ],
  }
}
