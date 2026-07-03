import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { assertExpectedEvents, type TestConfig } from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/// -------
/// Constants
/// -------

// The Collectives parachain ID on Polkadot.
// This is the parachain in which the Fellowship salary pallet is deployed, and is used to build the
// cross-chain location of the salary sovereign.
export const COLLECTIVES_PARA_ID = 1001

// The pallet index for `pallet-ranked-collective` in the Collectives runtime.
// This is used when directly seeding Fellowship membership storage for focused salary tests.
export const FELLOWSHIP_COLLECTIVE_PALLET_INDEX = 60

// The pallet index for `pallet-core-fellowship` in the Collectives runtime.
// This identifies the pallet that stores active Fellowship member state used by salary eligibility checks.
export const FELLOWSHIP_CORE_PALLET_INDEX = 63

// The pallet index for `pallet-salary-fellowship` in the Collectives runtime.
// Together with the Collectives parachain ID, this determines the salary sovereign XCM location.
export const FELLOWSHIP_SALARY_PALLET_INDEX = 64

// The Dan-3 Fellowship rank used throughout these tests.
// Rank 3 is chosen because it has a live salary configured and is simple to seed directly into storage.
export const SALARY_MEMBER_RANK_DAN_3 = 3

// The Asset Hub asset ID for the USDT instance paid by the salary pallet today.
// Salary payout assertions query `pallet-assets` under this ID on Asset Hub.
export const SALARY_USDT_ASSET_ID = 1984

// Decimal base for USDT balances on Asset Hub.
// Kept here for readability in tests that need to reason about human-sized USDT amounts.
export const USDT_UNITS = 1_000_000n

// The validated XCM location of the Fellowship salary sovereign.
// This corresponds to `(Parent, Parachain(1001), PalletInstance(64))`, i.e. the salary pallet on
// Collectives viewed from Asset Hub, and is kept explicit because the derivation is non-obvious.
export const SALARY_SOVEREIGN_LOCATION = {
  parents: 1,
  interior: {
    X2: [{ Parachain: COLLECTIVES_PARA_ID }, { PalletInstance: FELLOWSHIP_SALARY_PALLET_INDEX }],
  },
} as const

// The sovereign account for the Fellowship salary pallet on Asset Hub Polkadot.
// Source-backed by the Asset Hub runtime XCM configuration tests in
// `asset-hub-polkadot/src/xcm_config.rs`, where the location/account derivation is validated.
export const SALARY_SOVEREIGN_ADDRESS = '13w7NdvSR1Af8xsQTArDtZmVvjE8XhWNdL4yed3iFHrUNCnS'

// Default free balance given to synthetic Fellowship members created for salary tests.
// It is intentionally generous so fees never interfere with the salary lifecycle assertions.
const DEFAULT_SALARY_TEST_FREE_BALANCE = 1_000n * 10n ** 10n

/// -------
/// Types
/// -------

/**
 * Salary-related parameters read from `fellowshipCore.params()`.
 *
 * These arrays are runtime-configured by Fellowship rank and are consumed by the salary pallet when
 * determining registration amounts, promotion timing, and offboarding behavior.
 */
export interface FellowshipSalaryParams {
  activeSalary: bigint[]
  passiveSalary: bigint[]
  demotionPeriod: number[]
  minPromotionPeriod: number[]
  offboardTimeout: number
}

/**
 * Normalized salary runtime configuration assembled from storage and constants.
 *
 * This combines `fellowshipCore.params()` with `fellowshipSalary` constants so tests can reason about
 * windows and payout amounts using a single TypeScript shape.
 */
export interface FellowshipSalaryRuntimeConfig {
  params: FellowshipSalaryParams
  registrationPeriod: number
  payoutPeriod: number
  cyclePeriod: number
  budget: bigint
}

/**
 * Decoded representation of `fellowshipSalary.status`, when present.
 *
 * The chain stores this as an optional status struct; the helper readers in this file map it into this
 * more ergonomic TypeScript object.
 */
export interface FellowshipSalaryStatus {
  cycleIndex: number
  cycleStart: number
  budget: bigint
  totalRegistrations: bigint
  totalUnregisteredPaid: bigint
}

/**
 * Decoded representation of `fellowshipSalary.claimant(address)`.
 *
 * The underlying runtime enum has three variants; this type flattens them into a discriminated union-like
 * object that is easier to assert on in tests.
 */
export interface FellowshipSalaryClaimantState {
  lastActive: number
  kind: 'nothing' | 'registered' | 'attempted'
  registeredAmount: bigint | null
  attemptedPaymentId: string | null
  attemptedAmount: bigint | null
}

/// -------
/// Internal helpers
/// -------

/**
 * Create a deterministic keypair for salary tests from a URI seed.
 *
 * Test-specific seeds such as `//salary_raw_member` produce isolated accounts whose addresses remain
 * stable across runs, making storage seeding and event assertions reproducible.
 */
function createSalaryTestMember(seed: string): KeyringPair {
  return testAccounts.keyring.createFromUri(seed)
}

/**
 * Assert that salary status exists and return the narrowed value.
 *
 * Many helpers require the salary cycle to have been initialized already, so this serves as a compact
 * assertion guard that turns a nullable read into a concrete status object.
 */
function requireSalaryStatus(status: FellowshipSalaryStatus | null): FellowshipSalaryStatus {
  assert(status !== null, 'Expected fellowship salary status to exist')
  return status
}

/**
 * Read the current chain head number.
 *
 * This tiny wrapper exists so cycle-window helpers can express their intent in salary-domain terms rather
 * than repeating the raw RPC call each time.
 */
async function currentBlockNumber(client: Client<any, any>): Promise<number> {
  return (await client.api.rpc.chain.getHeader()).number.toNumber()
}

/**
 * Read the current block's system events.
 *
 * Salary helpers frequently submit one extrinsic and then inspect the produced events, so this keeps those
 * call sites terse and consistent.
 */
async function systemEvents(client: Client<any, any>) {
  return await client.api.query.system.events()
}

/**
 * Check whether an event list contains an event matching a Polkadot.js event matcher.
 *
 * This is used for optional event families where the exact pallet can differ across runtimes, such as the
 * source-side XCM dispatch event emitted during salary payout.
 */
function hasEvent(events: any[], matcher: { is: (event: any) => boolean } | undefined): boolean {
  return matcher ? events.some(({ event }) => matcher.is(event)) : false
}

/**
 * Assert that the salary payout source chain emitted an XCM dispatch signal.
 *
 * Depending on runtime wiring, the outbound dispatch can surface as either `xcmpQueue.XcmpMessageSent` or
 * `polkadotXcm.Sent`. This helper accepts either to prove the payout left Collectives toward Asset Hub.
 */
function expectSourceChainXcmDispatch(client: Client<any, any>, events: any[]): void {
  expect(
    hasEvent(events, client.api.events.xcmpQueue?.XcmpMessageSent) ||
      hasEvent(events, client.api.events.polkadotXcm?.Sent),
    'Expected the source chain to emit an XCM dispatch event',
  ).toBe(true)
}

/// -------
/// Storage readers
/// -------

/**
 * Read the salary runtime configuration from live chain state.
 *
 * This pulls rank-dependent salary parameters from `fellowshipCore.params()` and combines them with the
 * `fellowshipSalary` pallet constants for registration period, payout period, and budget.
 */
export async function readSalaryRuntimeConfig(client: Client<any, any>): Promise<FellowshipSalaryRuntimeConfig> {
  const params = await (client.api.query as any).fellowshipCore.params()
  const paramsJson = params.toJSON() as {
    activeSalary: Array<number | string>
    passiveSalary: Array<number | string>
    demotionPeriod: Array<number | string>
    minPromotionPeriod: Array<number | string>
    offboardTimeout: number | string
  }

  const registrationPeriod = Number(client.api.consts.fellowshipSalary.registrationPeriod.toString())
  const payoutPeriod = Number(client.api.consts.fellowshipSalary.payoutPeriod.toString())

  return {
    params: {
      activeSalary: paramsJson.activeSalary.map((value) => BigInt(value.toString())),
      passiveSalary: paramsJson.passiveSalary.map((value) => BigInt(value.toString())),
      demotionPeriod: paramsJson.demotionPeriod.map((value) => Number(value)),
      minPromotionPeriod: paramsJson.minPromotionPeriod.map((value) => Number(value)),
      offboardTimeout: Number(paramsJson.offboardTimeout),
    },
    registrationPeriod,
    payoutPeriod,
    cyclePeriod: registrationPeriod + payoutPeriod,
    budget: BigInt(client.api.consts.fellowshipSalary.budget.toString()),
  }
}

/**
 * Read `fellowshipSalary.status` and map the optional chain value into a nullable TypeScript object.
 *
 * The runtime stores cycle status in an `Option`; tests generally want either a decoded object or `null`
 * without having to deal with codec wrappers.
 */
export async function readSalaryStatus(client: Client<any, any>): Promise<FellowshipSalaryStatus | null> {
  const status = (await client.api.query.fellowshipSalary.status()) as any
  if (status.isNone) return null

  const value = status.unwrap() as any
  return {
    cycleIndex: value.cycleIndex.toNumber(),
    cycleStart: value.cycleStart.toNumber(),
    budget: BigInt(value.budget.toString()),
    totalRegistrations: BigInt(value.totalRegistrations.toString()),
    totalUnregisteredPaid: BigInt(value.totalUnregisteredPaid.toString()),
  }
}

/**
 * Read and decode a salary claimant entry for a given Fellowship member.
 *
 * The on-chain claimant status is a three-variant enum: no registration yet, currently registered, or a
 * payout attempt already recorded. This helper discriminates those variants into a test-friendly shape.
 */
export async function readSalaryClaimant(
  client: Client<any, any>,
  address: string,
): Promise<FellowshipSalaryClaimantState | null> {
  const claimant = (await client.api.query.fellowshipSalary.claimant(address)) as any
  if (claimant.isNone) return null

  const claimantJson = claimant.unwrap().toJSON() as {
    lastActive: number | string
    status:
      | { nothing: null }
      | { registered: number | string }
      | { attempted: { registered: number | string | null; id: number | string; amount: number | string } }
  }

  if ('nothing' in claimantJson.status) {
    return {
      lastActive: Number(claimantJson.lastActive),
      kind: 'nothing',
      registeredAmount: null,
      attemptedPaymentId: null,
      attemptedAmount: null,
    }
  }

  if ('registered' in claimantJson.status) {
    return {
      lastActive: Number(claimantJson.lastActive),
      kind: 'registered',
      registeredAmount: BigInt(claimantJson.status.registered.toString()),
      attemptedPaymentId: null,
      attemptedAmount: null,
    }
  }

  return {
    lastActive: Number(claimantJson.lastActive),
    kind: 'attempted',
    registeredAmount:
      claimantJson.status.attempted.registered === null
        ? null
        : BigInt(claimantJson.status.attempted.registered.toString()),
    attemptedPaymentId: claimantJson.status.attempted.id.toString(),
    attemptedAmount: BigInt(claimantJson.status.attempted.amount.toString()),
  }
}

/**
 * Return the active salary configured for a Fellowship rank.
 *
 * `pallet-core-fellowship` stores rank salaries in zero-indexed arrays even though ranks are one-indexed,
 * so rank `n` must be read from array slot `n - 1`.
 */
export function activeSalaryForRank(params: FellowshipSalaryParams, rank: number): bigint {
  expect(rank).toBeGreaterThan(0)
  expect(rank).toBeLessThanOrEqual(params.activeSalary.length)

  /// `pallet-core-fellowship` stores salaries in rank-1 array slots.

  return params.activeSalary[rank - 1]
}

/**
 * Read a USDT balance from Asset Hub's `pallet-assets` storage.
 *
 * Salary payouts currently land as the asset identified by `SALARY_USDT_ASSET_ID`, so these tests query
 * `Assets.account(assetId, address)` and default to zero when no account exists.
 */
export async function usdtBalance(assetHubClient: Client<any, any>, address: string): Promise<bigint> {
  const balance = (await assetHubClient.api.query.assets.account(SALARY_USDT_ASSET_ID, address)) as any
  return balance.isSome ? (balance.unwrap() as any).balance.toBigInt() : 0n
}

/// -------
/// Storage writers/seeders
/// -------

/**
 * Seed a fresh Dan-3 Fellowship member directly into the storages required by salary tests.
 *
 * This injects: a funded `System.account`, ranked-collective membership/indexing entries, and active
 * `FellowshipCore.member` state. Together these make the account look like a live Dan-3 Fellow without
 * having to exercise the full governance onboarding path in each test.
 */
export async function seedDan3SalaryMember(
  client: Client<any, any>,
  member: KeyringPair,
  freeBalance: bigint = DEFAULT_SALARY_TEST_FREE_BALANCE,
): Promise<void> {
  await client.dev.setStorage({
    System: {
      account: [[[member.address], { providers: 1, data: { free: freeBalance, frozen: 0, reserved: 0 } }]],
    },
    FellowshipCollective: {
      members: [[[member.address], { rank: SALARY_MEMBER_RANK_DAN_3 }]],
      memberCount: [
        [[0], 1],
        [[1], 1],
        [[2], 1],
        [[3], 1],
      ],
      idToIndex: [
        [[0, member.address], 0],
        [[1, member.address], 0],
        [[2, member.address], 0],
        [[3, member.address], 0],
      ],
      indexToId: [
        [[0, 0], member.address],
        [[1, 0], member.address],
        [[2, 0], member.address],
        [[3, 0], member.address],
      ],
    },
    FellowshipCore: {
      member: [[[member.address], { isActive: true, lastPromotion: 0, lastProof: 0 }]],
    },
  })
}

/**
 * Seed a member's salary claimant state directly into `fellowshipSalary.claimant`.
 *
 * Tests that do not exercise `induct()` or `register()` use this to place the claimant into the
 * required state without invoking the extrinsics under test. The claimant struct mirrors
 * `ClaimantStatus` from `pallet-salary/src/lib.rs`.
 *
 * @param lastActive   The cycle index the claimant last interacted in.
 * @param status       One of `'Nothing'`, `{ Registered: amount }`, or
 *                     `{ Attempted: { registered, id, amount } }`, matching the runtime enum.
 */
export async function seedSalaryClaimant(
  client: Client<any, any>,
  memberAddress: string,
  lastActive: number,
  status: Record<string, unknown>,
): Promise<void> {
  await client.dev.setStorage({
    FellowshipSalary: {
      claimant: [[[memberAddress], { lastActive, status }]],
    },
  })
}

/**
 * Seed the salary sovereign's USDT balance on Asset Hub.
 *
 * Salary payouts are funded out of the sovereign account via `pallet-assets`, so tests preload that account
 * with enough USDT to satisfy the expected payment flow.
 */
export async function fundSalarySovereignUsdt(assetHubClient: Client<any, any>, amount: bigint): Promise<void> {
  await assetHubClient.dev.setStorage({
    Assets: {
      account: [[[SALARY_USDT_ASSET_ID, SALARY_SOVEREIGN_ADDRESS], { balance: amount.toString() }]],
    },
  })
}

/// -------
/// Time manipulation
/// -------

/**
 * Ensure the salary cycle has been initialized, starting it if necessary.
 *
 * Live forks usually already have salary running, but older blocks may predate the first cycle. This helper
 * is intentionally idempotent so tests can call it unconditionally.
 */
export async function ensureSalaryCycleStarted(
  client: Client<any, any>,
  signer: KeyringPair,
): Promise<FellowshipSalaryStatus> {
  const status = await readSalaryStatus(client)
  if (status !== null) return status

  await sendTransaction(client.api.tx.fellowshipSalary.init().signAsync(signer))
  await client.dev.newBlock()

  assertExpectedEvents(await systemEvents(client), [{ type: client.api.events.fellowshipSalary.CycleStarted }])

  return requireSalaryStatus(await readSalaryStatus(client))
}

/**
 * Rewrite only the `cycleStart` field of the live salary status.
 *
 * Tests use this internal helper to move the chain logically into a different salary window while keeping
 * all other status fields unchanged and still exercising the real pallet extrinsics afterwards.
 */
async function setSalaryCycleStart(client: Client<any, any>, cycleStart: number): Promise<FellowshipSalaryStatus> {
  const status = requireSalaryStatus(await readSalaryStatus(client))

  await client.dev.setStorage({
    FellowshipSalary: {
      status: {
        cycleIndex: status.cycleIndex,
        cycleStart,
        budget: status.budget.toString(),
        totalRegistrations: status.totalRegistrations.toString(),
        totalUnregisteredPaid: status.totalUnregisteredPaid.toString(),
      },
    },
  })

  return requireSalaryStatus(await readSalaryStatus(client))
}

/**
 * Move the current salary cycle into its registration window.
 *
 * This is done by setting `cycleStart` equal to the current block, making the cycle appear freshly started.
 */
export async function setSalaryCycleToRegistrationWindow(client: Client<any, any>): Promise<FellowshipSalaryStatus> {
  return await setSalaryCycleStart(client, await currentBlockNumber(client))
}

/**
 * Move the current salary cycle into its payout window.
 *
 * The helper rewinds `cycleStart` far enough that registration has elapsed, but the overall cycle has not yet
 * reached the next bump boundary.
 */
export async function setSalaryCycleToPayoutWindow(
  client: Client<any, any>,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = await currentBlockNumber(client)
  return await setSalaryCycleStart(client, block - runtimeConfig.registrationPeriod - 1)
}

/**
 * Move the current salary cycle past its bump boundary.
 *
 * After this adjustment, the runtime should consider the cycle expired, allowing the real `bump()` extrinsic
 * to start the next cycle.
 */
export async function setSalaryCycleToBumpWindow(
  client: Client<any, any>,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = await currentBlockNumber(client)
  return await setSalaryCycleStart(client, block - runtimeConfig.cyclePeriod - 1)
}

/**
 * Advance to the next salary cycle using storage time manipulation plus the real `bump()` extrinsic.
 *
 * Tests first place the status into the bump window and then submit the actual pallet call so emitted events
 * and status transitions still reflect real runtime behavior.
 */
export async function bumpToNextSalaryCycle(
  client: Client<any, any>,
  signer: KeyringPair,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<any[]> {
  await setSalaryCycleToBumpWindow(client, runtimeConfig)
  await sendTransaction(client.api.tx.fellowshipSalary.bump().signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/// -------
/// Salary lifecycle operations
/// -------

/**
 * Submit `fellowshipSalary.induct()` for a Fellowship member and return the resulting system events.
 *
 * This is a thin wrapper around the real extrinsic so tests can express salary-lifecycle intent directly.
 */
export async function inductSalaryMember(client: Client<any, any>, signer: KeyringPair): Promise<any[]> {
  await sendTransaction(client.api.tx.fellowshipSalary.induct().signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/**
 * Submit `fellowshipSalary.register()` for a Fellowship member and return the resulting system events.
 *
 * Registration records the member's salary amount for the current cycle, based on the live runtime params.
 */
export async function registerSalaryMember(client: Client<any, any>, signer: KeyringPair): Promise<any[]> {
  await sendTransaction(client.api.tx.fellowshipSalary.register().signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/**
 * Submit a salary payout extrinsic and return the resulting system events.
 *
 * When `beneficiary` is omitted this uses `payout()`, otherwise it uses `payoutOther(beneficiary)` to direct
 * the Asset Hub transfer to another account.
 */
export async function payoutSalaryMember(
  client: Client<any, any>,
  signer: KeyringPair,
  beneficiary?: string,
): Promise<any[]> {
  const call = beneficiary
    ? client.api.tx.fellowshipSalary.payoutOther(beneficiary)
    : client.api.tx.fellowshipSalary.payout()

  await sendTransaction(call.signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/**
 * Advance Asset Hub by one block so an outbound salary XCM can be executed there.
 *
 * The source-side Collectives payout only queues the message; this helper produces the destination block in
 * which `messageQueue.Processed` and the resulting asset transfer should appear.
 */
export async function processSalaryPayoutOnAssetHub(assetHubClient: Client<any, any>): Promise<any[]> {
  await assetHubClient.dev.newBlock()
  return await systemEvents(assetHubClient)
}

/// -------
/// Test functions
/// -------

/**
 * Exercise the full salary lifecycle against live runtime behavior, using direct storage seeding only for setup.
 *
 * The test covers member induction, cycle advancement, registration, payout dispatch from Collectives, and
 * final USDT delivery to the beneficiary on Asset Hub.
 */
export async function salaryLifecycleRawTest(collectivesClient: Client<any, any>, assetHubClient: Client<any, any>) {
  const api = collectivesClient.api
  const member = createSalaryTestMember('//salary_raw_member')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)
  const liveStatusBefore = await readSalaryStatus(collectivesClient)

  if (liveStatusBefore !== null) {
    expect(liveStatusBefore.budget).toBe(runtimeConfig.budget)
  }

  ///
  /// 1. Seed a fresh Dan-3 Fellowship member directly into the ranked collective/core storage.
  ///

  await collectivesClient.dev.setStorage({
    System: {
      account: [
        [[member.address], { providers: 1, data: { free: DEFAULT_SALARY_TEST_FREE_BALANCE, frozen: 0, reserved: 0 } }],
      ],
    },
    FellowshipCollective: {
      members: [[[member.address], { rank: SALARY_MEMBER_RANK_DAN_3 }]],
      memberCount: [
        [[0], 1],
        [[1], 1],
        [[2], 1],
        [[3], 1],
      ],
      idToIndex: [
        [[0, member.address], 0],
        [[1, member.address], 0],
        [[2, member.address], 0],
        [[3, member.address], 0],
      ],
      indexToId: [
        [[0, 0], member.address],
        [[1, 0], member.address],
        [[2, 0], member.address],
        [[3, 0], member.address],
      ],
    },
    FellowshipCore: {
      member: [[[member.address], { isActive: true, lastPromotion: 0, lastProof: 0 }]],
    },
  })

  ///
  /// 2. Seed the validated salary sovereign account on Asset Hub with enough USDT for one payout.
  ///

  await assetHubClient.dev.setStorage({
    Assets: {
      account: [[[SALARY_USDT_ASSET_ID, SALARY_SOVEREIGN_ADDRESS], { balance: runtimeConfig.budget.toString() }]],
    },
  })

  ///
  /// 3. Live Collectives forks already have salary running, but bootstrap `init()` if the forked
  ///    block predates the first cycle.
  ///

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()

    assertExpectedEvents(await systemEvents(collectivesClient), [{ type: api.events.fellowshipSalary.CycleStarted }])
    status = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  }

  ///
  /// 4. Induct the member into the payroll.
  ///

  /// The Collectives parachain uses SS58 prefix 0 (Polkadot), while test accounts are generated
  /// with the generic Substrate prefix 42. Events encode addresses in the chain's native prefix,
  /// so we must re-encode the member address for event assertions.
  const addressEncoding = collectivesClient.config.properties.addressEncoding
  const memberAddress = encodeAddress(member.address, addressEncoding)

  await sendTransaction(api.tx.fellowshipSalary.induct().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterInduct = await systemEvents(collectivesClient)
  assertExpectedEvents(eventsAfterInduct, [
    { type: api.events.fellowshipSalary.Inducted, args: { who: memberAddress } },
  ])

  const claimantAfterInduct = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimantAfterInduct !== null)
  expect(claimantAfterInduct.kind).toBe('nothing')
  expect(claimantAfterInduct.lastActive).toBe(status.cycleIndex)

  ///
  /// 5. A newly inducted member cannot register until the next cycle, so fast-forward the current
  ///    one by editing `cycleStart` and then use the real `bump()` extrinsic.
  ///

  const blockBeforeBump = await currentBlockNumber(collectivesClient)
  await collectivesClient.dev.setStorage({
    FellowshipSalary: {
      status: {
        cycleIndex: status.cycleIndex,
        cycleStart: blockBeforeBump - runtimeConfig.cyclePeriod - 1,
        budget: status.budget.toString(),
        totalRegistrations: status.totalRegistrations.toString(),
        totalUnregisteredPaid: status.totalUnregisteredPaid.toString(),
      },
    },
  })

  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterBump = await systemEvents(collectivesClient)
  assertExpectedEvents(eventsAfterBump, [{ type: api.events.fellowshipSalary.CycleStarted }])

  status = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(status.budget).toBe(runtimeConfig.budget)
  expect(status.totalRegistrations).toBe(0n)
  expect(status.totalUnregisteredPaid).toBe(0n)

  ///
  /// 6. Register for the new cycle. The payout amount comes from live `fellowshipCore.params()`.
  ///

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterRegister = await systemEvents(collectivesClient)
  assertExpectedEvents(eventsAfterRegister, [
    {
      type: api.events.fellowshipSalary.Registered,
      args: { who: memberAddress, amount: expectedSalary.toString() },
    },
  ])

  const claimantAfterRegister = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimantAfterRegister !== null)
  expect(claimantAfterRegister.kind).toBe('registered')
  expect(claimantAfterRegister.registeredAmount).toBe(expectedSalary)

  status = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(status.totalRegistrations).toBe(expectedSalary)

  ///
  /// 7. Enter the payout window by rewinding `cycleStart` past `registrationPeriod`.
  ///

  const blockBeforePayout = await currentBlockNumber(collectivesClient)
  await collectivesClient.dev.setStorage({
    FellowshipSalary: {
      status: {
        cycleIndex: status.cycleIndex,
        cycleStart: blockBeforePayout - runtimeConfig.registrationPeriod - 1,
        budget: status.budget.toString(),
        totalRegistrations: status.totalRegistrations.toString(),
        totalUnregisteredPaid: status.totalUnregisteredPaid.toString(),
      },
    },
  })

  const assetHubBalanceBefore = await usdtBalance(assetHubClient, member.address)

  ///
  /// 8. Pay the salary. The paymaster dispatches XCM toward Asset Hub.
  ///

  await sendTransaction(api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterPayout = await systemEvents(collectivesClient)
  assertExpectedEvents(eventsAfterPayout, [
    {
      type: api.events.fellowshipSalary.Paid,
      args: {
        who: memberAddress,
        beneficiary: memberAddress,
        amount: expectedSalary.toString(),
      },
    },
  ])

  /// Verify that the source chain actually dispatched the outbound XCM and did not only mutate local state.

  expectSourceChainXcmDispatch(collectivesClient, eventsAfterPayout as any[])

  const claimantAfterPayout = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimantAfterPayout !== null)
  expect(claimantAfterPayout.kind).toBe('attempted')
  expect(claimantAfterPayout.registeredAmount).toBe(expectedSalary)
  expect(claimantAfterPayout.attemptedAmount).toBe(expectedSalary)
  expect(claimantAfterPayout.attemptedPaymentId).not.toBeNull()

  ///
  /// 9. Process the horizontal XCM on Asset Hub and verify the USDT transfer landed.
  ///

  await assetHubClient.dev.newBlock()
  const assetHubEvents = await systemEvents(assetHubClient)

  assertExpectedEvents(assetHubEvents, [
    { type: assetHubClient.api.events.messageQueue.Processed },
    { type: assetHubClient.api.events.assets.Transferred },
  ])

  const assetHubBalanceAfter = await usdtBalance(assetHubClient, member.address)
  expect(assetHubBalanceAfter - assetHubBalanceBefore).toBe(expectedSalary)
}

/**
 * Verify that `fellowshipSalary.status` reflects the expected values across a full cycle transition.
 *
 * This focuses on storage-level invariants for cycle index, budget, registration totals, and paid totals
 * after induction, bump, registration, and payout.
 */
export async function salaryStatusStorageTest(collectivesClient: Client<any, any>, assetHubClient: Client<any, any>) {
  const member = createSalaryTestMember('//salary_status_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  await seedDan3SalaryMember(collectivesClient, member)
  await fundSalarySovereignUsdt(assetHubClient, runtimeConfig.budget)

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// Induction does not touch `fellowshipSalary.status`, so it is seeded directly here rather
  /// than invoked, leaving the test focused on the mutations made by `bump`, `register`, and `payout`.

  const cycleIndex = requireSalaryStatus(await readSalaryStatus(collectivesClient)).cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  const statusAfterInduct = requireSalaryStatus(await readSalaryStatus(collectivesClient))

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  const statusAfterBump = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(statusAfterBump.cycleIndex).toBe(statusAfterInduct.cycleIndex + 1)
  expect(statusAfterBump.budget).toBe(runtimeConfig.budget)
  expect(statusAfterBump.totalRegistrations).toBe(0n)
  expect(statusAfterBump.totalUnregisteredPaid).toBe(0n)

  await registerSalaryMember(collectivesClient, member)
  const statusAfterRegister = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(statusAfterRegister.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterRegister.totalUnregisteredPaid).toBe(0n)

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)
  await payoutSalaryMember(collectivesClient, member)

  const statusAfterPayout = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(statusAfterPayout.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterPayout.totalUnregisteredPaid).toBe(0n)
}

/**
 * Verify that a salary payout sent to an explicit beneficiary arrives on Asset Hub as USDT.
 *
 * This covers the cross-chain path from Collectives `payoutOther` through outbound XCM dispatch and final
 * `pallet-assets` balance increase for the beneficiary.
 */
export async function salaryPayoutDeliversUsdtToAssetHubBeneficiaryTest(
  collectivesClient: Client<any, any>,
  assetHubClient: Client<any, any>,
) {
  const member = createSalaryTestMember('//salary_cross_chain_member')
  const beneficiary = createSalaryTestMember('//salary_cross_chain_beneficiary')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  await seedDan3SalaryMember(collectivesClient, member)
  await fundSalarySovereignUsdt(assetHubClient, runtimeConfig.budget)

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// Induction and registration are prerequisites, not the subject of this test. The claimant is
  /// seeded into the `Registered` state directly so the payout XCM — the actual subject — can be
  /// exercised in isolation.

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  const cycleIndex = requireSalaryStatus(await readSalaryStatus(collectivesClient)).cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, {
    Registered: expectedSalary.toString(),
  })
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  const balanceBefore = await usdtBalance(assetHubClient, beneficiary.address)
  const payoutEvents = await payoutSalaryMember(collectivesClient, member, beneficiary.address)

  /// Re-encode addresses for event assertions (see SS58 note in salaryLifecycleRawTest)
  const addressEncoding = collectivesClient.config.properties.addressEncoding
  const memberAddress = encodeAddress(member.address, addressEncoding)
  const beneficiaryAddress = encodeAddress(beneficiary.address, addressEncoding)

  assertExpectedEvents(payoutEvents, [
    {
      type: collectivesClient.api.events.fellowshipSalary.Paid,
      args: {
        who: memberAddress,
        beneficiary: beneficiaryAddress,
        amount: expectedSalary.toString(),
      },
    },
  ])
  expectSourceChainXcmDispatch(collectivesClient, payoutEvents as any[])

  const assetHubEvents = await processSalaryPayoutOnAssetHub(assetHubClient)
  assertExpectedEvents(assetHubEvents, [
    { type: assetHubClient.api.events.messageQueue.Processed },
    { type: assetHubClient.api.events.assets.Transferred },
  ])

  const balanceAfter = await usdtBalance(assetHubClient, beneficiary.address)
  expect(balanceAfter - balanceBefore).toBe(expectedSalary)
}

/**
 * Verify that an unregistered fellow receives payment from the residual pot.
 *
 * The salary pallet pays unregistered fellows `min(ideal_salary, pot)` where:
 * `pot = budget - total_registrations - total_unregistered_paid`
 *
 * This test seeds two fellows: one registers, one does not. The unregistered fellow should still
 * receive a payout from the remaining budget after registrations are accounted for.
 */
export async function salaryUnregisteredPayoutTest(
  collectivesClient: Client<any, any>,
  assetHubClient: Client<any, any>,
) {
  const registeredMember = createSalaryTestMember('//salary_unregistered_test_registered')
  const unregisteredMember = createSalaryTestMember('//salary_unregistered_test_unregistered')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  await seedDan3SalaryMember(collectivesClient, registeredMember)
  await seedDan3SalaryMember(collectivesClient, unregisteredMember)
  await fundSalarySovereignUsdt(assetHubClient, runtimeConfig.budget)

  await ensureSalaryCycleStarted(collectivesClient, registeredMember)

  /// Induct both members.

  const cycleIndex = requireSalaryStatus(await readSalaryStatus(collectivesClient)).cycleIndex
  await seedSalaryClaimant(collectivesClient, registeredMember.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, unregisteredMember.address, cycleIndex, { Nothing: null })

  /// Bump to next cycle so they can register.

  await bumpToNextSalaryCycle(collectivesClient, registeredMember, runtimeConfig)

  /// Only the registered member registers.

  await registerSalaryMember(collectivesClient, registeredMember)

  const statusAfterRegister = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(statusAfterRegister.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterRegister.totalUnregisteredPaid).toBe(0n)

  /// Move to payout window.

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// Pay the registered member first.

  const registeredBalanceBefore = await usdtBalance(assetHubClient, registeredMember.address)
  await payoutSalaryMember(collectivesClient, registeredMember)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const registeredBalanceAfter = await usdtBalance(assetHubClient, registeredMember.address)
  expect(registeredBalanceAfter - registeredBalanceBefore).toBe(expectedSalary)

  /// Now pay the unregistered member. They should get `min(ideal_salary, pot)`.
  /// pot = budget - total_registrations - total_unregistered_paid = budget - expectedSalary - 0

  const pot = runtimeConfig.budget - expectedSalary
  const expectedUnregisteredPayout = expectedSalary < pot ? expectedSalary : pot

  const unregisteredBalanceBefore = await usdtBalance(assetHubClient, unregisteredMember.address)
  await payoutSalaryMember(collectivesClient, unregisteredMember)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const unregisteredBalanceAfter = await usdtBalance(assetHubClient, unregisteredMember.address)

  expect(unregisteredBalanceAfter - unregisteredBalanceBefore).toBe(expectedUnregisteredPayout)

  /// Verify total_unregistered_paid was updated.

  const statusAfterUnregistered = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  expect(statusAfterUnregistered.totalUnregisteredPaid).toBe(expectedUnregisteredPayout)
}

/**
 * Verify that when registrations exceed budget, payouts are prorated.
 *
 * When `total_registrations > budget`, each registered fellow receives:
 * `(registered_amount * budget) / total_registrations`
 *
 * This test seeds multiple fellows whose combined salaries exceed the budget, then verifies
 * that payouts are scaled down proportionally.
 */
export async function salaryProrationTest(collectivesClient: Client<any, any>, assetHubClient: Client<any, any>) {
  const member1 = createSalaryTestMember('//salary_proration_member_1')
  const member2 = createSalaryTestMember('//salary_proration_member_2')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const salaryPerMember = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// Create a scenario where total registrations exceed budget by seeding a very small budget.

  const smallBudget = salaryPerMember / 2n

  await seedDan3SalaryMember(collectivesClient, member1)
  await seedDan3SalaryMember(collectivesClient, member2)
  await fundSalarySovereignUsdt(assetHubClient, salaryPerMember * 2n)

  await ensureSalaryCycleStarted(collectivesClient, member1)

  /// Induct both members.

  const cycleIndex = requireSalaryStatus(await readSalaryStatus(collectivesClient)).cycleIndex
  await seedSalaryClaimant(collectivesClient, member1.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, member2.address, cycleIndex, { Nothing: null })

  /// Bump to next cycle and override budget to be smaller than total registrations.

  await bumpToNextSalaryCycle(collectivesClient, member1, runtimeConfig)

  const statusAfterBump = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  await collectivesClient.dev.setStorage({
    FellowshipSalary: {
      status: {
        cycleIndex: statusAfterBump.cycleIndex,
        cycleStart: statusAfterBump.cycleStart,
        budget: smallBudget.toString(),
        totalRegistrations: '0',
        totalUnregisteredPaid: '0',
      },
    },
  })

  /// Both members register. Total registrations = 2 * salaryPerMember > smallBudget.

  await registerSalaryMember(collectivesClient, member1)
  await registerSalaryMember(collectivesClient, member2)

  const statusAfterRegister = requireSalaryStatus(await readSalaryStatus(collectivesClient))
  const totalRegistrations = statusAfterRegister.totalRegistrations
  expect(totalRegistrations).toBe(salaryPerMember * 2n)
  expect(totalRegistrations).toBeGreaterThan(smallBudget)

  /// Move to payout window.

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// Pay member1. They should receive prorated amount: (salary * budget) / total_registrations.

  const expectedProrated = (salaryPerMember * smallBudget) / totalRegistrations

  const balance1Before = await usdtBalance(assetHubClient, member1.address)
  await payoutSalaryMember(collectivesClient, member1)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const balance1After = await usdtBalance(assetHubClient, member1.address)

  const received1 = balance1After - balance1Before
  expect(received1).toBe(expectedProrated)

  /// Pay member2. They should also receive the same prorated amount.

  const balance2Before = await usdtBalance(assetHubClient, member2.address)
  await payoutSalaryMember(collectivesClient, member2)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const balance2After = await usdtBalance(assetHubClient, member2.address)

  const received2 = balance2After - balance2Before
  expect(received2).toBe(expectedProrated)

  /// Total paid should be <= small budget (may be slightly less due to integer division rounding).

  expect(received1 + received2).toBeLessThanOrEqual(smallBudget)
  expect(received1 + received2).toBeGreaterThanOrEqual(smallBudget - 2n)
}

/// -------
/// Test tree builder
/// -------

/**
 * Build the base end-to-end salary test tree shared by network-specific suites.
 *
 * The returned tree wires together Collectives and Asset Hub clients, snapshot restoration, teardown,
 * and the individual salary test groups exported from this module.
 */
export function baseSalaryE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesCollectives extends Record<string, Record<string, any>> | undefined,
  TInitStoragesAssetHub extends Record<string, Record<string, any>> | undefined,
>(
  collectivesChain: Chain<TCustom, TInitStoragesCollectives>,
  assetHubChain: Chain<TCustom, TInitStoragesAssetHub>,
  testConfig: TestConfig,
): RootTestTree {
  let collectivesClient!: Client<TCustom, TInitStoragesCollectives>
  let assetHubClient!: Client<TCustom, TInitStoragesAssetHub>
  let restoreSnapshot: () => Promise<void>

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[collectivesClient, assetHubClient] = await createNetworks(collectivesChain, assetHubChain)
      restoreSnapshot = captureSnapshot(collectivesClient, assetHubClient)
    },
    beforeEach: async () => {
      await restoreSnapshot()

      /// Reset both chains' heads after snapshot restore so subsequent storage edits apply at the live head.

      for (const client of [collectivesClient, assetHubClient]) {
        const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
        await client.dev.setHead(blockNumber)
      }
    },
    afterAll: async () => {
      for (const client of [collectivesClient, assetHubClient]) {
        await client.api.disconnect().catch(() => {})
        await client.teardown().catch(() => {})
      }
    },
    children: [
      {
        kind: 'describe',
        label: 'salary lifecycle (raw)',
        children: [
          {
            kind: 'test',
            label: 'full salary cycle: induct → register → payout with XCM dispatch',
            testFn: async () => await salaryLifecycleRawTest(collectivesClient, assetHubClient),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'salary status storage',
        children: [
          {
            kind: 'test',
            label: 'cycle status reflects correct state after operations',
            testFn: async () => await salaryStatusStorageTest(collectivesClient, assetHubClient),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'cross-chain payment',
        children: [
          {
            kind: 'test',
            label: 'salary payout delivers USDT to beneficiary on AssetHub',
            testFn: async () =>
              await salaryPayoutDeliversUsdtToAssetHubBeneficiaryTest(collectivesClient, assetHubClient),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'unregistered payout',
        children: [
          {
            kind: 'test',
            label: 'unregistered fellow receives payment from residual pot',
            testFn: async () => await salaryUnregisteredPayoutTest(collectivesClient, assetHubClient),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'proration',
        children: [
          {
            kind: 'test',
            label: 'payouts are prorated when registrations exceed budget',
            testFn: async () => await salaryProrationTest(collectivesClient, assetHubClient),
          },
        ],
      },
    ],
  }
}
