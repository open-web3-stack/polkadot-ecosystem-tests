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

/** Create a deterministic keypair from a URI seed for salary tests. */
function createSalaryTestMember(seed: string): KeyringPair {
  return testAccounts.keyring.createFromUri(seed)
}

/** Assert salary status exists; return the unwrapped value. */
function requireSalaryStatus(status: FellowshipSalaryStatus | null): FellowshipSalaryStatus {
  assert(status !== null, 'Expected fellowship salary status to exist')
  return status
}

/** Read current chain head block number. */
async function currentBlockNumber(client: Client<any, any>): Promise<number> {
  return (await client.api.rpc.chain.getHeader()).number.toNumber()
}

/** Read current block system events. */
async function systemEvents(client: Client<any, any>) {
  return await client.api.query.system.events()
}

/** Return whether events contain the matched event. */
function hasEvent(events: any[], matcher: { is: (event: any) => boolean } | undefined): boolean {
  return matcher ? events.some(({ event }) => matcher.is(event)) : false
}

/** Assert the source chain emitted an outbound XCM event. */
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

/** Read salary runtime config from live chain state. */
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

/** Read `fellowshipSalary.status`; return `null` when absent. */
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

/** Read and decode `fellowshipSalary.claimant(address)`. */
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

/** Return active salary for the given Fellowship rank. */
export function activeSalaryForRank(params: FellowshipSalaryParams, rank: number): bigint {
  expect(rank).toBeGreaterThan(0)
  expect(rank).toBeLessThanOrEqual(params.activeSalary.length)

  /// `pallet-core-fellowship` stores salaries in rank-1 array slots.

  return params.activeSalary[rank - 1]
}

/** Read Hollar balance from Asset Hub `ForeignAssets`. */
export async function hollarBalance(assetHubClient: Client<any, any>, address: string): Promise<bigint> {
  const balance = (await assetHubClient.api.query.foreignAssets.account(HOLLAR_ASSET_LOCATION, address)) as any
  return balance.isSome ? (balance.unwrap() as any).balance.toBigInt() : 0n
}

/// -------
/// Storage writers/seeders
/// -------

/** Seed a funded Dan-3 Fellowship member for salary tests. */
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
 * Seed `fellowshipSalary.claimant` directly.
 *
 * @param lastActive Cycle index of the claimant's last interaction.
 * @param status Runtime claimant status variant.
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

/** Seed the salary sovereign Hollar balance on Asset Hub. */
export async function fundSalarySovereignHollar(assetHubClient: Client<any, any>, amount: bigint): Promise<void> {
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

/** Ensure a member has DOT on Asset Hub for existential deposit. */
export async function ensureMemberHasDotOnAssetHub(assetHubClient: Client<any, any>, address: string): Promise<void> {
  const ED = 10n ** 10n
  await assetHubClient.dev.setStorage({
    System: {
      account: [[[address], { providers: 1, data: { free: ED.toString(), frozen: 0, reserved: 0 } }]],
    },
  })
}

/// -------
/// Time manipulation
/// -------

/** Ensure the salary cycle exists; call `init()` when needed. */
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

/** Rewrite `cycleStart` while preserving other salary status fields. */
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

/** Move the current salary cycle into the registration window. */
export async function setSalaryCycleToRegistrationWindow(client: Client<any, any>): Promise<FellowshipSalaryStatus> {
  return await setSalaryCycleStart(client, await currentBlockNumber(client))
}

/** Move the current salary cycle into the payout window. */
export async function setSalaryCycleToPayoutWindow(
  client: Client<any, any>,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = await currentBlockNumber(client)
  return await setSalaryCycleStart(client, block - runtimeConfig.registrationPeriod - 1)
}

/** Move the current salary cycle past the bump boundary. */
export async function setSalaryCycleToBumpWindow(
  client: Client<any, any>,
  runtimeConfig: FellowshipSalaryRuntimeConfig,
): Promise<FellowshipSalaryStatus> {
  const block = await currentBlockNumber(client)
  return await setSalaryCycleStart(client, block - runtimeConfig.cyclePeriod - 1)
}

/** Advance to the next salary cycle with storage edits plus `bump()`. */
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

/** Submit `fellowshipSalary.induct()`; return system events. */
export async function inductSalaryMember(client: Client<any, any>, signer: KeyringPair): Promise<any[]> {
  await sendTransaction(client.api.tx.fellowshipSalary.induct().signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/** Submit `fellowshipSalary.register()`; return system events. */
export async function registerSalaryMember(client: Client<any, any>, signer: KeyringPair): Promise<any[]> {
  await sendTransaction(client.api.tx.fellowshipSalary.register().signAsync(signer))
  await client.dev.newBlock()
  return await systemEvents(client)
}

/** Submit `payout()` or `payoutOther()`; return system events. */
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

/** Advance Asset Hub one block to process queued salary XCM. */
export async function processSalaryPayoutOnAssetHub(assetHubClient: Client<any, any>): Promise<any[]> {
  await assetHubClient.dev.newBlock()
  return await systemEvents(assetHubClient)
}

/// -------
/// Test functions
/// -------

/**
 * Full salary lifecycle: induct → register → payout.
 *
 * 1. Seed Dan-3 member on Collectives and fund salary sovereign on Asset Hub
 * 2. Ensure the salary cycle is started
 * 3. Induct the member
 * 4. Bump to the next cycle
 * 5. Register for salary
 * 6. Move to payout window and call `payout()`
 * 7. Process XCM on Asset Hub; verify Hollar balance increased
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
  /// 2. Seed the validated salary sovereign account on Asset Hub with enough Hollar for one payout.
  ///

  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)
  await ensureMemberHasDotOnAssetHub(assetHubClient, member.address)

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

  const assetHubBalanceBefore = await hollarBalance(assetHubClient, member.address)

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
  /// 9. Process the horizontal XCM on Asset Hub and verify the Hollar transfer landed.
  ///

  await assetHubClient.dev.newBlock()
  const assetHubEvents = await systemEvents(assetHubClient)

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
export async function salaryStatusStorageTest(collectivesClient: Client<any, any>, assetHubClient: Client<any, any>) {
  const member = createSalaryTestMember('//salary_status_member')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureMemberHasDotOnAssetHub(assetHubClient, member.address)
  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

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
 * Verify `payoutOther()` delivers Hollar to an Asset Hub beneficiary.
 *
 * 1. Seed member, beneficiary ED, and sovereign Hollar
 * 2. Ensure the salary cycle is started
 * 3. Seed registered claimant state and move to payout window
 * 4. Call `payoutOther(beneficiary)`; verify Collectives events
 * 5. Process XCM on Asset Hub; verify `foreignAssets` transfer and beneficiary balance increase
 */
export async function salaryPayoutDeliversHollarToAssetHubBeneficiaryTest(
  collectivesClient: Client<any, any>,
  assetHubClient: Client<any, any>,
) {
  const member = createSalaryTestMember('//salary_cross_chain_member')
  const beneficiary = createSalaryTestMember('//salary_cross_chain_beneficiary')
  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const expectedSalary = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  await seedDan3SalaryMember(collectivesClient, member)
  await ensureMemberHasDotOnAssetHub(assetHubClient, beneficiary.address)
  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

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

  const balanceBefore = await hollarBalance(assetHubClient, beneficiary.address)
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
  await ensureMemberHasDotOnAssetHub(assetHubClient, registeredMember.address)
  await ensureMemberHasDotOnAssetHub(assetHubClient, unregisteredMember.address)
  await fundSalarySovereignHollar(assetHubClient, runtimeConfig.budget)

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

  const registeredBalanceBefore = await hollarBalance(assetHubClient, registeredMember.address)
  await payoutSalaryMember(collectivesClient, registeredMember)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const registeredBalanceAfter = await hollarBalance(assetHubClient, registeredMember.address)
  expect(registeredBalanceAfter - registeredBalanceBefore).toBe(expectedSalary)

  /// Now pay the unregistered member. They should get `min(ideal_salary, pot)`.
  /// pot = budget - total_registrations - total_unregistered_paid = budget - expectedSalary - 0

  const pot = runtimeConfig.budget - expectedSalary
  const expectedUnregisteredPayout = expectedSalary < pot ? expectedSalary : pot

  const unregisteredBalanceBefore = await hollarBalance(assetHubClient, unregisteredMember.address)
  await payoutSalaryMember(collectivesClient, unregisteredMember)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const unregisteredBalanceAfter = await hollarBalance(assetHubClient, unregisteredMember.address)

  expect(unregisteredBalanceAfter - unregisteredBalanceBefore).toBe(expectedUnregisteredPayout)

  /// Verify total_unregistered_paid was updated.

  const statusAfterUnregistered = requireSalaryStatus(await readSalaryStatus(collectivesClient))
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
export async function salaryProrationTest(collectivesClient: Client<any, any>, assetHubClient: Client<any, any>) {
  const member1 = createSalaryTestMember('//salary_proration_member_1')
  const member2 = createSalaryTestMember('//salary_proration_member_2')

  const runtimeConfig = await readSalaryRuntimeConfig(collectivesClient)
  const salaryPerMember = activeSalaryForRank(runtimeConfig.params, SALARY_MEMBER_RANK_DAN_3)

  /// Create a scenario where total registrations exceed budget by seeding a very small budget.

  const smallBudget = salaryPerMember / 2n

  await seedDan3SalaryMember(collectivesClient, member1)
  await seedDan3SalaryMember(collectivesClient, member2)
  await ensureMemberHasDotOnAssetHub(assetHubClient, member1.address)
  await ensureMemberHasDotOnAssetHub(assetHubClient, member2.address)
  await fundSalarySovereignHollar(assetHubClient, salaryPerMember * 2n)

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

  const balance1Before = await hollarBalance(assetHubClient, member1.address)
  await payoutSalaryMember(collectivesClient, member1)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const balance1After = await hollarBalance(assetHubClient, member1.address)

  const received1 = balance1After - balance1Before
  expect(received1).toBe(expectedProrated)

  /// Pay member2. They should also receive the same prorated amount.

  const balance2Before = await hollarBalance(assetHubClient, member2.address)
  await payoutSalaryMember(collectivesClient, member2)
  await processSalaryPayoutOnAssetHub(assetHubClient)
  const balance2After = await hollarBalance(assetHubClient, member2.address)

  const received2 = balance2After - balance2Before
  expect(received2).toBe(expectedProrated)

  /// Total paid should be <= small budget (may be slightly less due to integer division rounding).

  expect(received1 + received2).toBeLessThanOrEqual(smallBudget)
  expect(received1 + received2).toBeGreaterThanOrEqual(smallBudget - 2n)
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
            label: 'salary payout delivers Hollar to beneficiary on AssetHub',
            testFn: async () =>
              await salaryPayoutDeliversHollarToAssetHubBeneficiaryTest(collectivesClient, assetHubClient),
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
