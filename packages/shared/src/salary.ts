import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'

import type { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect, type TestContext } from 'vitest'

import { COLLECTIVES_PARA_ID, DEFAULT_SALARY_TEST_FREE_BALANCE, seedFellowshipMembers } from './fellowship.js'
import {
  assertExpectedEvents,
  checkSystemEvents,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/** Shorthand — most salary helpers don't constrain the chain's custom config or init storages. */
type AnyClient = Client<Record<string, unknown> | undefined, Record<string, Record<string, any>> | undefined>

/// ---------
/// Constants
/// ---------

export {
  COLLECTIVES_PARA_ID,
  FELLOWSHIP_COLLECTIVE_PALLET_INDEX,
  FELLOWSHIP_CORE_PALLET_INDEX,
} from './fellowship.js'

// The pallet index for `pallet-salary-fellowship` in the Collectives runtime.
// Together with the Collectives parachain ID, this determines the salary sovereign XCM location.
export const FELLOWSHIP_SALARY_PALLET_INDEX = 64

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

// An XCM query id the paymaster will never have recorded. Used to drive `check_payment` into its
// `PaymentStatus::Unknown` branch so the `Inconclusive` error path can be exercised.
const SALARY_UNKNOWN_PAYMENT_ID = 999_999

/// -----
/// Types
/// -----

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

/// ----------------
/// Internal helpers
/// ----------------

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

/// ---------------
/// Storage readers
/// ---------------

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

/// -----------------------
/// Storage writers/seeders
/// -----------------------

/** Seed a funded Dan-3 Fellowship member for salary tests. */
export async function seedDan3SalaryMember(
  client: AnyClient,
  member: KeyringPair,
  freeBalance: bigint = DEFAULT_SALARY_TEST_FREE_BALANCE,
): Promise<void> {
  await seedFellowshipMembers(client, [{ pair: member, rank: 3 }], freeBalance)
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

/// -----------------
/// Time manipulation
/// -----------------

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

/// --------------
/// Test functions
/// --------------

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
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, 3)
  const liveStatusBefore = await readSalaryStatus(collectivesClient)

  if (liveStatusBefore !== null) {
    expect(liveStatusBefore.budget).toBe(runtimeConfig.budget)
  }

  ///
  /// 1. Seed a fresh Dan-3 Fellowship member directly into the ranked collective/core storage.
  ///

  await seedFellowshipMembers(collectivesClient, [{ pair: member, rank: 3 }])

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
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, 3)

  /// 1. Seed member and sovereign balances.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Bootstrap the salary cycle when the fork predates its first start.

  if ((await readSalaryStatus(collectivesClient)) === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
  }
  const salaryStatus = (await readSalaryStatus(collectivesClient))!

  /// 3. Seed inducted claimant state (induction doesn't touch status, so seed directly).

  const cycleIndex = salaryStatus.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  const statusAfterInduct = (await readSalaryStatus(collectivesClient))!

  /// 4. Bump to next cycle; verify status reset.

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
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
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()

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
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, 3)

  /// 1. Seed member, beneficiary ED, and sovereign Hollar.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Bootstrap the salary cycle when the fork predates its first start.

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  /// 3. Seed registered claimant state and move to payout window.

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  const cycleIndex = (await readSalaryStatus(collectivesClient))!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, {
    Registered: expectedSalary.toString(),
  })
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// 4. Call `payoutOther(beneficiary)`; verify Collectives events.

  const balanceBefore = await hollarBalance(assetHubClient, beneficiary.address)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payoutOther(beneficiary.address).signAsync(member))
  await collectivesClient.dev.newBlock()
  const payoutEvents = await collectivesClient.api.query.system.events()

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
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, 3)

  /// 1. Seed registered and unregistered fellows plus sovereign Hollar.

  await seedDan3SalaryMember(collectivesClient, registeredMember)
  await seedDan3SalaryMember(collectivesClient, unregisteredMember)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  /// 2. Bootstrap the salary cycle when needed, then seed inducted claimant state.

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(registeredMember))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }
  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, registeredMember.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, unregisteredMember.address, cycleIndex, { Nothing: null })

  /// 3. Bump to next cycle.

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(registeredMember))
  await collectivesClient.dev.newBlock()

  /// 4. Register only one fellow.

  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(registeredMember))
  await collectivesClient.dev.newBlock()

  const statusAfterRegister = (await readSalaryStatus(collectivesClient))!
  expect(statusAfterRegister.totalRegistrations).toBe(expectedSalary)
  expect(statusAfterRegister.totalUnregisteredPaid).toBe(0n)

  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  /// 5. Pay the registered fellow.

  const registeredBalanceBefore = await hollarBalance(assetHubClient, registeredMember.address)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(registeredMember))
  await collectivesClient.dev.newBlock()
  await assetHubClient.dev.newBlock()
  const registeredBalanceAfter = await hollarBalance(assetHubClient, registeredMember.address)
  expect(registeredBalanceAfter - registeredBalanceBefore).toBe(expectedSalary)

  /// 6. Pay the unregistered fellow; verify `min(ideal_salary, pot)`.

  const pot = runtimeConfig.budget - expectedSalary
  const expectedUnregisteredPayout = expectedSalary < pot ? expectedSalary : pot

  const unregisteredBalanceBefore = await hollarBalance(assetHubClient, unregisteredMember.address)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(unregisteredMember))
  await collectivesClient.dev.newBlock()
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
  const salaryPerMember = activeSalaryForRank(runtimeConfig.params, 3)

  /// 1. Seed two fellows plus sovereign Hollar.

  const smallBudget = salaryPerMember / 2n

  await seedDan3SalaryMember(collectivesClient, member1)
  await seedDan3SalaryMember(collectivesClient, member2)

  await fundSalarySovereignHollar(assetHubClient, salaryPerMember * 2n)

  /// 2. Bootstrap the salary cycle when needed, then seed inducted claimant state.

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(member1))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }
  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member1.address, cycleIndex, { Nothing: null })
  await seedSalaryClaimant(collectivesClient, member2.address, cycleIndex, { Nothing: null })

  /// 3. Bump to next cycle; override budget below total registrations.

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(member1))
  await collectivesClient.dev.newBlock()

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
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(member1))
  await collectivesClient.dev.newBlock()
  await assetHubClient.dev.newBlock()
  const balance1After = await hollarBalance(assetHubClient, member1.address)

  const received1 = balance1After - balance1Before
  expect(received1).toBe(expectedProrated)

  const balance2Before = await hollarBalance(assetHubClient, member2.address)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(member2))
  await collectivesClient.dev.newBlock()
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
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, 3)

  /// 1. Seed member on Collectives. No DOT on AH.

  await seedDan3SalaryMember(collectivesClient, member)

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

  const sovBefore = await hollarBalance(assetHubClient, SALARY_SOVEREIGN_ADDRESS)

  /// 2. Bootstrap if needed, then advance the member into a payable registered state.

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()
  const payoutEvents = await collectivesClient.api.query.system.events()
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

  /// 2. Bootstrap if needed, then register the member while rank 3 salary is active.

  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(collectivesClient.api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: collectivesClient.api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
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
  await sendTransaction(collectivesClient.api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()
  await assetHubClient.dev.newBlock()

  /// 5. Verify payout amount matches rank 3 salary, not rank 4.

  const balanceAfter = await hollarBalance(assetHubClient, member.address)
  const received = balanceAfter - balanceBefore
  expect(received).toBe(rank3Salary)
  expect(received).not.toBe(rank4Salary)
}

/// --------------------
/// Failure-path helpers
/// --------------------

/**
 * Assert that the given block events contain a `system.ExtrinsicFailed` carrying the named
 * `fellowshipSalary` error variant. This is a pure assertion over already-produced events; the
 * caller is responsible for submitting the extrinsic and building the block, so that the block
 * progression stays visible in the test body.
 *
 * @param errorName A key of `api.errors.fellowshipSalary`, e.g. `AlreadyInducted`.
 */
function assertSalaryError(client: AnyClient, events: any[], errorName: string): void {
  const failed = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failed, `expected ExtrinsicFailed for ${errorName}, found none`)

  const { dispatchError } = (failed.event as any).data
  assert(dispatchError.isModule, `expected a module error for ${errorName}`)
  const matcher = (client.api.errors.fellowshipSalary as any)[errorName]
  expect(matcher.is(dispatchError.asModule), `expected fellowshipSalary.${errorName}`).toBe(true)
}

/// ---------------------------
/// Failure-path test functions
/// ---------------------------

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
  if ((await readSalaryStatus(collectivesClient)) === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
  }

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
  await sendTransaction(api.tx.fellowshipSalary.induct().signAsync(stranger))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotMember')

  /// 3. The member inducts successfully, creating the claimant entry.

  await sendTransaction(api.tx.fellowshipSalary.induct().signAsync(member))
  await collectivesClient.dev.newBlock()
  const claimant = await readSalaryClaimant(collectivesClient, member.address)
  assert(claimant !== null)
  expect(claimant.kind).toBe('nothing')

  /// 4. A second induction hits the `Claimant` existence check → `AlreadyInducted`.

  await sendTransaction(api.tx.fellowshipSalary.induct().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'AlreadyInducted')
}

/**
 * `register` rejects every ineligible caller, covering each guard in `pallet-salary::register`.
 *
 * 1. A member who was never inducted cannot register (`NotInducted`)
 * 2. After inducting and registering once, a second registration in the same cycle is rejected
 *    because the member is already active this cycle (`NoClaim`)
 * 3. In a fresh cycle, registering after the registration window has closed is too late (`TooLate`)
 */
export async function salaryRegisterFailureTest(collectivesClient: AnyClient, _assetHubClient: AnyClient) {
  const api = collectivesClient.api
  const member = testAccounts.keyring.createFromUri('//salary_register_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)

  /// 1. A member without a claimant entry has never entered payroll, so `register` rejects immediately.

  await seedDan3SalaryMember(collectivesClient, member)
  if ((await readSalaryStatus(collectivesClient)) === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
  }
  const salaryStatus = (await readSalaryStatus(collectivesClient))!

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotInducted')

  /// 2. After one successful registration, the same cycle has no fresh claim left to make.

  const cycleIndex = salaryStatus.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  expect(
    (await readSalaryClaimant(collectivesClient, member.address))!.kind,
    'member should be registered for the current cycle',
  ).toBe('registered')

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NoClaim')

  /// 3. In a fresh cycle's payout window, registration is already closed.

  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)

  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'TooLate')
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
  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

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

  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotYet')

  /// 3. Clear the salary `status` entirely; with no cycle, `Status::get` is `None` → `NotStarted`.

  await collectivesClient.dev.setStorage({ FellowshipSalary: { status: null } })
  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotStarted')
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
  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  /// 2. No claimant entry yet → `NotInducted`.

  await sendTransaction(api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotInducted')

  /// 3. Induct into the current cycle and stay in the registration window; `payout` requires being
  ///    past `registrationPeriod`, so it fails with `TooEarly`.

  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await setSalaryCycleToRegistrationWindow(collectivesClient)

  await sendTransaction(api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'TooEarly')
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
  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  /// 2. `Status` now exists, so calling `init` again fails with `AlreadyStarted`.

  await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'AlreadyStarted')
}

/// ----------------------------
/// check_payment test functions
/// ----------------------------

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
  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }

  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await setSalaryCycleToBumpWindow(collectivesClient, runtimeConfig)
  await sendTransaction(api.tx.fellowshipSalary.bump().signAsync(member))
  await collectivesClient.dev.newBlock()
  await sendTransaction(api.tx.fellowshipSalary.register().signAsync(member))
  await collectivesClient.dev.newBlock()
  await setSalaryCycleToPayoutWindow(collectivesClient, runtimeConfig)
  await sendTransaction(api.tx.fellowshipSalary.payout().signAsync(member))
  await collectivesClient.dev.newBlock()

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

  /// 1. No claimant entry means `check_payment` cannot even identify a salary participant.

  await seedDan3SalaryMember(collectivesClient, member)
  let status = await readSalaryStatus(collectivesClient)
  if (status === null) {
    await sendTransaction(api.tx.fellowshipSalary.init().signAsync(member))
    await collectivesClient.dev.newBlock()
    assertExpectedEvents(await collectivesClient.api.query.system.events(), [
      { type: api.events.fellowshipSalary.CycleStarted },
    ])
    status = (await readSalaryStatus(collectivesClient))!
  }
  await sendTransaction(api.tx.fellowshipSalary.checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotInducted')

  /// 2. Induct in the current cycle but with nothing attempted; `check_payment` matches the
  ///    non-`Attempted` arm → `NoClaim`.

  const cycleIndex = status!.cycleIndex
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, { Nothing: null })
  await sendTransaction(api.tx.fellowshipSalary.checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NoClaim')

  /// 3. An `Attempted` claim whose `lastActive` predates the current cycle trips the
  ///    `last_active == cycle_index` guard → `NotCurrent`.

  const staleAttempt = { Attempted: { registered: null, id: SALARY_UNKNOWN_PAYMENT_ID, amount: '1000000000000000000' } }
  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex - 1, staleAttempt)
  await sendTransaction(api.tx.fellowshipSalary.checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'NotCurrent')

  /// 4. An `Attempted` claim in the current cycle whose payment id the paymaster cannot resolve
  ///    yields `PaymentStatus::Unknown`, hitting the catch-all arm → `Inconclusive`.

  await seedSalaryClaimant(collectivesClient, member.address, cycleIndex, staleAttempt)
  await sendTransaction(api.tx.fellowshipSalary.checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  assertSalaryError(collectivesClient, await collectivesClient.api.query.system.events(), 'Inconclusive')
}

/// ---------------------------
/// Swapped event test function
/// ---------------------------

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

/// -----------------
/// Test tree builder
/// -----------------

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

/// =========================================
/// Ambassador and Secretary salary instances
/// =========================================

/*
 * The tests below run against one `pallet-salary` instance, chosen by a `SalaryInstance` descriptor, so one tree
 * covers both `AmbassadorSalary` and `SecretarySalary`. The instances share their code but not their runtime
 * config: which ranked collective counts as membership, where the rank salary comes from, and which Asset Hub
 * account pays it.
 *
 * Time: every salary period is counted in Collectives blocks (`frame_system::block_number`), and each `newBlock`
 * moves that clock by exactly one, so window boundaries can be hit exactly. Tests reach a window by rewriting
 * `status.cycleStart` and then calling the real extrinsic.
 *
 * Payments: the paymaster sends an XCM `TransferAsset` from the paymaster sovereign account on Asset Hub, and
 * records an XCM query. Asset Hub answers the query once it has executed the message, and `check_payment` reads
 * the answer.
 */

/**
 * The runtime default rank 1 Secretary salary, 6,666 USDT, which applies while the salary parameter is unset. It
 * comes from `dynamic_params::secretary_salary::SalaryConfig` in the Collectives Polkadot runtime's `parameters.rs`;
 * unlike the budget, it is not exposed as a metadata constant.
 */
const SECRETARY_DEFAULT_RANK1_SALARY = 6_666_000_000n

/** A `pallet-salary` instance on Collectives, with the runtime config its tests depend on. */
export interface SalaryInstance {
  /** Section of the instance in `api.tx`, `api.query`, `api.events`, `api.errors` and `api.consts`. */
  pallet: 'ambassadorSalary' | 'secretarySalary'
  /** Storage prefix of the instance, as `dev.setStorage` expects it. */
  storage: 'AmbassadorSalary' | 'SecretarySalary'
  /** Section of the ranked collective that the instance's `Config::Members` reads. */
  collective: 'ambassadorCollective' | 'secretaryCollective'
  /**
   * Metadata name of the pallet whose location the paymaster sends from. Its sovereign account on Asset Hub holds
   * and pays the salary.
   */
  paymasterPallet: 'AmbassadorSalary' | 'FellowshipSalary'
  /** Root calls that give rank 1 a non-zero salary, for an instance whose live config pays nothing. */
  configCalls: (api: ApiPromise) => SubmittableExtrinsic<'promise'>[]
  /** Root calls that make `who` a member of the instance's collective at `rank`. */
  memberCalls: (api: ApiPromise, who: string, rank: number) => SubmittableExtrinsic<'promise'>[]
  /** The salary an active rank 1 member registers for, read from live state once `configCalls` have run. */
  rank1Salary: (client: Client<any, any>) => Promise<bigint>
}

/**
 * `AmbassadorSalary` pays `AmbassadorCollective` members the active salary of their `AmbassadorCore` rank, in USDT,
 * from its own sovereign account on Asset Hub. Its budget is a runtime constant.
 *
 * Every `AmbassadorCore` salary is zero on chain, so `configCalls` sets the rank 1 active salary to half the budget.
 * Two registrations then fill the budget exactly, as they do on the Secretary instance.
 */
export const ambassadorSalaryInstance: SalaryInstance = {
  pallet: 'ambassadorSalary',
  storage: 'AmbassadorSalary',
  collective: 'ambassadorCollective',
  paymasterPallet: 'AmbassadorSalary',
  configCalls: (api) => [
    // Only the first slot (rank 1) is given; `set_partial_params` leaves every other value as it is.
    api.tx.ambassadorCore.setPartialParams({
      activeSalary: [BigInt(api.consts.ambassadorSalary.budget.toString()) / 2n],
      passiveSalary: [],
      demotionPeriod: [],
      minPromotionPeriod: [],
      offboardTimeout: null,
    }),
  ],
  memberCalls: (api, who, rank) => [
    // `AmbassadorCore` is the only way into the collective. It adds the account at rank 0, and promotes one rank
    // at a time.
    api.tx.ambassadorCore.induct(who),
    ...Array.from({ length: rank }, (_, i) => api.tx.ambassadorCore.promote(who, i + 1)),
  ],
  rank1Salary: async (client) => {
    const params = (await client.api.query.ambassadorCore.params()) as any
    return params.activeSalary[0].toBigInt()
  },
}

/**
 * `SecretarySalary` pays `SecretaryCollective` members of rank 1 the salary set by a dynamic parameter, and every
 * other rank nothing. It pays in the parameter's asset, USDT by default, from the sovereign account of the
 * Fellowship salary pallet: Asset Hub lets the Fellowship and Ambassador salary locations execute XCM for free,
 * but not the Secretary salary pallet's own location.
 */
export const secretarySalaryInstance: SalaryInstance = {
  pallet: 'secretarySalary',
  storage: 'SecretarySalary',
  collective: 'secretaryCollective',
  paymasterPallet: 'FellowshipSalary',
  configCalls: () => [],
  memberCalls: (api, who, rank) => [
    api.tx.secretaryCollective.addMember(who),
    ...Array.from({ length: rank }, () => api.tx.secretaryCollective.promoteMember(who)),
  ],
  rank1Salary: async (client) => {
    const value = (await client.api.query.parameters.parameters({ SecretarySalary: 'SalaryConfig' })) as any
    if (value.isNone) {
      return SECRETARY_DEFAULT_RANK1_SALARY
    }
    return BigInt(value.unwrap().toJSON().secretarySalary.salaryConfig.salaryRank1.toString())
  },
}

/** Test configuration for one salary instance. */
export interface SalaryInstanceTestConfig extends TestConfig {
  /** The salary instance under test. */
  instance: SalaryInstance
}

/** A decoded claim state; the same shape for every instance. */
type ClaimState =
  | { nothing: null }
  | { registered: bigint }
  | { attempted: { registered: bigint | null; id: bigint; amount: bigint } }

/// ----------------------------
/// Instance readers and writers
/// ----------------------------

/** Read an instance's `status`, or `null` before `init`. */
async function readInstanceStatus(client: AnyClient, instance: SalaryInstance): Promise<FellowshipSalaryStatus | null> {
  const status = (await client.api.query[instance.pallet].status()) as any
  if (status.isNone) {
    return null
  }

  const value = status.unwrap()
  return {
    cycleIndex: value.cycleIndex.toNumber(),
    cycleStart: value.cycleStart.toNumber(),
    budget: value.budget.toBigInt(),
    totalRegistrations: value.totalRegistrations.toBigInt(),
    totalUnregisteredPaid: value.totalUnregisteredPaid.toBigInt(),
  }
}

/** Read an instance's claimant record for `address`, or `null` if the account was never inducted. */
async function readInstanceClaimant(
  client: AnyClient,
  instance: SalaryInstance,
  address: string,
): Promise<{ lastActive: number; status: ClaimState } | null> {
  const claimant = (await client.api.query[instance.pallet].claimant(address)) as any
  if (claimant.isNone) {
    return null
  }

  const { lastActive, status } = claimant.unwrap()
  if (status.isNothing) {
    return { lastActive: lastActive.toNumber(), status: { nothing: null } }
  }
  if (status.isRegistered) {
    return { lastActive: lastActive.toNumber(), status: { registered: status.asRegistered.toBigInt() } }
  }

  const attempted = status.asAttempted
  return {
    lastActive: lastActive.toNumber(),
    status: {
      attempted: {
        registered: attempted.registered.isSome ? attempted.registered.unwrap().toBigInt() : null,
        id: attempted.id.toBigInt(),
        amount: attempted.amount.toBigInt(),
      },
    },
  }
}

/** The instance's budget constant, which every new cycle starts with. */
function instanceBudget(client: AnyClient, instance: SalaryInstance): bigint {
  return BigInt(client.api.consts[instance.pallet].budget.toString())
}

/** The instance's registration window, in Collectives blocks. */
function registrationPeriod(client: AnyClient, instance: SalaryInstance): number {
  return Number(client.api.consts[instance.pallet].registrationPeriod.toString())
}

/** The instance's full cycle (registration window plus payout window), in Collectives blocks. */
function cyclePeriod(client: AnyClient, instance: SalaryInstance): number {
  return registrationPeriod(client, instance) + Number(client.api.consts[instance.pallet].payoutPeriod.toString())
}

/** The current head block number on `client`. */
async function headNumber(client: AnyClient): Promise<number> {
  return (await client.api.rpc.chain.getHeader()).number.toNumber()
}

/** Rewrite the instance's `cycleStart`, keeping every other status field. */
async function setInstanceCycleStart(client: AnyClient, instance: SalaryInstance, cycleStart: number): Promise<void> {
  const status = await readInstanceStatus(client, instance)
  assert(status, `${instance.pallet} has no status to rewrite`)

  await client.dev.setStorage({
    [instance.storage]: {
      status: {
        cycleIndex: status.cycleIndex,
        cycleStart,
        budget: status.budget.toString(),
        totalRegistrations: status.totalRegistrations.toString(),
        totalUnregisteredPaid: status.totalUnregisteredPaid.toString(),
      },
    },
  })
}

/// --------------------------
/// Instance setup and asserts
/// --------------------------

/** Give each account enough DOT on Collectives to pay its transaction fees. */
async function fundOnCollectives(client: AnyClient, pairs: KeyringPair[]): Promise<void> {
  await client.dev.setStorage({
    System: {
      account: pairs.map((pair) => [
        [pair.address],
        { providers: 1, data: { free: DEFAULT_SALARY_TEST_FREE_BALANCE, frozen: 0, reserved: 0 } },
      ]),
    },
  })
}

/**
 * Dispatch `calls` as Root in the next block through the scheduler, then assert that each one dispatched without
 * error. An inline call above 128 bytes would be dropped, which the count check also catches.
 */
async function dispatchAsRoot(client: AnyClient, calls: SubmittableExtrinsic<'promise'>[]): Promise<void> {
  await scheduleInlineCallListWithSameOrigin(
    client,
    calls.map((call) => call.method.toHex()),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const dispatched = events.filter(({ event }) => client.api.events.scheduler.Dispatched.is(event))
  expect(dispatched).toHaveLength(calls.length)
  for (const { event } of dispatched) {
    assert(client.api.events.scheduler.Dispatched.is(event))
    expect(event.data.result.isOk, `Root call failed: ${event.data.result.toString()}`).toBe(true)
  }
}

/**
 * Fund `members` on Collectives and, as Root in one block, apply the instance's `configCalls` and make each account
 * a member of the instance's collective at its rank. Asserts every rank took effect.
 */
async function setupMembers(
  client: AnyClient,
  instance: SalaryInstance,
  members: { pair: KeyringPair; rank: number }[],
): Promise<void> {
  await fundOnCollectives(
    client,
    members.map(({ pair }) => pair),
  )
  await dispatchAsRoot(client, [
    ...instance.configCalls(client.api),
    ...members.flatMap(({ pair, rank }) => instance.memberCalls(client.api, pair.address, rank)),
  ])

  for (const { pair, rank } of members) {
    const record = (await client.api.query[instance.collective].members(pair.address)) as any
    assert(record.isSome, `${pair.address} is not a member of ${instance.collective}`)
    expect(record.unwrap().rank.toNumber()).toBe(rank)
  }
}

/** Return the instance's status, first calling `init` as `signer` if the instance has never been started. */
async function ensureCycleStarted(
  client: AnyClient,
  instance: SalaryInstance,
  signer: KeyringPair,
): Promise<FellowshipSalaryStatus> {
  const status = await readInstanceStatus(client, instance)
  if (status !== null) {
    return status
  }

  await sendTransaction(client.api.tx[instance.pallet].init().signAsync(signer))
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  expect(events.some(({ event }) => client.api.events[instance.pallet].CycleStarted.is(event))).toBe(true)

  return (await readInstanceStatus(client, instance))!
}

/** Induct each of `members` into the instance's payroll in one block, and assert each claimant record exists. */
async function inductMembers(client: AnyClient, instance: SalaryInstance, members: KeyringPair[]): Promise<void> {
  for (const member of members) {
    await sendTransaction(client.api.tx[instance.pallet].induct().signAsync(member))
  }
  await client.dev.newBlock()
  for (const member of members) {
    expect(await readInstanceClaimant(client, instance, member.address)).not.toBeNull()
  }
}

/**
 * Start the next cycle with a real `bump`, after moving `cycleStart` so that the next block is exactly the end of
 * the current cycle. The new cycle starts in the `bump` block, so its registration window is open afterwards.
 */
async function startNextCycle(
  client: AnyClient,
  instance: SalaryInstance,
  signer: KeyringPair,
): Promise<FellowshipSalaryStatus> {
  const before = await readInstanceStatus(client, instance)
  assert(before, `${instance.pallet} has not been started`)

  await setInstanceCycleStart(client, instance, (await headNumber(client)) + 1 - cyclePeriod(client, instance))
  await sendTransaction(client.api.tx[instance.pallet].bump().signAsync(signer))
  await client.dev.newBlock()

  const after = (await readInstanceStatus(client, instance))!
  expect(after.cycleIndex).toBe(before.cycleIndex + 1)
  return after
}

/**
 * Assert that the head block holds an `ExtrinsicFailed` carrying the instance's `errorName`. Fails if the runtime
 * has no such error, so a renamed error cannot pass by matching nothing.
 */
async function expectSalaryError(client: AnyClient, instance: SalaryInstance, errorName: string): Promise<void> {
  const events = await client.api.query.system.events()
  const failure = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failure, `expected an ExtrinsicFailed carrying ${errorName}`)
  assert(client.api.events.system.ExtrinsicFailed.is(failure.event))

  const { dispatchError } = failure.event.data
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)
  const errors = client.api.errors[instance.pallet]
  assert(errors[errorName], `runtime has no ${instance.pallet} error named ${errorName}`)
  expect(errors[errorName].is(dispatchError.asModule), `expected ${instance.pallet}.${errorName}`).toBe(true)
}

/**
 * Assert that the head block holds a `utility.forceBatch` whose `count` items each failed with `errorName`: an
 * instance error, or `BadOrigin`.
 */
async function expectBatchItemsFailed(
  client: AnyClient,
  instance: SalaryInstance,
  count: number,
  errorName: string,
): Promise<void> {
  const events = await client.api.query.system.events()
  expect(events.some(({ event }) => client.api.events.utility.BatchCompletedWithErrors.is(event))).toBe(true)

  const failures = events.filter(({ event }) => client.api.events.utility.ItemFailed.is(event))
  expect(failures).toHaveLength(count)
  for (const { event } of failures) {
    assert(client.api.events.utility.ItemFailed.is(event))
    const { error } = event.data
    if (errorName === 'BadOrigin') {
      expect(error.isBadOrigin, `expected BadOrigin, got ${error.toString()}`).toBe(true)
      continue
    }
    assert(error.isModule, `expected a module error, got ${error.type}`)
    const errors = client.api.errors[instance.pallet]
    assert(errors[errorName], `runtime has no ${instance.pallet} error named ${errorName}`)
    expect(errors[errorName].is(error.asModule), `expected ${instance.pallet}.${errorName}`).toBe(true)
  }
}

/** The fee `signer` paid for its extrinsic in the head block, from `transactionPayment.TransactionFeePaid`. */
async function feePaidBy(client: AnyClient, signer: KeyringPair): Promise<bigint> {
  const who = encodeAddress(signer.address, client.config.properties.addressEncoding)
  const events = await client.api.query.system.events()
  const paid = events.find(
    ({ event }) =>
      client.api.events.transactionPayment.TransactionFeePaid.is(event) && event.data.who.toString() === who,
  )
  assert(paid, `no TransactionFeePaid for ${who}`)
  assert(client.api.events.transactionPayment.TransactionFeePaid.is(paid.event))
  return paid.event.data.actualFee.toBigInt()
}

/// ------------------------------
/// Instance helpers - Asset Hub
/// ------------------------------

/** USDT on Asset Hub, `Assets` id 1984: the salary asset of both instances (`AssetHubUsdt` in the Collectives runtime). */
const USDT_ASSET_ID = 1984

/**
 * The paymaster sovereign account on Asset Hub: the account of `(1, [Parachain(collectives), PalletInstance(i)])`,
 * where `i` is the index of the instance's paymaster pallet. Asset Hub's own location-to-account conversion derives
 * it, so the address is never a literal.
 */
async function paymasterSovereign(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
): Promise<string> {
  const pallet = collectivesClient.api.registry.metadata.pallets.find(
    ({ name }) => name.toString() === instance.paymasterPallet,
  )
  assert(pallet, `no ${instance.paymasterPallet} pallet in the Collectives metadata`)

  const location = {
    V5: {
      parents: 1,
      interior: { X2: [{ Parachain: collectivesClient.config.paraId }, { PalletInstance: pallet.index.toNumber() }] },
    },
  }
  const result = (await (assetHubClient.api.call as any).locationToAccountApi.convertLocation(location)) as any
  assert(result.isOk, `Asset Hub cannot convert the ${instance.paymasterPallet} location: ${result.toString()}`)
  return result.asOk.toString()
}

/** USDT balance of `who` on Asset Hub; zero when the account holds none. */
async function usdtBalance(assetHubClient: AnyClient, who: string): Promise<bigint> {
  const account = (await assetHubClient.api.query.assets.account(USDT_ASSET_ID, who)) as any
  return account.isSome ? account.unwrap().balance.toBigInt() : 0n
}

/**
 * Set the USDT balance of `who` on Asset Hub, keeping the asset's supply and account counters consistent. A new
 * holder gets a `Sufficient` account, which also counts as a sufficient reference on its `System.account`.
 */
async function setUsdtBalance(assetHubClient: AnyClient, who: string, amount: bigint): Promise<void> {
  const api = assetHubClient.api
  const asset = (await api.query.assets.asset(USDT_ASSET_ID)) as any
  assert(asset.isSome, 'USDT is not registered on Asset Hub')
  const details = asset.unwrap()
  const account = (await api.query.assets.account(USDT_ASSET_ID, who)) as any
  const isNewHolder = account.isNone
  const previous: bigint = isNewHolder ? 0n : account.unwrap().balance.toBigInt()

  const systemAccount = (await api.query.system.account(who)) as any
  await assetHubClient.dev.setStorage({
    Assets: {
      asset: [
        [
          [USDT_ASSET_ID],
          {
            ...details.toJSON(),
            supply: ((details.supply.toBigInt() as bigint) - previous + amount).toString(),
            accounts: details.accounts.toNumber() + (isNewHolder ? 1 : 0),
            sufficients: details.sufficients.toNumber() + (isNewHolder ? 1 : 0),
          },
        ],
      ],
      account: [
        [
          [USDT_ASSET_ID, who],
          isNewHolder
            ? { balance: amount.toString(), status: 'Liquid', reason: 'Sufficient', extra: null }
            : { ...account.unwrap().toJSON(), balance: amount.toString() },
        ],
      ],
    },
    System: {
      account: [
        [
          [who],
          { ...systemAccount.toJSON(), sufficients: systemAccount.sufficients.toNumber() + (isNewHolder ? 1 : 0) },
        ],
      ],
    },
  })
  expect(await usdtBalance(assetHubClient, who)).toBe(amount)
}

/** Move `cycleStart` so that the next block is the first block of the payout window. */
async function openPayoutWindow(client: AnyClient, instance: SalaryInstance): Promise<void> {
  await setInstanceCycleStart(client, instance, (await headNumber(client)) + 1 - registrationPeriod(client, instance))
}

/**
 * Build one block on Asset Hub, which executes the salary XCM sent from Collectives, and assert the message was
 * processed successfully.
 */
async function processPaymentOnAssetHub(assetHubClient: AnyClient): Promise<void> {
  await assetHubClient.dev.newBlock()
  const events = await assetHubClient.api.query.system.events()
  const processed = events.filter(({ event }) => assetHubClient.api.events.messageQueue.Processed.is(event))
  expect(processed.length).toBeGreaterThan(0)
  for (const { event } of processed) {
    assert(assetHubClient.api.events.messageQueue.Processed.is(event))
    expect(event.data.success.isTrue, 'Asset Hub failed to process a salary message').toBe(true)
  }
}

/** The `Paid` events in the head block, keyed by the paid member's address. */
async function paidEvents(client: AnyClient, instance: SalaryInstance): Promise<Map<string, any>> {
  const events = await client.api.query.system.events()
  const paid = new Map<string, any>()
  for (const { event } of events) {
    if (client.api.events[instance.pallet].Paid.is(event)) {
      const data = event.data as any
      paid.set(data.who.toString(), data)
    }
  }
  return paid
}

/// ------------------------
/// Instance tests - Cycle
/// ------------------------

/**
 * `init` opens cycle 0 at the current block with the instance's full budget, and costs nothing.
 *
 * Runs only on an instance that has never been started. Once a cycle exists, the unstarted state cannot be
 * restored honestly, because live claimants would point at cycles that no longer exist.
 *
 * 1. Skip unless the instance has no `status`
 * 2. A funded account calls `init`
 * 3. Verify `CycleStarted { index: 0 }` and that the call was free
 * 4. Verify the status: cycle 0 starting at the `init` block, the constant budget, and no totals
 */
export async function salaryInitOpensCycleZeroTest(client: AnyClient, instance: SalaryInstance, ctx: TestContext) {
  const caller = testAccounts.keyring.createFromUri(`//${instance.pallet}_init_caller`)

  // 1. Unstarted instances only
  if ((await readInstanceStatus(client, instance)) !== null) {
    ctx.skip(`${instance.pallet} is already started at this block, so init cannot open cycle 0`)
  }

  // 2. Open the first cycle
  await fundOnCollectives(client, [caller])
  await sendTransaction(client.api.tx[instance.pallet].init().signAsync(caller))
  await client.dev.newBlock()
  const initBlock = await headNumber(client)

  // 3. CycleStarted for cycle 0, free
  await checkSystemEvents(client, { section: instance.pallet, method: 'CycleStarted' }).toMatchSnapshot(
    'init: CycleStarted',
  )
  const events = await client.api.query.system.events()
  const started = events.find(({ event }) => client.api.events[instance.pallet].CycleStarted.is(event))
  assert(started)
  expect((started.event.data as any).index.toNumber()).toBe(0)
  expect(await feePaidBy(client, caller)).toBe(0n)

  // 4. Status of the new cycle
  expect(await readInstanceStatus(client, instance)).toEqual({
    cycleIndex: 0,
    cycleStart: initBlock,
    budget: instanceBudget(client, instance),
    totalRegistrations: 0n,
    totalUnregisteredPaid: 0n,
  })
}

/**
 * `init` refuses once the instance has a cycle, so the cycle count cannot be restarted. The failed call pays its
 * fee, since only successful salary calls are free.
 *
 * 1. Start the instance if it has no cycle yet, and record its status
 * 2. Call `init`
 * 3. Verify `AlreadyStarted`, a non-zero fee, and an unchanged status
 */
export async function salaryInitAlreadyStartedTest(client: AnyClient, instance: SalaryInstance) {
  const caller = testAccounts.keyring.createFromUri(`//${instance.pallet}_reinit_caller`)

  // 1. A cycle exists
  await fundOnCollectives(client, [caller])
  const before = await ensureCycleStarted(client, instance, caller)

  // 2. Second init
  await sendTransaction(client.api.tx[instance.pallet].init().signAsync(caller))
  await client.dev.newBlock()

  // 3. AlreadyStarted, fee charged, status untouched
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'second init: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'AlreadyStarted')
  expect(await feePaidBy(client, caller)).toBeGreaterThan(0n)
  expect(await readInstanceStatus(client, instance)).toEqual(before)
}

/**
 * `bump` refuses one block before the cycle ends and starts the next cycle exactly at its end. The new cycle starts
 * one full cycle period after the old one, with the constant budget and both totals back at zero.
 *
 * 1. Start the instance if needed, then register a rank 1 member so the cycle has a non-zero total
 * 2. Move `cycleStart` so that the next block is the last block of the cycle
 * 3. `bump` fails with `NotYet` and leaves the status unchanged
 * 4. `bump` in the following block, the first block of the next cycle, emits `CycleStarted` and is free
 * 5. Verify the new status: start moved by one period, constant budget, both totals zero
 */
export async function salaryBumpAtCycleBoundaryTest(client: AnyClient, instance: SalaryInstance) {
  const salary = client.api.tx[instance.pallet]
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_bump_member`)

  // 1. A registration makes `totalRegistrations` non-zero, so the reset in step 5 shows
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  await startNextCycle(client, instance, member)
  await sendTransaction(salary.register().signAsync(member))
  await client.dev.newBlock()
  expect((await readInstanceStatus(client, instance))!.totalRegistrations).toBe(await instance.rank1Salary(client))

  // 2. The next extrinsic runs in block `head + 1`, so the cycle ends at `head + 2`
  const period = cyclePeriod(client, instance)
  await setInstanceCycleStart(client, instance, (await headNumber(client)) + 2 - period)
  const before = (await readInstanceStatus(client, instance))!

  // 3. One block early
  await sendTransaction(salary.bump().signAsync(member))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'bump one block early: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NotYet')
  expect(await readInstanceStatus(client, instance)).toEqual(before)

  // 4. At the boundary. The cycle index depends on the live cycle, so it is redacted and asserted below.
  await sendTransaction(salary.bump().signAsync(member))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: instance.pallet, method: 'CycleStarted' })
    .redact({ redactKeys: /^index$/ })
    .toMatchSnapshot('bump at the boundary: CycleStarted')
  const events = await client.api.query.system.events()
  const started = events.find(({ event }) => client.api.events[instance.pallet].CycleStarted.is(event))
  assert(started)
  expect((started.event.data as any).index.toNumber()).toBe(before.cycleIndex + 1)
  expect(await feePaidBy(client, member)).toBe(0n)

  // 5. New cycle status
  expect(await readInstanceStatus(client, instance)).toEqual({
    cycleIndex: before.cycleIndex + 1,
    cycleStart: before.cycleStart + period,
    budget: instanceBudget(client, instance),
    totalRegistrations: 0n,
    totalUnregisteredPaid: 0n,
  })
}

/**
 * Before `init`, every other salary call fails with `NotStarted`.
 *
 * An instance that is already started has no call that removes its status, so for one the test deletes `status` to
 * reach the guard. This is the one state edit the guard needs; the member is set up with real calls.
 *
 * 1. Make the signer a rank 1 member, so `register` gets past its membership check, which runs first
 * 2. Remove `status` if the instance has one, and verify it is gone
 * 3. The member sends one `utility.forceBatch` of `bump`, `induct`, `register`, `payout`, `payout_other` and
 *    `check_payment`
 * 4. Verify all six items failed with `NotStarted`, and that the instance is still unstarted with no claimant
 */
export async function salaryCallsBeforeInitTest(client: AnyClient, instance: SalaryInstance) {
  const salary = client.api.tx[instance.pallet]
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_unstarted_member`)

  // 1. Member at rank 1
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])

  // 2. No status
  if ((await readInstanceStatus(client, instance)) !== null) {
    await client.dev.setStorage({ [instance.storage]: { status: null } })
  }
  expect(await readInstanceStatus(client, instance)).toBeNull()

  // 3. Every call but `init`
  const calls = [
    salary.bump(),
    salary.induct(),
    salary.register(),
    salary.payout(),
    salary.payoutOther(member.address),
    salary.checkPayment(),
  ]
  await sendTransaction(client.api.tx.utility.forceBatch(calls).signAsync(member))
  await client.dev.newBlock()

  // 4. NotStarted for each, nothing created
  await checkSystemEvents(client, 'utility').toMatchSnapshot('calls before init: utility events')
  await expectBatchItemsFailed(client, instance, calls.length, 'NotStarted')
  expect(await readInstanceStatus(client, instance)).toBeNull()
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()
}

/// -------------------------
/// Instance tests - Induction
/// -------------------------

/**
 * `induct` adds a member to the payroll with an empty claim dated to the current cycle, and costs nothing.
 *
 * 1. Make a funded account a rank 1 member, and start the instance if it has no cycle yet
 * 2. The member calls `induct`
 * 3. Verify `Inducted { who }` and that the call was free
 * 4. Verify the claimant: `lastActive` is the current cycle, and nothing is claimed
 */
export async function salaryInductTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_induct_member`)

  // 1. Member and running cycle
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  const status = await ensureCycleStarted(client, instance, member)
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()

  // 2. Induct
  await sendTransaction(client.api.tx[instance.pallet].induct().signAsync(member))
  await client.dev.newBlock()

  // 3. Inducted, free
  await checkSystemEvents(client, { section: instance.pallet, method: 'Inducted' }).toMatchSnapshot('induct: Inducted')
  const events = await client.api.query.system.events()
  const inducted = events.find(({ event }) => client.api.events[instance.pallet].Inducted.is(event))
  assert(inducted)
  expect((inducted.event.data as any).who.toString()).toBe(
    encodeAddress(member.address, client.config.properties.addressEncoding),
  )
  expect(await feePaidBy(client, member)).toBe(0n)

  // 4. Empty claim in the current cycle
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual({
    lastActive: status.cycleIndex,
    status: { nothing: null },
  })
}

/**
 * A second `induct` fails with `AlreadyInducted` and leaves the claim as it was, so induction cannot reset a claim.
 * The failed call pays its fee.
 *
 * 1. Make a rank 1 member, start the instance if needed, and induct the member
 * 2. The member calls `induct` again
 * 3. Verify `AlreadyInducted`, a non-zero fee, and an unchanged claimant
 */
export async function salaryInductTwiceTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_reinduct_member`)

  // 1. Inducted member
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  const before = await readInstanceClaimant(client, instance, member.address)

  // 2. Second induct
  await sendTransaction(client.api.tx[instance.pallet].induct().signAsync(member))
  await client.dev.newBlock()

  // 3. AlreadyInducted, fee charged, claim untouched
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'second induct: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'AlreadyInducted')
  expect(await feePaidBy(client, member)).toBeGreaterThan(0n)
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(before)
}

/**
 * A Fellowship member is not a member of this instance's collective, so it can neither induct nor register. This
 * shows that the instance's `Config::Members` is its own collective, not the Fellowship.
 *
 * 1. Seed a rank 3 Fellow, and start the instance if needed
 * 2. Verify the precondition: ranked in the Fellowship collective, absent from the instance's collective
 * 3. `induct` fails with `NotMember`
 * 4. `register` fails with `NotMember`
 * 5. Verify that no claimant was created
 */
export async function salaryFellowIsNotMemberTest(client: AnyClient, instance: SalaryInstance) {
  const salary = client.api.tx[instance.pallet]
  const fellow = testAccounts.keyring.createFromUri(`//${instance.pallet}_fellow`)

  // 1. Fellow with funds; the seeding also writes its `System.account`
  await seedFellowshipMembers(client, [{ pair: fellow, rank: 3 }])
  await ensureCycleStarted(client, instance, fellow)

  // 2. Member of the Fellowship only
  const fellowRecord = (await client.api.query.fellowshipCollective.members(fellow.address)) as any
  assert(fellowRecord.isSome)
  expect(fellowRecord.unwrap().rank.toNumber()).toBe(3)
  expect(((await client.api.query[instance.collective].members(fellow.address)) as any).isNone).toBe(true)

  // 3. Induct
  await sendTransaction(salary.induct().signAsync(fellow))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'fellow induct: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NotMember')

  // 4. Register
  await sendTransaction(salary.register().signAsync(fellow))
  await client.dev.newBlock()
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'fellow register: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NotMember')

  // 5. No claim
  expect(await readInstanceClaimant(client, instance, fellow.address)).toBeNull()
}

/// ----------------------------
/// Instance tests - Registration
/// ----------------------------

/**
 * `register` reserves the rank 1 salary for the current cycle, for free, and adds it to the cycle's total.
 *
 * 1. Make a rank 1 member, start the instance if needed, and induct the member
 * 2. Start the next cycle: a member can only claim from the cycle after the one it was inducted in
 * 3. The member calls `register`
 * 4. Verify `Registered { who, amount }` with the instance's rank 1 salary, and that the call was free
 * 5. Verify the claimant holds `Registered(amount)` for the new cycle, and `totalRegistrations` grew by the amount
 */
export async function salaryRegisterTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_register_member`)

  // 1. Inducted member
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])

  // 2. Next cycle
  const cycle = await startNextCycle(client, instance, member)
  const salary = await instance.rank1Salary(client)
  expect(salary).toBeGreaterThan(0n)

  // 3. Register
  await sendTransaction(client.api.tx[instance.pallet].register().signAsync(member))
  await client.dev.newBlock()

  // 4. Registered with the rank 1 salary, free
  await checkSystemEvents(client, { section: instance.pallet, method: 'Registered' }).toMatchSnapshot(
    'register: Registered',
  )
  const events = await client.api.query.system.events()
  const registered = events.find(({ event }) => client.api.events[instance.pallet].Registered.is(event))
  assert(registered)
  const data = registered.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(member.address, client.config.properties.addressEncoding))
  expect(data.amount.toBigInt()).toBe(salary)
  expect(await feePaidBy(client, member)).toBe(0n)

  // 5. Claim and cycle total
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { registered: salary },
  })
  expect((await readInstanceStatus(client, instance))!.totalRegistrations).toBe(cycle.totalRegistrations + salary)
}

/**
 * A member cannot register in the cycle it was inducted in: induction marks that cycle as already claimed, so
 * `register` fails with `NoClaim` even inside the registration window.
 *
 * 1. Make a rank 1 member, start the instance if needed, and induct the member
 * 2. Move `cycleStart` to the head block, so the registration window is open and the `TooLate` guard passes
 * 3. The member calls `register`
 * 4. Verify `NoClaim`, and that the claim and the cycle total did not change
 */
export async function salaryRegisterInInductionCycleTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_early_register_member`)

  // 1. Inducted member
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])

  // 2. Registration window open
  await setInstanceCycleStart(client, instance, await headNumber(client))
  const statusBefore = await readInstanceStatus(client, instance)
  const claimantBefore = await readInstanceClaimant(client, instance, member.address)

  // 3. Register
  await sendTransaction(client.api.tx[instance.pallet].register().signAsync(member))
  await client.dev.newBlock()

  // 4. NoClaim, nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'register in the induction cycle: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NoClaim')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(claimantBefore)
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
}

/**
 * `register` fails with `TooLate` in the first block after the registration window, so a member who misses the
 * window cannot reserve a salary for that cycle.
 *
 * 1. Make a rank 1 member, start the instance if needed, induct the member, and start the next cycle
 * 2. Move `cycleStart` so that the next block is the first one after the registration window
 * 3. The member calls `register`
 * 4. Verify `TooLate`, and that the claim and the cycle total did not change
 */
export async function salaryRegisterTooLateTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_late_register_member`)

  // 1. Member eligible for the current cycle
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  await startNextCycle(client, instance, member)

  // 2. The window closes at `cycleStart + registrationPeriod`, which is the next block
  await setInstanceCycleStart(client, instance, (await headNumber(client)) + 1 - registrationPeriod(client, instance))
  const statusBefore = await readInstanceStatus(client, instance)
  const claimantBefore = await readInstanceClaimant(client, instance, member.address)

  // 3. Register
  await sendTransaction(client.api.tx[instance.pallet].register().signAsync(member))
  await client.dev.newBlock()

  // 4. TooLate, nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'register after the window: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'TooLate')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(claimantBefore)
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
}

/**
 * A rank 0 candidate can induct but has no salary, so `register` fails with `ClaimZero`. Both instances pay nothing
 * at rank 0: `AmbassadorCore` has no salary slot for rank 0, and the Secretary salary applies to rank 1 only.
 *
 * 1. Make a rank 0 member, start the instance if needed, induct the member, and start the next cycle
 * 2. The candidate calls `register`
 * 3. Verify `ClaimZero`, and that the claim and the cycle total did not change
 */
export async function salaryRegisterCandidateTest(client: AnyClient, instance: SalaryInstance) {
  const candidate = testAccounts.keyring.createFromUri(`//${instance.pallet}_candidate`)

  // 1. Inducted candidate in a fresh cycle
  await setupMembers(client, instance, [{ pair: candidate, rank: 0 }])
  await ensureCycleStarted(client, instance, candidate)
  await inductMembers(client, instance, [candidate])
  await startNextCycle(client, instance, candidate)
  const statusBefore = await readInstanceStatus(client, instance)
  const claimantBefore = await readInstanceClaimant(client, instance, candidate.address)

  // 2. Register
  await sendTransaction(client.api.tx[instance.pallet].register().signAsync(candidate))
  await client.dev.newBlock()

  // 3. ClaimZero, nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'candidate register: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'ClaimZero')
  expect(await readInstanceClaimant(client, instance, candidate.address)).toEqual(claimantBefore)
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
}

/**
 * A member who never inducted has no claim record, so `register`, `payout`, `payout_other` and `check_payment` all
 * fail with `NotInducted`.
 *
 * 1. Make a rank 1 member and start the instance if needed, without inducting the member
 * 2. The member sends one `utility.forceBatch` of `register`, `payout`, `payout_other` and `check_payment`
 * 3. Verify all four items failed with `NotInducted`, and that no claimant was created
 */
export async function salaryNotInductedTest(client: AnyClient, instance: SalaryInstance) {
  const salary = client.api.tx[instance.pallet]
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_uninducted_member`)

  // 1. Member with a running cycle, never inducted
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()

  // 2. Claim-dependent calls
  const calls = [salary.register(), salary.payout(), salary.payoutOther(member.address), salary.checkPayment()]
  await sendTransaction(client.api.tx.utility.forceBatch(calls).signAsync(member))
  await client.dev.newBlock()

  // 3. NotInducted for each, nothing created
  await checkSystemEvents(client, 'utility').toMatchSnapshot('calls without induction: utility events')
  await expectBatchItemsFailed(client, instance, calls.length, 'NotInducted')
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()
}

/// -------------------------
/// Instance tests - Payout
/// -------------------------

/**
 * Make `member` a rank 1 member, start the instance if needed, induct the member, start the next cycle and register.
 * Returns the cycle the member is registered in and its registered salary.
 */
async function registerForNextCycle(
  client: AnyClient,
  instance: SalaryInstance,
  member: KeyringPair,
): Promise<{ cycle: FellowshipSalaryStatus; salary: bigint }> {
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  const cycle = await startNextCycle(client, instance, member)
  await sendTransaction(client.api.tx[instance.pallet].register().signAsync(member))
  await client.dev.newBlock()

  const salary = await instance.rank1Salary(client)
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { registered: salary },
  })
  return { cycle, salary }
}

/**
 * A registered member's `payout` sends the salary over XCM, and Asset Hub moves exactly that much USDT from the
 * paymaster sovereign account to the member. The claim records the attempt, and the call is free.
 *
 * 1. Register a rank 1 member for a fresh cycle
 * 2. Fund the paymaster sovereign on Asset Hub with one budget, and record the member's USDT balance
 * 3. Open the payout window, and the member calls `payout`
 * 4. Verify `Paid` pays the registered salary to the member, the XCMP message went out, and the call was free
 * 5. Verify the claim is `Attempted` with the registered amount under the payment id, and that nothing counts as an
 *    unregistered payout
 * 6. Build a block on Asset Hub, and verify `assets.Transferred` moved the salary from the sovereign to the member
 * 7. Verify the member gained, and the sovereign lost, exactly the salary
 */
export async function salaryPayoutTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_payout_member`)
  const memberAddress = encodeAddress(member.address, collectivesClient.config.properties.addressEncoding)

  // 1. Registered member
  const { cycle, salary } = await registerForNextCycle(collectivesClient, instance, member)

  // 2. Funded paymaster
  const budget = instanceBudget(collectivesClient, instance)
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  await setUsdtBalance(assetHubClient, sovereign, budget)
  const memberBefore = await usdtBalance(assetHubClient, member.address)

  // 3. Payout
  await openPayoutWindow(collectivesClient, instance)
  await sendTransaction(collectivesClient.api.tx[instance.pallet].payout().signAsync(member))
  await collectivesClient.dev.newBlock()

  // 4. The payment id is an XCM query id from a live counter, so it is redacted here and compared with the claim
  await checkSystemEvents(collectivesClient, { section: instance.pallet, method: 'Paid' })
    .redact({ redactKeys: /^id$/ })
    .toMatchSnapshot('payout: Paid')
  const paid = (await paidEvents(collectivesClient, instance)).get(memberAddress)
  assert(paid, 'no Paid event for the member')
  expect(paid.beneficiary.toString()).toBe(memberAddress)
  expect(paid.amount.toBigInt()).toBe(salary)
  const events = await collectivesClient.api.query.system.events()
  expect(events.some(({ event }) => collectivesClient.api.events.xcmpQueue.XcmpMessageSent.is(event))).toBe(true)
  expect(await feePaidBy(collectivesClient, member)).toBe(0n)

  // 5. Attempted claim
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { attempted: { registered: salary, id: paid.id.toBigInt(), amount: salary } },
  })
  expect((await readInstanceStatus(collectivesClient, instance))!.totalUnregisteredPaid).toBe(0n)

  // 6. Transfer on Asset Hub
  await processPaymentOnAssetHub(assetHubClient)
  await checkSystemEvents(assetHubClient, { section: 'assets', method: 'Transferred' }).toMatchSnapshot(
    'payout: Asset Hub Transferred',
  )
  const assetHubEvents = await assetHubClient.api.query.system.events()
  const transferred = assetHubEvents.find(({ event }) => assetHubClient.api.events.assets.Transferred.is(event))
  assert(transferred)
  assert(assetHubClient.api.events.assets.Transferred.is(transferred.event))
  const { assetId, from, to, amount } = transferred.event.data
  expect(assetId.toNumber()).toBe(USDT_ASSET_ID)
  expect(from.toString()).toBe(sovereign)
  expect(to.toString()).toBe(encodeAddress(member.address, assetHubClient.config.properties.addressEncoding))
  expect(amount.toBigInt()).toBe(salary)

  // 7. Balances
  expect(await usdtBalance(assetHubClient, member.address)).toBe(memberBefore + salary)
  expect(await usdtBalance(assetHubClient, sovereign)).toBe(budget - salary)
}

/**
 * `payout_other` pays a registered member's salary to another account on Asset Hub. The member's own balance does not
 * move.
 *
 * 1. Register a rank 1 member for a fresh cycle, and fund the paymaster sovereign with one budget
 * 2. Open the payout window, and the member calls `payout_other` for a fresh beneficiary
 * 3. Verify `Paid` names the member as `who` and the other account as `beneficiary`, for the salary, and was free
 * 4. Build a block on Asset Hub, and verify the beneficiary gained exactly the salary while the member gained nothing
 */
export async function salaryPayoutOtherTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_payout_other_member`)
  const beneficiary = testAccounts.keyring.createFromUri(`//${instance.pallet}_payout_other_beneficiary`)
  const encoding = collectivesClient.config.properties.addressEncoding

  // 1. Registered member, funded paymaster
  const { salary } = await registerForNextCycle(collectivesClient, instance, member)
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  await setUsdtBalance(assetHubClient, sovereign, instanceBudget(collectivesClient, instance))
  const memberBefore = await usdtBalance(assetHubClient, member.address)
  const beneficiaryBefore = await usdtBalance(assetHubClient, beneficiary.address)

  // 2. Pay to the other account
  await openPayoutWindow(collectivesClient, instance)
  await sendTransaction(collectivesClient.api.tx[instance.pallet].payoutOther(beneficiary.address).signAsync(member))
  await collectivesClient.dev.newBlock()

  // 3. Paid to the beneficiary, free
  await checkSystemEvents(collectivesClient, { section: instance.pallet, method: 'Paid' })
    .redact({ redactKeys: /^id$/ })
    .toMatchSnapshot('payout_other: Paid')
  const paid = (await paidEvents(collectivesClient, instance)).get(encodeAddress(member.address, encoding))
  assert(paid, 'no Paid event for the member')
  expect(paid.beneficiary.toString()).toBe(encodeAddress(beneficiary.address, encoding))
  expect(paid.amount.toBigInt()).toBe(salary)
  expect(await feePaidBy(collectivesClient, member)).toBe(0n)

  // 4. Only the beneficiary is credited
  await processPaymentOnAssetHub(assetHubClient)
  expect(await usdtBalance(assetHubClient, beneficiary.address)).toBe(beneficiaryBefore + salary)
  expect(await usdtBalance(assetHubClient, member.address)).toBe(memberBefore)
}

/**
 * `payout` fails with `TooEarly` in the last block of the registration window, so no one is paid while others can
 * still register.
 *
 * 1. Register a rank 1 member for a fresh cycle
 * 2. Move `cycleStart` so that the next block is the last block of the registration window
 * 3. The member calls `payout`
 * 4. Verify `TooEarly`, and that the claim and the status did not change
 */
export async function salaryPayoutTooEarlyTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_early_payout_member`)

  // 1. Registered member
  await registerForNextCycle(client, instance, member)

  // 2. The window ends at `cycleStart + registrationPeriod`, one block after the next
  await setInstanceCycleStart(client, instance, (await headNumber(client)) + 2 - registrationPeriod(client, instance))
  const statusBefore = await readInstanceStatus(client, instance)
  const claimantBefore = await readInstanceClaimant(client, instance, member.address)

  // 3. Payout
  await sendTransaction(client.api.tx[instance.pallet].payout().signAsync(member))
  await client.dev.newBlock()

  // 4. TooEarly, nothing changed
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'payout in the registration window: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'TooEarly')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(claimantBefore)
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
}

/**
 * A second `payout` in the same cycle fails with `NoClaim`: the first one turned the claim into an attempt, so a
 * member cannot be paid twice for one cycle.
 *
 * 1. Register a rank 1 member for a fresh cycle, open the payout window, and pay out once
 * 2. The member calls `payout` again
 * 3. Verify `NoClaim`, and that the claim still holds the first attempt
 */
export async function salaryPayoutTwiceTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_double_payout_member`)

  // 1. One payout made
  await registerForNextCycle(client, instance, member)
  await openPayoutWindow(client, instance)
  await sendTransaction(client.api.tx[instance.pallet].payout().signAsync(member))
  await client.dev.newBlock()
  const attempted = await readInstanceClaimant(client, instance, member.address)
  assert(attempted && 'attempted' in attempted.status, 'the first payout did not record an attempt')

  // 2. Second payout
  await sendTransaction(client.api.tx[instance.pallet].payout().signAsync(member))
  await client.dev.newBlock()

  // 3. NoClaim, first attempt kept
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'second payout: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NoClaim')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(attempted)
}

/**
 * `payout` fails with `PayError` when the paymaster cannot send its XCM, and the claim stays `Registered` so the member
 * can try again. Governance can cause this by pointing the salary asset at a chain Collectives has no channel to.
 *
 * Only instances whose salary asset is a runtime parameter can reach this; a fixed asset on Asset Hub always has a
 * route.
 *
 * 1. Skip unless the runtime has a salary parameter for this instance
 * 2. Register a rank 1 member for a fresh cycle
 * 3. Pick a parachain with no channel from Collectives, and as Root move the salary asset there, keeping the budget
 *    and the rank 1 salary
 * 4. Open the payout window, and the member calls `payout`
 * 5. Verify `PayError`, that the claim and the status did not change, and that no XCMP message went out
 */
export async function salaryPayoutUnroutableAssetTest(client: AnyClient, instance: SalaryInstance, ctx: TestContext) {
  const api = client.api
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_unroutable_member`)

  // 1. The `parameters` key enum names each configurable salary instance after its pallet
  const keyType = api.registry.lookup.getTypeDef((api.query.parameters.parameters.creator.meta.type as any).asMap.key)
  const configurable = ((keyType.sub ?? []) as { name?: string }[]).map(({ name }) => name)
  if (!configurable.includes(instance.storage)) {
    ctx.skip(`${instance.storage} has no salary parameter, so its asset is fixed and always routable`)
  }

  // 2. Registered member
  const { salary } = await registerForNextCycle(client, instance, member)

  // 3. Asset on a parachain without a channel. 2000 is an arbitrary parachain id; the check below keeps it honest.
  const unroutablePara = 2000
  const messaging = ((await api.query.parachainSystem.relevantMessagingState()) as any).unwrap()
  const egress = messaging.egressChannels.map(([paraId]: [any]) => paraId.toNumber())
  expect(egress).not.toContain(unroutablePara)
  // The bundled API types describe the parameters of a different runtime, so the Collectives value is passed untyped.
  const parameter: any = {
    [instance.storage]: {
      SalaryConfig: [
        null,
        {
          asset: {
            V5: {
              location: { parents: 1, interior: { X1: [{ Parachain: unroutablePara }] } },
              assetId: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: USDT_ASSET_ID }] } },
            },
          },
          budget: instanceBudget(client, instance),
          salaryRank1: salary,
        },
      ],
    },
  }
  await dispatchAsRoot(client, [api.tx.parameters.setParameter(parameter)])

  // 4. Payout
  await openPayoutWindow(client, instance)
  const statusBefore = await readInstanceStatus(client, instance)
  await sendTransaction(api.tx[instance.pallet].payout().signAsync(member))
  await client.dev.newBlock()

  // 5. PayError, claim kept, nothing sent
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'payout with an unroutable asset: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'PayError')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual({
    lastActive: statusBefore!.cycleIndex,
    status: { registered: salary },
  })
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
  const events = await api.query.system.events()
  expect(events.filter(({ event }) => api.events.xcmpQueue.XcmpMessageSent.is(event))).toHaveLength(0)
}

/// -------------------------
/// Instance tests - Budget
/// -------------------------

/**
 * Create `count` funded rank 1 members, inducted, with the instance in a fresh cycle in which they may register.
 * Returns the members and the rank 1 salary.
 */
async function inductedMembersInFreshCycle(
  client: AnyClient,
  instance: SalaryInstance,
  role: string,
  count: number,
): Promise<{ members: KeyringPair[]; salary: bigint }> {
  const members = Array.from({ length: count }, (_, i) =>
    testAccounts.keyring.createFromUri(`//${instance.pallet}_${role}_${i}`),
  )
  await setupMembers(
    client,
    instance,
    members.map((pair) => ({ pair, rank: 1 })),
  )
  await ensureCycleStarted(client, instance, members[0])
  await inductMembers(client, instance, members)
  await startNextCycle(client, instance, members[0])
  return { members, salary: await instance.rank1Salary(client) }
}

/** Each of `members` calls `register`, all in one block, and the cycle total grows by one salary each. */
async function registerAll(client: AnyClient, instance: SalaryInstance, members: KeyringPair[], salary: bigint) {
  const before = (await readInstanceStatus(client, instance))!.totalRegistrations
  for (const member of members) {
    await sendTransaction(client.api.tx[instance.pallet].register().signAsync(member))
  }
  await client.dev.newBlock()
  expect((await readInstanceStatus(client, instance))!.totalRegistrations).toBe(
    before + salary * BigInt(members.length),
  )
}

/**
 * When registrations exceed the budget, every registered member is paid pro rata, and the cycle's payouts stay within
 * the budget. The share is `Perbill::from_rational(budget, total)` applied with `mul_floor`, both rounding down.
 *
 * Both instances' budgets cover exactly two rank 1 salaries, so three registrations are enough.
 *
 * 1. Induct one more rank 1 member than the budget covers, and start a fresh cycle
 * 2. All of them register; verify the cycle total exceeds the budget
 * 3. Fund the paymaster sovereign with twice the budget, open the payout window, and all of them call `payout` in one
 *    block. The headroom keeps the sovereign above the USDT minimum balance: Asset Hub would otherwise reap it and
 *    burn the rounding remainder, and the debit would no longer equal the payouts.
 * 4. Verify each `Paid` amount is the pro rata share
 * 5. Build a block on Asset Hub, and verify each member gained the share and the sovereign lost exactly the payouts,
 *    which stay within the budget
 */
export async function salaryProratedPayoutTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const encoding = collectivesClient.config.properties.addressEncoding
  const budget = instanceBudget(collectivesClient, instance)

  // 1. The member count depends on the rank 1 salary, which the instance config may set first
  const configCalls = instance.configCalls(collectivesClient.api)
  if (configCalls.length > 0) {
    await dispatchAsRoot(collectivesClient, configCalls)
  }
  const count = Number(budget / (await instance.rank1Salary(collectivesClient))) + 1
  expect(count).toBeLessThanOrEqual(5)
  const { members, salary } = await inductedMembersInFreshCycle(collectivesClient, instance, 'prorated', count)

  // 2. Over-subscribed cycle
  await registerAll(collectivesClient, instance, members, salary)
  const total = (await readInstanceStatus(collectivesClient, instance))!.totalRegistrations
  expect(total).toBeGreaterThan(budget)

  // 3. Everyone is paid in the same block
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  await setUsdtBalance(assetHubClient, sovereign, 2n * budget)
  for (const member of members) {
    expect(await usdtBalance(assetHubClient, member.address)).toBe(0n)
  }
  await openPayoutWindow(collectivesClient, instance)
  for (const member of members) {
    await sendTransaction(collectivesClient.api.tx[instance.pallet].payout().signAsync(member))
  }
  await collectivesClient.dev.newBlock()

  // 4. Pro rata share, rounded down twice as `Perbill` does
  const share = (((budget * 1_000_000_000n) / total) * salary) / 1_000_000_000n
  expect(share).toBeLessThan(salary)
  await checkSystemEvents(collectivesClient, { section: instance.pallet, method: 'Paid' })
    .redact({ redactKeys: /^id$/ })
    .toMatchSnapshot('prorated payouts: Paid')
  const paid = await paidEvents(collectivesClient, instance)
  expect(paid.size).toBe(count)
  for (const member of members) {
    expect(paid.get(encodeAddress(member.address, encoding))?.amount.toBigInt()).toBe(share)
  }

  // 5. Credited shares, debit within the budget
  await processPaymentOnAssetHub(assetHubClient)
  for (const member of members) {
    expect(await usdtBalance(assetHubClient, member.address)).toBe(share)
  }
  const debit = 2n * budget - (await usdtBalance(assetHubClient, sovereign))
  expect(debit).toBe(share * BigInt(count))
  expect(debit).toBeLessThanOrEqual(budget)
}

/**
 * Once registrations take up the whole budget, a member who did not register gets nothing: its `payout` fails with
 * `ClaimZero`, because the pot left for unregistered members is empty.
 *
 * 1. Induct enough rank 1 members to use up the budget, plus one more, and start a fresh cycle
 * 2. All but the last register; verify the cycle total reaches the budget
 * 3. Open the payout window, and the unregistered member calls `payout`
 * 4. Verify `ClaimZero`, that its claim did not change, and that nothing counts as an unregistered payout
 */
export async function salaryUnregisteredPayoutEmptyPotTest(client: AnyClient, instance: SalaryInstance) {
  const budget = instanceBudget(client, instance)

  // 1. Registrants that use up the budget (rounded up), plus one member who will not register. The count depends on
  //    the rank 1 salary, which the instance config may set first.
  const configCalls = instance.configCalls(client.api)
  if (configCalls.length > 0) {
    await dispatchAsRoot(client, configCalls)
  }
  const rank1 = await instance.rank1Salary(client)
  const registrants = Number((budget + rank1 - 1n) / rank1)
  expect(registrants).toBeLessThanOrEqual(5)
  const { members, salary } = await inductedMembersInFreshCycle(client, instance, 'empty_pot', registrants + 1)
  const unregistered = members[registrants]

  // 2. Registrations use the budget
  await registerAll(client, instance, members.slice(0, registrants), salary)
  expect((await readInstanceStatus(client, instance))!.totalRegistrations).toBeGreaterThanOrEqual(budget)

  // 3. Unregistered payout
  await openPayoutWindow(client, instance)
  const claimantBefore = await readInstanceClaimant(client, instance, unregistered.address)
  await sendTransaction(client.api.tx[instance.pallet].payout().signAsync(unregistered))
  await client.dev.newBlock()

  // 4. ClaimZero, nothing paid
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'unregistered payout with an empty pot: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'ClaimZero')
  expect(await readInstanceClaimant(client, instance, unregistered.address)).toEqual(claimantBefore)
  expect((await readInstanceStatus(client, instance))!.totalUnregisteredPaid).toBe(0n)
}

/**
 * A registration that was never paid out does not carry into the next cycle: in that cycle the member is paid as an
 * unregistered member, from the pot, rather than being locked out. This is the fix in polkadot-sdk "pallet-salary: Fix
 * unpayable registrations from previous cycles", released in stable2512.
 *
 * 1. Register a rank 1 member for a fresh cycle
 * 2. Start the next cycle without paying out; verify the stale registration is still recorded
 * 3. Fund the paymaster sovereign with one budget, open the payout window, and the member calls `payout`
 * 4. Verify `Paid` is for the rank 1 salary, capped by the pot, and that it counts as an unregistered payout
 * 5. Build a block on Asset Hub, and verify the member gained the amount paid
 */
export async function salaryStaleRegistrationPayoutTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_stale_member`)
  const memberAddress = encodeAddress(member.address, collectivesClient.config.properties.addressEncoding)

  // 1. Registered member
  const { cycle: registeredCycle, salary } = await registerForNextCycle(collectivesClient, instance, member)

  // 2. Next cycle, registration unpaid
  const cycle = await startNextCycle(collectivesClient, instance, member)
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: registeredCycle.cycleIndex,
    status: { registered: salary },
  })

  // 3. Payout in the new cycle
  const budget = instanceBudget(collectivesClient, instance)
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  await setUsdtBalance(assetHubClient, sovereign, budget)
  await openPayoutWindow(collectivesClient, instance)
  await sendTransaction(collectivesClient.api.tx[instance.pallet].payout().signAsync(member))
  await collectivesClient.dev.newBlock()

  // 4. Paid from the pot, as an unregistered member: `min(salary, budget - registrations - unregistered paid)`
  const expected = salary < cycle.budget ? salary : cycle.budget
  await checkSystemEvents(collectivesClient, { section: instance.pallet, method: 'Paid' })
    .redact({ redactKeys: /^id$/ })
    .toMatchSnapshot('stale registration payout: Paid')
  const paid = (await paidEvents(collectivesClient, instance)).get(memberAddress)
  assert(paid, 'no Paid event for the member')
  expect(paid.amount.toBigInt()).toBe(expected)
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { attempted: { registered: null, id: paid.id.toBigInt(), amount: expected } },
  })
  const status = (await readInstanceStatus(collectivesClient, instance))!
  expect(status.totalUnregisteredPaid).toBe(expected)
  expect(status.totalRegistrations).toBe(0n)

  // 5. Credited on Asset Hub
  await processPaymentOnAssetHub(assetHubClient)
  expect(await usdtBalance(assetHubClient, member.address)).toBe(expected)
}

/// ---------------------------------
/// Instance tests - Payment status
/// ---------------------------------

/**
 * Build one block on Collectives, which takes in Asset Hub's answer to the payment's XCM query, and return the
 * `polkadotXcm.ResponseReady` for that query.
 */
async function receivePaymentResponse(client: AnyClient, paymentId: bigint): Promise<any> {
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  // `polkadotXcm` is not in the bundled API types, so the event fields are read untyped.
  const ready = events.find(
    ({ event }) =>
      client.api.events.polkadotXcm.ResponseReady.is(event) && (event.data as any).queryId.toBigInt() === paymentId,
  )
  assert(ready, `no ResponseReady for payment ${paymentId}`)
  return (ready.event.data as any).response
}

/** Make `member` pay out once in the current payout window, and return the payment id recorded in its claim. */
async function payOut(client: AnyClient, instance: SalaryInstance, member: KeyringPair): Promise<bigint> {
  await sendTransaction(client.api.tx[instance.pallet].payout().signAsync(member))
  await client.dev.newBlock()
  const claimant = await readInstanceClaimant(client, instance, member.address)
  assert(claimant && 'attempted' in claimant.status, 'payout did not record an attempt')
  return claimant.status.attempted.id
}

/**
 * After Asset Hub executes a payment, its answer to the payment's XCM query reaches Collectives, and `check_payment`
 * confirms it: the claim is cleared for the cycle, and the call is free.
 *
 * 1. Register a rank 1 member for a fresh cycle, fund the paymaster sovereign, open the payout window and pay out
 * 2. Build a block on Asset Hub, which executes the transfer and answers the query
 * 3. Build a block on Collectives, and verify `polkadotXcm.ResponseReady` reports success for the payment
 * 4. The member calls `check_payment`
 * 5. Verify the claim is `Nothing` for the cycle, the status did not change, and the call was free
 */
export async function salaryCheckPaymentDeliveredTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_success_member`)

  // 1. One payment sent
  const { cycle } = await registerForNextCycle(collectivesClient, instance, member)
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  await setUsdtBalance(assetHubClient, sovereign, instanceBudget(collectivesClient, instance))
  await openPayoutWindow(collectivesClient, instance)
  const paymentId = await payOut(collectivesClient, instance, member)

  // 2. Executed on Asset Hub
  await processPaymentOnAssetHub(assetHubClient)

  // 3. Success answer on Collectives; the query id comes from a live counter, so it is redacted
  const response = await receivePaymentResponse(collectivesClient, paymentId)
  await checkSystemEvents(collectivesClient, { section: 'polkadotXcm', method: 'ResponseReady' })
    .redact({ redactKeys: /^queryId$/ })
    .toMatchSnapshot('delivered payment: ResponseReady')
  expect(response.isExecutionResult && response.asExecutionResult.isNone).toBe(true)

  // 4. Check the payment
  const statusBefore = await readInstanceStatus(collectivesClient, instance)
  await sendTransaction(collectivesClient.api.tx[instance.pallet].checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()

  // 5. Claim cleared, free
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { nothing: null },
  })
  expect(await readInstanceStatus(collectivesClient, instance)).toEqual(statusBefore)
  expect(await feePaidBy(collectivesClient, member)).toBe(0n)
}

/**
 * Until Asset Hub answers, the payment's query is still pending, so `check_payment` fails with `Inconclusive` and the
 * attempt stays recorded.
 *
 * 1. Register a rank 1 member for a fresh cycle, open the payout window and pay out
 * 2. Without building a block on Asset Hub, the member calls `check_payment`
 * 3. Verify `Inconclusive`, and that the claim still holds the attempt
 */
export async function salaryCheckPaymentPendingTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_pending_member`)

  // 1. One payment sent
  await registerForNextCycle(client, instance, member)
  await openPayoutWindow(client, instance)
  await payOut(client, instance, member)
  const attempted = await readInstanceClaimant(client, instance, member.address)

  // 2. Check before any answer
  await sendTransaction(client.api.tx[instance.pallet].checkPayment().signAsync(member))
  await client.dev.newBlock()

  // 3. Inconclusive, attempt kept
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'check of a pending payment: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'Inconclusive')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(attempted)
}

/**
 * A payment that fails on Asset Hub is reported back, and `check_payment` turns the claim back into the registration,
 * so the member can be paid again in the same cycle. Here the paymaster sovereign holds less than the salary.
 *
 * 1. Register a rank 1 member for a fresh cycle, and leave the paymaster sovereign with only the USDT minimum balance
 * 2. Open the payout window and pay out
 * 3. Build a block on Asset Hub; verify the message failed and nothing was transferred
 * 4. Build a block on Collectives; verify `ResponseReady` reports the error for the payment
 * 5. The member calls `check_payment`; verify the claim is `Registered` again and the status did not change
 * 6. Fund the sovereign, pay out again, and build a block on Asset Hub; verify the member gained the salary
 */
export async function salaryCheckPaymentFailureRetryTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_failure_member`)

  // 1. Registered member, underfunded paymaster
  const { cycle, salary } = await registerForNextCycle(collectivesClient, instance, member)
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  const minBalance = ((await assetHubClient.api.query.assets.asset(USDT_ASSET_ID)) as any)
    .unwrap()
    .minBalance.toBigInt()
  expect(minBalance).toBeLessThan(salary)
  await setUsdtBalance(assetHubClient, sovereign, minBalance)

  // 2. Payout
  await openPayoutWindow(collectivesClient, instance)
  const paymentId = await payOut(collectivesClient, instance, member)
  const statusAfterPayout = await readInstanceStatus(collectivesClient, instance)

  // 3. The transfer fails on Asset Hub
  await assetHubClient.dev.newBlock()
  await checkSystemEvents(assetHubClient, { section: 'messageQueue', method: 'Processed' })
    .redact({ redactKeys: /^id$/ })
    .toMatchSnapshot('underfunded payment: Asset Hub Processed')
  const assetHubEvents = await assetHubClient.api.query.system.events()
  expect(assetHubEvents.some(({ event }) => assetHubClient.api.events.assets.Transferred.is(event))).toBe(false)
  expect(await usdtBalance(assetHubClient, sovereign)).toBe(minBalance)
  expect(await usdtBalance(assetHubClient, member.address)).toBe(0n)

  // 4. Error answer on Collectives
  const response = await receivePaymentResponse(collectivesClient, paymentId)
  await checkSystemEvents(collectivesClient, { section: 'polkadotXcm', method: 'ResponseReady' })
    .redact({ redactKeys: /^queryId$/ })
    .toMatchSnapshot('underfunded payment: ResponseReady')
  expect(response.isExecutionResult && response.asExecutionResult.isSome).toBe(true)

  // 5. The check restores the registration
  await sendTransaction(collectivesClient.api.tx[instance.pallet].checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex,
    status: { registered: salary },
  })
  expect(await readInstanceStatus(collectivesClient, instance)).toEqual(statusAfterPayout)

  // 6. A retry with a funded paymaster pays the salary
  await setUsdtBalance(assetHubClient, sovereign, instanceBudget(collectivesClient, instance))
  await payOut(collectivesClient, instance, member)
  await processPaymentOnAssetHub(assetHubClient)
  expect(await usdtBalance(assetHubClient, member.address)).toBe(salary)
}

/**
 * When an unregistered payout fails on Asset Hub, `check_payment` gives the money back to the pot and moves the claim
 * back one cycle, so the member can be paid again from the pot in the same cycle.
 *
 * 1. Make a rank 1 member, start the instance if needed, induct it, and start the next cycle without registering
 * 2. Leave the paymaster sovereign with only the USDT minimum balance, open the payout window and pay out from the pot
 * 3. Verify the payout counts as unregistered
 * 4. Build a block on Asset Hub, then one on Collectives; verify `ResponseReady` reports the error
 * 5. The member calls `check_payment`; verify the claim is `Nothing` one cycle back and the unregistered total is zero
 */
export async function salaryCheckPaymentUnregisteredFailureTest(
  collectivesClient: AnyClient,
  assetHubClient: AnyClient,
  instance: SalaryInstance,
) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_unregistered_member`)

  // 1. Eligible but unregistered member
  await setupMembers(collectivesClient, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(collectivesClient, instance, member)
  await inductMembers(collectivesClient, instance, [member])
  const cycle = await startNextCycle(collectivesClient, instance, member)

  // 2. Underfunded paymaster, payout from the pot
  const sovereign = await paymasterSovereign(collectivesClient, assetHubClient, instance)
  const minBalance = ((await assetHubClient.api.query.assets.asset(USDT_ASSET_ID)) as any)
    .unwrap()
    .minBalance.toBigInt()
  await setUsdtBalance(assetHubClient, sovereign, minBalance)
  await openPayoutWindow(collectivesClient, instance)
  const paymentId = await payOut(collectivesClient, instance, member)

  // 3. Unregistered payout recorded
  const attempted = await readInstanceClaimant(collectivesClient, instance, member.address)
  assert(attempted && 'attempted' in attempted.status)
  expect(attempted.status.attempted.registered).toBeNull()
  expect((await readInstanceStatus(collectivesClient, instance))!.totalUnregisteredPaid).toBe(
    attempted.status.attempted.amount,
  )

  // 4. Failure reported back
  await assetHubClient.dev.newBlock()
  const response = await receivePaymentResponse(collectivesClient, paymentId)
  expect(response.isExecutionResult && response.asExecutionResult.isSome).toBe(true)

  // 5. Pot and cycle rolled back
  await sendTransaction(collectivesClient.api.tx[instance.pallet].checkPayment().signAsync(member))
  await collectivesClient.dev.newBlock()
  expect(await readInstanceClaimant(collectivesClient, instance, member.address)).toEqual({
    lastActive: cycle.cycleIndex - 1,
    status: { nothing: null },
  })
  expect((await readInstanceStatus(collectivesClient, instance))!.totalUnregisteredPaid).toBe(0n)
}

/**
 * Once the next cycle starts, a payment from the previous cycle can no longer be checked: `check_payment` fails with
 * `NotCurrent`, and the attempt stays as it was.
 *
 * 1. Register a rank 1 member for a fresh cycle, open the payout window and pay out
 * 2. Start the next cycle
 * 3. The member calls `check_payment`
 * 4. Verify `NotCurrent`, and that the claim did not change
 */
export async function salaryCheckPaymentNotCurrentTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_stale_member`)

  // 1. One payment sent
  await registerForNextCycle(client, instance, member)
  await openPayoutWindow(client, instance)
  await payOut(client, instance, member)

  // 2. Next cycle
  await startNextCycle(client, instance, member)
  const claimantBefore = await readInstanceClaimant(client, instance, member.address)

  // 3. Check
  await sendTransaction(client.api.tx[instance.pallet].checkPayment().signAsync(member))
  await client.dev.newBlock()

  // 4. NotCurrent, attempt kept
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'check after the next cycle: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NotCurrent')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(claimantBefore)
}

/**
 * With nothing paid out, there is no payment to check: `check_payment` fails with `NoClaim`.
 *
 * 1. Make a rank 1 member, start the instance if needed, and induct the member
 * 2. The member calls `check_payment`
 * 3. Verify `NoClaim`, and that the claim did not change
 */
export async function salaryCheckPaymentNothingAttemptedTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_check_nothing_member`)

  // 1. Inducted member
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  const claimantBefore = await readInstanceClaimant(client, instance, member.address)

  // 2. Check
  await sendTransaction(client.api.tx[instance.pallet].checkPayment().signAsync(member))
  await client.dev.newBlock()

  // 3. NoClaim
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'check with nothing paid: ExtrinsicFailed',
  )
  await expectSalaryError(client, instance, 'NoClaim')
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(claimantBefore)
}

/// -------------------------------
/// Instance tests - Account swap
/// -------------------------------

/**
 * When a member's account is exchanged in the instance's collective, the salary claim moves to the new account
 * unchanged, through the collective's swap handler.
 *
 * 1. Make a rank 1 member, start the instance if needed, and induct the member
 * 2. As Root, exchange the member for a fresh account in the instance's collective
 * 3. Verify `Swapped { who, newWho }`
 * 4. Verify the new account holds the old claim, and the old account holds none
 */
export async function salarySwapMovesClaimTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_old`)
  const replacement = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_new`)
  const encoding = client.config.properties.addressEncoding

  // 1. Inducted member
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [member])
  const claim = await readInstanceClaimant(client, instance, member.address)

  // 2. Exchange
  await dispatchAsRoot(client, [client.api.tx[instance.collective].exchangeMember(member.address, replacement.address)])

  // 3. Swapped
  await checkSystemEvents(client, { section: instance.pallet, method: 'Swapped' }).toMatchSnapshot(
    'exchange member: Swapped',
  )
  const events = await client.api.query.system.events()
  const swapped = events.find(({ event }) => client.api.events[instance.pallet].Swapped.is(event))
  assert(swapped)
  const data = swapped.event.data as any
  expect(data.who.toString()).toBe(encodeAddress(member.address, encoding))
  expect(data.newWho.toString()).toBe(encodeAddress(replacement.address, encoding))

  // 4. Claim moved as it was
  expect(await readInstanceClaimant(client, instance, replacement.address)).toEqual(claim)
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()
}

/**
 * Exchanging a member who never inducted moves no claim: the salary swap handler finds none and does nothing, while
 * the collective still exchanges the accounts.
 *
 * 1. Make a rank 1 member, without inducting it
 * 2. As Root, exchange the member for a fresh account in the instance's collective
 * 3. Verify the collective exchanged the accounts, no `Swapped` was emitted, and neither account has a claim
 */
export async function salarySwapWithoutClaimTest(client: AnyClient, instance: SalaryInstance) {
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_unclaimed_old`)
  const replacement = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_unclaimed_new`)

  // 1. Member without a claim
  await setupMembers(client, instance, [{ pair: member, rank: 1 }])
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()

  // 2. Exchange
  await dispatchAsRoot(client, [client.api.tx[instance.collective].exchangeMember(member.address, replacement.address)])

  // 3. Accounts exchanged, no claim moved or created
  const events = await client.api.query.system.events()
  expect(events.some(({ event }) => client.api.events[instance.collective].MemberExchanged.is(event))).toBe(true)
  expect(events.filter(({ event }) => client.api.events[instance.pallet].Swapped.is(event))).toHaveLength(0)
  expect(((await client.api.query[instance.collective].members(replacement.address)) as any).isSome).toBe(true)
  expect(await readInstanceClaimant(client, instance, member.address)).toBeNull()
  expect(await readInstanceClaimant(client, instance, replacement.address)).toBeNull()
}

/**
 * The salary swap handler never overwrites a claim. A removed member keeps its claim record, so exchanging another
 * member onto that account leaves both claims where they were, and emits no `Swapped`.
 *
 * 1. Make two rank 1 members, start the instance if needed, and induct both
 * 2. As Root, remove the first from the collective; verify its claim record remains
 * 3. As Root, exchange the second member for the first account
 * 4. Verify the collective exchanged the accounts, no `Swapped` was emitted, and each account kept its own claim
 */
export async function salarySwapOntoExistingClaimTest(client: AnyClient, instance: SalaryInstance) {
  const removed = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_removed`)
  const member = testAccounts.keyring.createFromUri(`//${instance.pallet}_swap_member`)

  // 1. Two inducted members
  await setupMembers(client, instance, [
    { pair: removed, rank: 1 },
    { pair: member, rank: 1 },
  ])
  await ensureCycleStarted(client, instance, member)
  await inductMembers(client, instance, [removed, member])
  const removedClaim = await readInstanceClaimant(client, instance, removed.address)
  const memberClaim = await readInstanceClaimant(client, instance, member.address)

  // 2. Removal leaves the claim behind
  await dispatchAsRoot(client, [client.api.tx[instance.collective].removeMember(removed.address, 1)])
  expect(((await client.api.query[instance.collective].members(removed.address)) as any).isNone).toBe(true)
  expect(await readInstanceClaimant(client, instance, removed.address)).toEqual(removedClaim)

  // 3. Exchange onto the removed account
  await dispatchAsRoot(client, [client.api.tx[instance.collective].exchangeMember(member.address, removed.address)])

  // 4. Accounts exchanged, claims untouched
  const events = await client.api.query.system.events()
  expect(events.some(({ event }) => client.api.events[instance.collective].MemberExchanged.is(event))).toBe(true)
  expect(events.filter(({ event }) => client.api.events[instance.pallet].Swapped.is(event))).toHaveLength(0)
  expect(await readInstanceClaimant(client, instance, removed.address)).toEqual(removedClaim)
  expect(await readInstanceClaimant(client, instance, member.address)).toEqual(memberClaim)
}

/// --------------------------
/// Instance tests - Origins
/// --------------------------

/**
 * Every salary call needs a signed origin. Dispatched as Root, each one fails with `BadOrigin`, so not even Root can
 * start, move or pay out the instance.
 *
 * 1. Record the status, which is absent on an unstarted instance
 * 2. As Root, dispatch one `utility.forceBatch` of all seven salary calls
 * 3. Verify all seven items failed with `BadOrigin`, and that the status did not change
 */
export async function salaryRootOriginTest(client: AnyClient, instance: SalaryInstance) {
  const salary = client.api.tx[instance.pallet]
  const beneficiary = testAccounts.keyring.createFromUri(`//${instance.pallet}_root_beneficiary`)

  // 1. Status before
  const statusBefore = await readInstanceStatus(client, instance)

  // 2. All calls as Root
  const calls = [
    salary.init(),
    salary.bump(),
    salary.induct(),
    salary.register(),
    salary.payout(),
    salary.payoutOther(beneficiary.address),
    salary.checkPayment(),
  ]
  await dispatchAsRoot(client, [client.api.tx.utility.forceBatch(calls)])

  // 3. BadOrigin for each, nothing changed
  await checkSystemEvents(client, 'utility').toMatchSnapshot('salary calls as Root: utility events')
  await expectBatchItemsFailed(client, instance, calls.length, 'BadOrigin')
  expect(await readInstanceStatus(client, instance)).toEqual(statusBefore)
}

/// ---------------------------
/// Instance test tree builder
/// ---------------------------

/**
 * Build the salary test tree for one instance on Collectives, with Asset Hub as the chain the paymaster pays on.
 */
export function salaryInstanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesCollectives extends Record<string, Record<string, any>> | undefined,
  TInitStoragesAssetHub extends Record<string, Record<string, any>> | undefined,
>(
  collectivesChain: Chain<TCustom, TInitStoragesCollectives>,
  assetHubChain: Chain<TCustom, TInitStoragesAssetHub>,
  testConfig: SalaryInstanceTestConfig,
): RootTestTree {
  const { instance } = testConfig
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

      // Reset both heads after the restore, so storage edits in the test apply at the live head. The restore does not
      // touch the message queues between the two forks, so an XCM that an earlier test sent but never delivered is
      // dropped here; otherwise it would run in this test's first block, with query ids that collide with its own.
      for (const client of [collectivesClient, assetHubClient]) {
        client.chain.txPool.clear()
        await client.dev.setHead(await headNumber(client))
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
        label: 'Cycle',
        children: [
          {
            kind: 'test',
            label: 'init - CycleStarted, cycle 0 opens with the budget',
            testFn: async (ctx) => await salaryInitOpensCycleZeroTest(collectivesClient, instance, ctx!),
          },
          {
            kind: 'test',
            label: 'init - already started - AlreadyStarted',
            testFn: async () => await salaryInitAlreadyStartedTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'bump - NotYet one block early, then CycleStarted at the boundary',
            testFn: async () => await salaryBumpAtCycleBoundaryTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'calls before init - NotStarted',
            testFn: async () => await salaryCallsBeforeInitTest(collectivesClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Induction',
        children: [
          {
            kind: 'test',
            label: 'induct - Inducted, claimant opens at the current cycle',
            testFn: async () => await salaryInductTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'induct - twice - AlreadyInducted',
            testFn: async () => await salaryInductTwiceTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'induct and register - Fellowship member - NotMember',
            testFn: async () => await salaryFellowIsNotMemberTest(collectivesClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Registration',
        children: [
          {
            kind: 'test',
            label: 'register - Registered with the rank 1 salary',
            testFn: async () => await salaryRegisterTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'register - in the induction cycle - NoClaim',
            testFn: async () => await salaryRegisterInInductionCycleTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'register - first block after the registration window - TooLate',
            testFn: async () => await salaryRegisterTooLateTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'register - rank 0 candidate - ClaimZero',
            testFn: async () => await salaryRegisterCandidateTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'register, payout, check_payment - not inducted - NotInducted',
            testFn: async () => await salaryNotInductedTest(collectivesClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Payout',
        children: [
          {
            kind: 'test',
            label: 'payout - registered member paid in USDT on Asset Hub from the paymaster sovereign',
            testFn: async () => await salaryPayoutTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'payout_other - beneficiary paid on Asset Hub',
            testFn: async () => await salaryPayoutOtherTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'payout - last block of the registration window - TooEarly',
            testFn: async () => await salaryPayoutTooEarlyTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'payout - twice in a cycle - NoClaim',
            testFn: async () => await salaryPayoutTwiceTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'payout - salary asset on a chain without a channel - PayError',
            testFn: async (ctx) => await salaryPayoutUnroutableAssetTest(collectivesClient, instance, ctx!),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Budget',
        children: [
          {
            kind: 'test',
            label: 'payout - registrations above the budget - prorated',
            testFn: async () => await salaryProratedPayoutTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'payout - unregistered member after registrations use the budget - ClaimZero',
            testFn: async () => await salaryUnregisteredPayoutEmptyPotTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'payout - stale registration from the previous cycle - paid from the pot',
            testFn: async () => await salaryStaleRegistrationPayoutTest(collectivesClient, assetHubClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Payment status',
        children: [
          {
            kind: 'test',
            label: 'check_payment - after a delivered payout - claimant reset to Nothing',
            testFn: async () => await salaryCheckPaymentDeliveredTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'check_payment - before Asset Hub responds - Inconclusive',
            testFn: async () => await salaryCheckPaymentPendingTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'check_payment - failed transfer on Asset Hub - claim back to Registered, retry pays',
            testFn: async () => await salaryCheckPaymentFailureRetryTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'check_payment - failed unregistered transfer - lastActive and pot rolled back',
            testFn: async () =>
              await salaryCheckPaymentUnregisteredFailureTest(collectivesClient, assetHubClient, instance),
          },
          {
            kind: 'test',
            label: 'check_payment - after the next cycle starts - NotCurrent',
            testFn: async () => await salaryCheckPaymentNotCurrentTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'check_payment - nothing attempted - NoClaim',
            testFn: async () => await salaryCheckPaymentNothingAttemptedTest(collectivesClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Account swap',
        children: [
          {
            kind: 'test',
            label: 'exchange_member - Swapped, claimant moves to the new account',
            testFn: async () => await salarySwapMovesClaimTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'exchange_member - member never inducted - no Swapped, no claimant created',
            testFn: async () => await salarySwapWithoutClaimTest(collectivesClient, instance),
          },
          {
            kind: 'test',
            label: 'exchange_member - onto a removed member that still has a claimant - claimant not moved',
            testFn: async () => await salarySwapOntoExistingClaimTest(collectivesClient, instance),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Origins',
        children: [
          {
            kind: 'test',
            label: 'all calls - Root origin - BadOrigin',
            testFn: async () => await salaryRootOriginTest(collectivesClient, instance),
          },
        ],
      },
    ],
  }
}
