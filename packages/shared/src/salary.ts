import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { assertExpectedEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/** Shorthand — most salary helpers don't constrain the chain's custom config or init storages. */
type AnyClient = Client<Record<string, unknown> | undefined, Record<string, Record<string, any>> | undefined>

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

// The ForeignAssets location for Hollar on Asset Hub.
// Hollar lives on Hydration (parachain 2034) with GeneralIndex 222.
export const HOLLAR_ASSET_LOCATION = {
  parents: 1,
  interior: { X2: [{ Parachain: 2034 }, { GeneralIndex: 222 }] },
} as const

// Decimal base for Hollar balances on Asset Hub (18 decimals).
export const HOLLAR_UNITS = 10n ** 18n

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

// An XCM query id the paymaster will never have recorded. Used to drive `check_payment` into its
// `PaymentStatus::Unknown` branch so the `Inconclusive` error path can be exercised.
const SALARY_UNKNOWN_PAYMENT_ID = 999_999

/// -------
/// Types
/// -------

/** Salary parameters from `fellowshipCore.params()`. */
export interface FellowshipSalaryParams {
  activeSalary: bigint[]
  passiveSalary: bigint[]
  demotionPeriod: number[]
  minPromotionPeriod: number[]
  offboardTimeout: number
}

/** Salary runtime config from storage and pallet constants. */
export interface FellowshipSalaryRuntimeConfig {
  params: FellowshipSalaryParams
  registrationPeriod: number
  payoutPeriod: number
  cyclePeriod: number
  budget: bigint
}

/** Decoded `fellowshipSalary.status` value. */
export interface FellowshipSalaryStatus {
  cycleIndex: number
  cycleStart: number
  budget: bigint
  totalRegistrations: bigint
  totalUnregisteredPaid: bigint
}

/** Decoded `fellowshipSalary.claimant(address)` value. */
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

/** Return whether events contain the matched event. */
function hasEvent(events: any[], matcher: { is: (event: any) => boolean } | undefined): boolean {
  return matcher ? events.some(({ event }) => matcher.is(event)) : false
}

/** Assert the source chain emitted an outbound XCM event. */
function expectSourceChainXcmDispatch(client: AnyClient, events: any[]): void {
  expect(
    hasEvent(events, client.api.events.xcmpQueue?.XcmpMessageSent) ||
      hasEvent(events, client.api.events.polkadotXcm?.Sent),
    'Expected the source chain to emit an XCM dispatch event',
  ).toBe(true)
}

/// -------
/// Storage readers
/// -------

/** Read salary runtime config from live chain state. */
export async function readSalaryRuntimeConfig<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): Promise<FellowshipSalaryRuntimeConfig> {
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

/** Read `fellowshipSalary.status`; return `null` when absent. */
export async function readSalaryStatus<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): Promise<FellowshipSalaryStatus | null> {
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

/** Read and decode `fellowshipSalary.claimant(address)`. */
export async function readSalaryClaimant(
  client: AnyClient,
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

/** Return active salary for the given Fellowship rank. */
export function activeSalaryForRank(params: FellowshipSalaryParams, rank: number): bigint {
  expect(rank).toBeGreaterThan(0)
  expect(rank).toBeLessThanOrEqual(params.activeSalary.length)

  /// `pallet-core-fellowship` stores salaries in rank-1 array slots.

  return params.activeSalary[rank - 1]
}

/** Read Hollar balance from Asset Hub `ForeignAssets`. */
export async function hollarBalance(assetHubClient: AnyClient, address: string): Promise<bigint> {
  const balance = (await assetHubClient.api.query.foreignAssets.account(HOLLAR_ASSET_LOCATION, address)) as any
  return balance.isSome ? (balance.unwrap() as any).balance.toBigInt() : 0n
}

/// -------
/// Storage writers/seeders
/// -------

/** Seed a funded Dan-3 Fellowship member for salary tests. */
export async function seedDan3SalaryMember(
  client: AnyClient,
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
 * Seed `fellowshipSalary.claimant` directly.
 *
 * @param lastActive Cycle index of the claimant's last interaction.
 * @param status Runtime claimant status variant.
 */
export async function seedSalaryClaimant(
  client: AnyClient,
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

/** Seed the salary sovereign Hollar balance on Asset Hub for deterministic payout tests. */
export async function fundSalarySovereignHollar(assetHubClient: AnyClient, amount: bigint): Promise<void> {
  const assetInfo = (await assetHubClient.api.query.foreignAssets.asset(HOLLAR_ASSET_LOCATION)) as any
  const currentAccounts = assetInfo.isSome ? assetInfo.unwrap().accounts.toNumber() : 0
  const currentSupply = assetInfo.isSome ? BigInt(assetInfo.unwrap().supply.toString()) : 0n

  await assetHubClient.dev.setStorage({
    ForeignAssets: {
      asset: [
        [
          [HOLLAR_ASSET_LOCATION],
          {
            ...(assetInfo.isSome ? assetInfo.unwrap().toJSON() : {}),
            accounts: currentAccounts + 1,
            supply: (currentSupply + amount).toString(),
          },
        ],
      ],
      account: [[[HOLLAR_ASSET_LOCATION, SALARY_SOVEREIGN_ADDRESS], { balance: amount.toString() }]],
    },
  })
}

/// -------
/// Time manipulation
/// -------

/** Ensure the salary cycle exists; call `init()` when needed. */
export async function ensureSalaryCycleStarted<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, signer: KeyringPair): Promise<FellowshipSalaryStatus> {
  const status = await readSalaryStatus(client)
  if (status !== null) return status

  await sendTransaction(client.api.tx.fellowshipSalary.init().signAsync(signer))
  await client.dev.newBlock()

  assertExpectedEvents(await client.api.query.system.events(), [
    { type: client.api.events.fellowshipSalary.CycleStarted },
  ])

  return (await readSalaryStatus(client))!
}

/** Rewrite `cycleStart` while preserving other salary status fields. */
async function setSalaryCycleStart(client: AnyClient, cycleStart: number): Promise<FellowshipSalaryStatus> {
  const status = (await readSalaryStatus(client))!

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

  return (await readSalaryStatus(client))!
}

/** Move the current salary cycle into the registration window. */
export async function setSalaryCycleToRegistrationWindow<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>): Promise<FellowshipSalaryStatus> {
  return await setSalaryCycleStart(client, (await client.api.rpc.chain.getHeader()).number.toNumber())
}

/** Move the current salary cycle into the payout window. */
export async function setSalaryCycleToPayoutWindow(
  client: AnyClient,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = (await client.api.rpc.chain.getHeader()).number.toNumber()
  return await setSalaryCycleStart(client, block - runtimeConfig.registrationPeriod - 1)
}

/** Move the current salary cycle past the bump boundary. */
export async function setSalaryCycleToBumpWindow(
  client: AnyClient,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = (await client.api.rpc.chain.getHeader()).number.toNumber()
  return await setSalaryCycleStart(client, block - runtimeConfig.cyclePeriod - 1)
}

/** Advance to the next salary cycle with storage edits plus `bump()`. */
export async function bumpToNextSalaryCycle(
  client: AnyClient,
  signer: KeyringPair,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<any[]> {
  await setSalaryCycleToBumpWindow(client, runtimeConfig)
  await sendTransaction(client.api.tx.fellowshipSalary.bump().signAsync(signer))
  await client.dev.newBlock()
  return await client.api.query.system.events()
}

/// -------
/// Salary lifecycle operations
/// -------

/** Submit `payout()` or `payoutOther()`; return system events. */
export async function payoutSalaryMember(client: AnyClient, signer: KeyringPair, beneficiary?: string): Promise<any[]> {
  const call = beneficiary
    ? client.api.tx.fellowshipSalary.payoutOther(beneficiary)
    : client.api.tx.fellowshipSalary.payout()

  await sendTransaction(call.signAsync(signer))
  await client.dev.newBlock()
  return await client.api.query.system.events()
}

/// -------
/// Test functions
/// -------

/**
 * Full salary lifecycle: `induct` → `register` → `payout`.
 *
 * 1. Seed Dan-3 member on Collectives
 * 2. Fund salary sovereign with Hollar on Asset Hub
 * 3. Bootstrap salary cycle if needed
 * 4. Induct the member
 * 5. Bump to the next cycle
 * 6. Register for salary
 * 7. Move to payout window
 * 8. Call `payout()` — paymaster dispatches XCM
 * 9. Process XCM on Asset Hub; verify Hollar balance increased
 */
export async function salaryLifecycleRawTest(collectivesClient: AnyClient, assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_raw_member')

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
  /// 2. Seed the validated salary sovereign account on Asset Hub with enough Hollar for one payout.
  ///

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  ///
  /// 3. Live Collectives forks already have salary running, but bootstrap `init()` if the forked
  ///    block predates the first cycle.
  ///

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()

    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
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

  const eventsAfterInduct = await collectivesClient.api.query.system.events()
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

  const blockBeforeBump = (await collectivesClient.api.rpc.chain.getHeader()).number.toNumber()
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

  const eventsAfterBump = await collectivesClient.api.query.system.events()
  assertExpectedEvents(eventsAfterBump, [{ type: api.events.fellowshipSalary.CycleStarted }])

  status = (await readSalaryStatus(collectivesClient))!
  expect(status.budget).toBe(runtimeConfig.budget)
  expect(status.totalRegistrations).toBe(0n)
  expect(status.totalUnregisteredPaid).toBe(0n)

  ///
  /// 6. Register for the new cycle. The payout amount comes from live `fellowshipCore.params()`.
  ///

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterRegister = await collectivesClient.api.query.system.events()
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

  status = (await readSalaryStatus(collectivesClient))!
  expect(status.totalRegistrations).toBe(expectedSalary)

  ///
  /// 7. Enter the payout window by rewinding `cycleStart` past `registrationPeriod`.
  ///

  const blockBeforePayout = (await collectivesClient.api.rpc.chain.getHeader()).number.toNumber()
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

  const assetHubBalanceBefore = await hollarBalance(assetHubClient, member.address)

  ///
  /// 8. Pay the salary. The paymaster dispatches XCM toward Asset Hub.
  ///

  await sendTransaction(api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()

  const eventsAfterPayout = await collectivesClient.api.query.system.events()
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
  /// 9. Process the horizontal XCM on Asset Hub and verify the Hollar transfer landed.
  ///

  await assetHubClient.dev.newBlock()
  const assetHubEvents = await assetHubClient.api.query.system.events()

  assertExpectedEvents(assetHubEvents, [
    { type: assetHubClient.api.events.messageQueue.Processed },
    { type: assetHubClient.api.events.foreignAssets.Transferred },
  ])

  const assetHubBalanceAfter = await hollarBalance(assetHubClient, member.address)
  expect(assetHubBalanceAfter - assetHubBalanceBefore).toBe(expectedSalary)
}

/**
 * Verify salary status across a cycle transition.
 *
 * 1. Seed member and sovereign balances
 * 2. Ensure the salary cycle is started
 * 3. Seed inducted claimant state
 * 4. Bump to next cycle; verify status reset
 * 5. Register; verify `totalRegistrations`
 * 6. Payout; verify `totalUnregisteredPaid` remains zero
 */
export async function salaryStatusStorageTest(collectivesClient: AnyClient, assetHubClient: AnyClient) {
  const member = testAccounts.keyring.createFromUri('//salary_status_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// 1. Seed member and sovereign balances.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Ensure the salary cycle is started.

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 3. Seed inducted claimant state (induction doesn't touch status, so seed directly).

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  const statusAfterInduct = (await readSalaryStatus(collectivesClient))!

  /// 4. Bump to next cycle; verify status reset.

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  const statusAfterBump = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterBump.cycleIndex).toBe(statusAfterInduct.cycleIndex + 1)
  expect(statusAfterBump.budget).toBe(runtimeConfig.budget)
  expect(statusAfterBump.totalRegistrations).toBe(0n)
  expect(statusAfterBump.totalUnregisteredPaid).toBe(0n)

  /// 5. Register; verify `totalRegistrations`.

  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  const statusAfterRegister = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterRegister.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterRegister.totalUnregisteredPaid).toBe(0n)

  /// 6. Payout; verify `totalUnregisteredPaid` remains zero.

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)
  await payoutSalaryMember(collectivesClient, member)

  const statusAfterPayout = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterPayout.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterPayout.totalUnregisteredPaid).toBe(0n)
}

/**
 * Verify `payoutOther()` delivers Hollar to an Asset Hub beneficiary.
 *
 * 1. Seed member, beneficiary ED, and sovereign Hollar
 * 2. Ensure the salary cycle is started
 * 3. Seed registered claimant state and move to payout window
 * 4. Call `payoutOther(beneficiary)`; verify Collectives events
 * 5. Process XCM on Asset Hub; verify `foreignAssets` transfer and beneficiary balance increase
 */
export async function salaryPayoutDeliversHollarToAssetHubBeneficiaryTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
) {
  const member = testAccounts.keyring.createFromUri('//salary_cross_chain_member')
  const beneficiary = testAccounts.keyring.createFromUri('//salary_cross_chain_beneficiary')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// 1. Seed member, beneficiary ED, and sovereign Hollar.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Ensure the salary cycle is started.

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 3. Seed registered claimant state and move to payout window.

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, {
    Registered: expectedSalary.toString(),
  })
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// 4. Call `payoutOther(beneficiary)`; verify Collectives events.

  const balanceBefore = await hollarBalance(assetHubClient, beneficiary.address)
  const payoutEvents = await payoutSalaryMember(collectivesClient, member, beneficiary.address)

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

  /// 5. Process XCM on Asset Hub; verify transfer and beneficiary balance.

  await assetHubClient.dev.newBlock()
  assertExpectedEvents(await assetHubClient.api.query.system.events(), [
    { type: assetHubClient.api.events.messageQueue.Processed },
    { type: assetHubClient.api.events.foreignAssets.Transferred },
  ])

  const balanceAfter = await hollarBalance(assetHubClient, beneficiary.address)
  expect(balanceAfter - balanceBefore).toBe(expectedSalary)
}

/**
 * Verify an unregistered fellow is paid from the residual pot.
 *
 * 1. Seed registered and unregistered fellows plus sovereign Hollar
 * 2. Ensure the salary cycle is started; seed inducted claimant state
 * 3. Bump to next cycle
 * 4. Register only one fellow
 * 5. Pay the registered fellow
 * 6. Pay the unregistered fellow; verify `min(ideal_salary, pot)`
 * 7. Verify `totalUnregisteredPaid`
 */
export async function salaryUnregisteredPayoutTest(collectivesClient: AnyClient, assetHubClient: AnyClient) {
  const registeredMember = testAccounts.keyring.createFromUri('//salary_unregistered_test_registered')
  const unregisteredMember = testAccounts.keyring.createFromUri('//salary_unregistered_test_unregistered')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// 1. Seed registered and unregistered fellows plus sovereign Hollar.

  await seedDan3SalaryMember(collectivesClient, registeredMember)
  await seedDan3SalaryMember(collectivesClient, unregisteredMember)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Ensure the salary cycle is started; seed inducted claimant state.

  await ensureSalaryCycleStarted(collectivesClient, registeredMember)
  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, registeredMember.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, unregisteredMember.address, cycleIndex, { Nothing: null })

  /// 3. Bump to next cycle.

  await bumpToNextSalaryCycle(collectivesClient, registeredMember, runtimeConfig)

  /// 4. Register only one fellow.

  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(registeredMember))
  await collectivesClient.dev.newBlock()

  const statusAfterRegister = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterRegister.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterRegister.totalUnregisteredPaid).toBe(0n)

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// 5. Pay the registered fellow.

  const registeredBalanceBefore = await hollarBalance(assetHubClient, registeredMember.address)
  await payoutSalaryMember(collectivesClient, registeredMember)
  await assetHubClient.dev.newBlock()
  const registeredBalanceAfter = await hollarBalance(assetHubClient, registeredMember.address)
  expect(registeredBalanceAfter - registeredBalanceBefore).toBe(expectedSalary)

  /// 6. Pay the unregistered fellow; verify `min(ideal_salary, pot)`.

  const pot = runtimeConfig.budget - expectedSalary
  const expectedUnregisteredPayout = expectedSalary < pot ? expectedSalary : pot

  const unregisteredBalanceBefore = await hollarBalance(assetHubClient, unregisteredMember.address)
  await payoutSalaryMember(collectivesClient, unregisteredMember)
  await assetHubClient.dev.newBlock()
  const unregisteredBalanceAfter = await hollarBalance(assetHubClient, unregisteredMember.address)

  expect(unregisteredBalanceAfter - unregisteredBalanceBefore).toBe(expectedUnregisteredPayout)

  /// 7. Verify `totalUnregisteredPaid`.

  const statusAfterUnregistered = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterUnregistered.totalUnregisteredPaid).toBe(expectedUnregisteredPayout)
}

/**
 * Verify payouts are prorated when registrations exceed budget.
 *
 * 1. Seed two fellows plus sovereign Hollar
 * 2. Ensure the salary cycle is started; seed inducted claimant state
 * 3. Bump to next cycle; override budget below total registrations
 * 4. Register both fellows
 * 5. Move to payout window
 * 6. Pay each fellow; verify prorated amount
 * 7. Verify total paid stays within budget
 */
export async function salaryProrationTest(collectivesClient: AnyClient, assetHubClient: AnyClient) {
  const member1 = testAccounts.keyring.createFromUri('//salary_proration_member_1')
  const member2 = testAccounts.keyring.createFromUri('//salary_proration_member_2')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const salaryPerMember = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// 1. Seed two fellows plus sovereign Hollar.

  const smallBudget = salaryPerMember / 2n

  await seedDan3SalaryMember(collectivesClient, member1)
  await seedDan3SalaryMember(collectivesClient, member2)

  await fundSalarySovereignHollar(assetHubClient, salaryPerMember * 2n)

  /// 2. Ensure the salary cycle is started; seed inducted claimant state.

  await ensureSalaryCycleStarted(collectivesClient, member1)
  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member1.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, member2.address, cycleIndex, { Nothing: null })

  /// 3. Bump to next cycle; override budget below total registrations.

  await bumpToNextSalaryCycle(collectivesClient, member1, runtimeConfig)

  const statusAfterBump = (await readSalaryStatus(collectivesClient))!
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

  /// 4. Register both fellows.

  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member1))
  await collectivesClient.dev.newBlock()
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member2))
  await collectivesClient.dev.newBlock()

  const statusAfterRegister = (await readSalaryStatus(collectivesClient))!
  const totalRegistrations = statusAfterRegister.totalRegistrations
  expect(totalRegistrations).toBe(salaryPerMember * 2n)
  expect(totalRegistrations).toBeGreaterThan(smallBudget)

  /// 5. Move to payout window.

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// 6. Pay each fellow; verify prorated amount: `(salary * budget) / total_registrations`.

  const expectedProrated = (salaryPerMember * smallBudget) / totalRegistrations

  const balance1Before = await hollarBalance(assetHubClient, member1.address)
  await payoutSalaryMember(collectivesClient, member1)
  await assetHubClient.dev.newBlock()
  const balance1After = await hollarBalance(assetHubClient, member1.address)

  const received1 = balance1After - balance1Before
  expect(received1).toBe(expectedProrated)

  /// Pay member2 — same prorated amount.

  const balance2Before = await hollarBalance(assetHubClient, member2.address)
  await payoutSalaryMember(collectivesClient, member2)
  await assetHubClient.dev.newBlock()
  const balance2After = await hollarBalance(assetHubClient, member2.address)

  const received2 = balance2After - balance2Before
  expect(received2).toBe(expectedProrated)

  /// 7. Verify total paid stays within budget.

  expect(received1 + received2).toBeLessThanOrEqual(smallBudget)
  expect(received1 + received2).toBeGreaterThanOrEqual(smallBudget - 2n)
}

/**
 * Payout succeeds without DOT on Asset Hub (Hollar is a sufficient asset).
 *
 * Since Hollar was made a sufficient asset on Asset Hub, a beneficiary with no DOT for
 * existential deposit can still hold it, so the payout XCM lands instead of failing.
 *
 * 1. Seed a Dan-3 member on Collectives, do NOT seed member DOT on AH
 * 2. Bump, register, move to payout window, and call `payout()`
 * 3. Process XCM on Asset Hub
 * 4. Verify member received Hollar despite having no DOT
 * 5. Verify sovereign balance decreased
 */
export async function salaryPayoutSucceedsWithoutDotOnAssetHubTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
) {
  const member = testAccounts.keyring.createFromUri('//salary_no_dot_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// 1. Seed member on Collectives. No DOT on AH.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  const sovBefore = await hollarBalance(assetHubClient, SALARY_SOVEREIGN_ADDRESS)

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. Induct, bump, register, payout.

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  const payoutEvents = await payoutSalaryMember(collectivesClient, member)
  expectSourceChainXcmDispatch(collectivesClient, payoutEvents as any[])

  /// 3. Process XCM on Asset Hub.

  await assetHubClient.dev.newBlock()

  /// 4. Verify member received Hollar despite having no DOT.

  const memberBalance = await hollarBalance(assetHubClient, member.address)
  expect(memberBalance).toBe(expectedSalary)

  /// 5. Verify sovereign balance decreased.

  const sovAfter = await hollarBalance(assetHubClient, SALARY_SOVEREIGN_ADDRESS)
  expect(sovAfter).toBe(sovBefore - expectedSalary)
}

/**
 * Verify payout uses the registered amount, not the member's current rank salary.
 *
 * 1. Seed a Dan-3 member on Collectives
 * 2. Induct, bump, register at rank 3
 * 3. Promote member to rank 4 (storage override)
 * 4. Move to payout window and call `payout()`
 * 5. Verify payout amount matches rank 3 salary, not rank 4
 */
export async function salaryPayoutUsesRegisteredAmountAfterPromotionTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
) {
  const member = testAccounts.keyring.createFromUri('//salary_promotion_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const rank3Salary = activeSalaryForRank(runtimeConfig.params, 3)
  const rank4Salary = activeSalaryForRank(runtimeConfig.params, 4)

  /// 1. Seed a Dan-3 member on Collectives.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. Induct, bump, register at rank 3.

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()

  const claimantAfterReg = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimantAfterReg !== null)
  expect(claimantAfterReg.kind).toBe('registered')
  expect(claimantAfterReg.registeredAmount).toBe(rank3Salary)

  /// 3. Promote member to rank 4 (storage override).

  await collectivesClient.dev.setStorage({
    FellowshipCollective: {
      members: [[[member.address], { rank: 4 }]],
    },
  })

  /// 4. Move to payout window and call `payout()`.

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  const balanceBefore = await hollarBalance(assetHubClient, member.address)
  await payoutSalaryMember(collectivesClient, member)
  await assetHubClient.dev.newBlock()

  /// 5. Verify payout amount matches rank 3 salary, not rank 4.

  const balanceAfter = await hollarBalance(assetHubClient, member.address)
  const received = balanceAfter - balanceBefore
  expect(received).toBe(rank3Salary)
  expect(received).not.toBe(rank4Salary)
}

/// -------
/// Failure-path helpers
/// -------

/**
 * Submit an extrinsic expected to fail and assert it emits `system.ExtrinsicFailed`
 * with the given `fellowshipSalary` error variant.
 *
 * @param errorName A key of `api.errors.fellowshipSalary`, e.g. `AlreadyInducted`.
 */
async function expectSalaryExtrinsicError(
  client: AnyClient,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
  errorName: string,
): Promise<void> {
  await sendTransaction(tx.signAsync(signer))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const failed = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failed, `expected ExtrinsicFailed for ${errorName}, found none`)

  const { dispatchError } = (failed.event as any).data
  assert(dispatchError.isModule, `expected a module error for ${errorName}`)
  const matcher = (client.api.errors.fellowshipSalary as any)[errorName]
  expect(matcher.is(dispatchError.asModule)).toBe(true)
}

/// -------
/// Failure-path test functions
/// -------

/**
 * `induct` rejects a non-member and a double induction.
 *
 * 1. Ensure the salary cycle exists
 * 2. A non-member calling `induct` fails with `NotMember`
 * 3. Seed and induct a Dan-3 member successfully
 * 4. Inducting the same member again fails with `AlreadyInducted`
 */
export async function salaryInductFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_induct_member')
  const stranger = testAccounts.keyring.createFromUri('//salary_induct_stranger')

  /// 1. Ensure the salary cycle exists so `induct` gets past its `NotStarted` guard.

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. A funded non-member cannot induct: `rank_of` returns `None` → `NotMember`.

  await collectivesClient.dev.setStorage({
    System: {
      account: [
        [
          [stranger.address],
          { providers: 1, data: { free: DEFAULT_SALARY_TEST_FREE_BALANCE, frozen: 0, reserved: 0 } },
        ],
      ],
    },
  })
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.induct(), stranger, 'NotMember')

  /// 3. The member inducts successfully, creating the claimant entry.

  await sendTransaction(api.tx.fellowshipSalary.induct().signAsync(member))
  await collectivesClient.dev.newBlock()
  const claimant = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimant !== null)
  expect(claimant.kind).toBe('nothing')

  /// 4. A second induction hits the `Claimant` existence check → `AlreadyInducted`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.induct(), member, 'AlreadyInducted')
}

/**
 * `register` rejects the ineligible cases.
 *
 * 1. Ensure the cycle exists and seed a Dan-3 member
 * 2. Registering before induction fails with `NotInducted`
 * 3. Induct, then register successfully in the current cycle
 * 4. Registering again in the same cycle fails with `NoClaim`
 * 5. In a fresh cycle, registering past the registration window fails with `TooLate`
 */
export async function salaryRegisterFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_register_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)

  /// 1. Seed the member and make sure the salary cycle is running.

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. Registering with no claimant entry fails: `Claimant::get` is `None` → `NotInducted`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.register(), member, 'NotInducted')

  /// 3. Induct, advance to a fresh cycle, then register successfully.

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  expect((await readSalaryClaimant(collectivesClient, member.address))!.kind).toBe('registered')

  /// 4. Re-registering in the same cycle trips `last_active < cycle_index` → `NoClaim`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.register(), member, 'NoClaim')

  /// 5. Bump to a fresh cycle, then move past the registration window so `register` is `TooLate`.
  ///    Rewinding `cycleStart` past `registrationPeriod` puts `now` beyond the registration cutoff.

  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.register(), member, 'TooLate')
}

/**
 * `bump` rejects before the cycle boundary and when no cycle exists.
 *
 * 1. Ensure the cycle exists, then push `cycleStart` into the future so the boundary is unmet
 * 2. Calling `bump` before `cycleStart + cyclePeriod` fails with `NotYet`
 * 3. Remove the salary `status`, then `bump` fails with `NotStarted`
 */
export async function salaryBumpFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_bump_member')

  /// 1. Ensure a running cycle, then force `cycleStart` far into the future so the boundary is not reached.

  await seedDan3SalaryMember(collectivesClient, member)
  const status = await ensureSalaryCycleStarted(collectivesClient, member)

  const futureStart = (await api.rpc.chain.getHeader()).number.toNumber() + 1_000_000
  await collectivesClient.dev.setStorage({
    FellowshipSalary: {
      status: {
        cycleIndex: status.cycleIndex,
        cycleStart: futureStart,
        budget: status.budget.toString(),
        totalRegistrations: status.totalRegistrations.toString(),
        totalUnregisteredPaid: status.totalUnregisteredPaid.toString(),
      },
    },
  })

  /// 2. `now < cycle_start` means the cycle has not elapsed → `NotYet`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.bump(), member, 'NotYet')

  /// 3. Clear the salary `status` entirely; with no cycle, `Status::get` is `None` → `NotStarted`.

  await collectivesClient.dev.setStorage({ FellowshipSalary: { status: null } })
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.bump(), member, 'NotStarted')
}

/**
 * `payout` rejects outside the payout window and without a claim.
 *
 * 1. Seed a Dan-3 member and ensure the cycle exists
 * 2. Paying out before induction fails with `NotInducted`
 * 3. Induct into the current cycle (registration window), then `payout` fails with `TooEarly`
 */
export async function salaryPayoutFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_payout_fail_member')

  /// 1. Seed the member and make sure the salary cycle is running.

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. No claimant entry yet → `NotInducted`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.payout(), member, 'NotInducted')

  /// 3. Induct into the current cycle and stay in the registration window; `payout` requires being
  ///    past `registrationPeriod`, so it fails with `TooEarly`.

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await setSalaryCycleToRegistrationWindow(collectivesClient)

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.payout(), member, 'TooEarly')
}

/**
 * `init` rejects when the salary cycle already exists.
 *
 * 1. Ensure the cycle exists
 * 2. A second `init` hits the `Status::exists` guard → `AlreadyStarted`
 */
export async function salaryInitFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_init_member')

  /// 1. Guarantee a live cycle (bootstrapping via `init` if the fork predates it).

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureSalaryCycleStarted(collectivesClient, member)

  /// 2. `Status` now exists, so calling `init` again fails with `AlreadyStarted`.

  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.init(), member, 'AlreadyStarted')
}

/// -------
/// check_payment test functions
/// -------

/**
 * `check_payment` confirms a successful payout and clears the claimant.
 *
 * 1. Seed member + sovereign, run a full register → payout so the claimant is `Attempted`
 * 2. Process the XCM on Asset Hub (executes the transfer and emits the query-status response)
 * 3. Advance Collectives so it ingests the response XCM, then `check_payment` sees success and
 *    resets the claimant to `Nothing`
 */
export async function salaryCheckPaymentSuccessTest(collectivesClient: AnyClient, assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_checkpay_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)

  /// 1. Drive the claimant into `Attempted` via a real register → payout.

  await seedDan3SalaryMember(collectivesClient, member)
  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)
  await ensureSalaryCycleStarted(collectivesClient, member)

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await bumpToNextSalaryCycle(collectivesClient, member, runtimeConfig)
  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)
  await payoutSalaryMember(collectivesClient, member)

  expect((await readSalaryClaimant(collectivesClient, member.address))!.kind).toBe('attempted')

  /// 2. Land the payment on Asset Hub. This executes the transfer and sends the payment's
  ///    query-status response back toward Collectives.

  await assetHubClient.dev.newBlock()

  /// 3. Advance Collectives so it ingests the response XCM, then `check_payment` observes the
  ///    successful payment and resets the claimant to `Nothing`.

  await collectivesClient.dev.newBlock()
  await collectivesClient.dev.newBlock()

  await sendTransaction(api.tx.fellowshipSalary.checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()

  const claimant = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimant !== null)
  expect(claimant.kind).toBe('nothing')
}

/**
 * `check_payment` rejects the ineligible cases.
 *
 * 1. Seed member + ensure cycle; calling before induction fails with `NotInducted`
 * 2. Induct into the current cycle with a `Nothing` claim; the non-`Attempted` arm → `NoClaim`
 * 3. Seed an `Attempted` claim from a previous cycle; the cycle guard → `NotCurrent`
 * 4. Seed an `Attempted` claim in the current cycle with an unresolvable payment id; the
 *    paymaster reports an unknown status → `Inconclusive`
 */
export async function salaryCheckPaymentFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_checkpay_fail_member')

  /// 1. No claimant entry → `NotInducted`.

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureSalaryCycleStarted(collectivesClient, member)
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.checkPayment(), member, 'NotInducted')

  /// 2. Induct in the current cycle but with nothing attempted; `check_payment` matches the
  ///    non-`Attempted` arm → `NoClaim`.

  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.checkPayment(), member, 'NoClaim')

  /// 3. An `Attempted` claim whose `lastActive` predates the current cycle trips the
  ///    `last_active == cycle_index` guard → `NotCurrent`.

  const staleAttempt = { Attempted: { registered: null, id: SALARY_UNKNOWN_PAYMENT_ID, amount: '1000000000000000000' } }
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex - 1, staleAttempt)
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.checkPayment(), member, 'NotCurrent')

  /// 4. An `Attempted` claim in the current cycle whose payment id the paymaster cannot resolve
  ///    yields `PaymentStatus::Unknown`, hitting the catch-all arm → `Inconclusive`.

  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, staleAttempt)
  await expectSalaryExtrinsicError(collectivesClient, api.tx.fellowshipSalary.checkPayment(), member, 'Inconclusive')
}

/// -------
/// Swapped event test function
/// -------

/**
 * The salary claimant migrates when a Fellowship member swaps accounts.
 *
 * Uses a live inducted fellow as the swap source: real members already have consistent
 * ranked-collective index bookkeeping, which the synthetic seeding used elsewhere does not
 * satisfy for `exchangeMember`'s internal index manipulation.
 *
 * 1. Pick an existing inducted fellow (has a salary claimant) from live storage
 * 2. Root-dispatch `fellowshipCollective.exchangeMember(existing, new)`
 * 3. Assert `fellowshipSalary.Swapped { who, newWho }` fires and the claimant moves old → new
 */
export async function salarySwappedOnMemberExchangeTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const newMember = testAccounts.keyring.createFromUri('//salary_swap_new')

  const addressEncoding = collectivesClient.config.properties.addressEncoding
  const newAddress = encodeAddress(newMember.address, addressEncoding)

  /// 1. Take the first live salary claimant; every inducted fellow has one.

  const claimantEntries = await api.query.fellowshipSalary.claimant.entries()
  assert(claimantEntries.length > 0, 'expected at least one inducted fellow in live storage')
  const oldMemberAddress = (claimantEntries[0][0].args[0] as any).toString()
  const oldAddress = encodeAddress(oldMemberAddress, addressEncoding)

  assert((await readSalaryClaimant(collectivesClient, oldMemberAddress)) !== null)

  /// 2. `exchangeMember` requires the `ExchangeOrigin` (Root or Fellows), so dispatch as Root via
  ///    the scheduler. The ranked-collective swap invokes salary's `RankedMembersSwapHandler`.

  const exchangeCall = api.tx.fellowshipCollective.exchangeMember(oldMemberAddress, newMember.address)
  await scheduleInlineCallWithOrigin(
    collectivesClient,
    exchangeCall.method.toHex(),
    { system: 'Root' },
    collectivesClient.config.properties.schedulerBlockProvider,
  )
  await collectivesClient.dev.newBlock()

  /// 3. Verify the `Swapped` event and that the claimant entry moved from old to new account.

  assertExpectedEvents(await api.query.system.events(), [
    { type: api.events.fellowshipSalary.Swapped, args: { who: oldAddress, newWho: newAddress } },
  ])

  expect(await readSalaryClaimant(collectivesClient, oldMemberAddress)).toBeNull()
  expect(await readSalaryClaimant(collectivesClient, newMember.address)).not.toBeNull()
}

/// -------
/// Test tree builder
/// -------

/** Build the shared end-to-end salary test tree. */
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
        kind: 'test',
        label: 'full salary cycle: induct → register → payout with XCM dispatch',
        testFn: async () => await salaryLifecycleRawTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'cycle status reflects correct state after operations',
        testFn: async () => await salaryStatusStorageTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'salary payout delivers Hollar to beneficiary on AssetHub',
        testFn: async () =>
          await salaryPayoutDeliversHollarToAssetHubBeneficiaryTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'unregistered fellow receives payment from residual pot',
        testFn: async () => await salaryUnregisteredPayoutTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'payouts are prorated when registrations exceed budget',
        testFn: async () => await salaryProrationTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'payout succeeds without DOT on Asset Hub (Hollar is sufficient)',
        testFn: async () => await salaryPayoutSucceedsWithoutDotOnAssetHubTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'payout uses registered amount after mid-cycle promotion',
        testFn: async () => await salaryPayoutUsesRegisteredAmountAfterPromotionTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'induct rejects non-member and double induction',
        testFn: async () => await salaryInductFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'register rejects uninducted member and re-registration',
        testFn: async () => await salaryRegisterFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'bump rejects before the cycle boundary',
        testFn: async () => await salaryBumpFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'payout rejects uninducted member and early payout',
        testFn: async () => await salaryPayoutFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'init rejects when a cycle already exists',
        testFn: async () => await salaryInitFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'check_payment confirms a successful payout',
        testFn: async () => await salaryCheckPaymentSuccessTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'check_payment rejects uninducted member and missing claim',
        testFn: async () => await salaryCheckPaymentFailureTest(collectivesClient, assetHubClient),
      },
      {
        kind: 'test',
        label: 'claimant migrates on Fellowship member account swap',
        testFn: async () => await salarySwappedOnMemberExchangeTest(collectivesClient, assetHubClient),
      },
    ],
  }
}
