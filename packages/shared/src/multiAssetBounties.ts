import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import type { ApiPromise } from '@polkadot/api'
import type { KeyringPair } from '@polkadot/keyring/types'

import { expect } from 'vitest'

import { logAllEvents } from './helpers/helpers.js'
import {
  checkEvents,
  checkSystemEvents,
  getFreeFunds,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { DescribeNode } from './types.js'

/// -------
/// Constants & Configuration
/// -------

/**
 * WHY THESE CONSTANTS?
 *
 * Multi-asset bounties use multipliers to ensure test values are:
 * 1. Realistic - proportional to actual chain configuration
 * 2. Maintainable - change once, affects all tests
 * 3. Safe - large enough to avoid existential deposit issues
 */

// Account funding: 100k x ED ensures accounts can pay fees + deposits
const TEST_ACCOUNT_BALANCE_MULTIPLIER = 100_000n

// Bounty amounts: Use substantial values to test realistic scenarios
const BOUNTY_MULTIPLIER = 1000n // Parent bounty: 1000x minimum
const CHILD_BOUNTY_MULTIPLIER = 100n // Child bounty: 100x minimum (10% of parent)

// Asset IDs for testing
const USDT_ASSET_ID = 1984 // USDT on Kusama Asset Hub

/** DOT as foreign asset on Asset Hub: MultiLocation pointing to Polkadot (parents: 2, X1(GlobalConsensus(Polkadot))). */
const DOT_FOREIGN_ASSET_LOCATION = {
  parents: 2,
  interior: {
    X1: [{ GlobalConsensus: 'Polkadot' }],
  },
} as const

/// Note: TREASURY_SETUP_OFFSET might be needed in future tests

/// -------
/// Helper Functions: Storage Queries
/// -------

/**
 * Get the current bounty count
 *
 * WHY THIS MATTERS:
 * The bounty index is derived from BountyCount, so we need this to:
 * - Predict the next bounty index before creation
 * - Verify that bounties are actually being created
 * - Track total bounties in the system
 */
async function getBountyCount(client: Client<any, any>): Promise<number> {
  const count = await client.api.query.multiAssetBounties.bountyCount()
  return (count as any).toNumber()
}

/**
 * Get a bounty by index
 *
 * WHY CHECK FOR .isSome?
 * Storage items in Substrate can be empty (None). Always check before unwrapping
 * to avoid runtime errors. This is a common pattern in Substrate APIs.
 */
async function getBounty(client: Client<any, any>, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.multiAssetBounties.bounties(bountyIndex)
  return (bounty as any).isSome ? (bounty as any).unwrap() : null
}

/**
 * Get a child bounty by parent and child index
 *
 * WHY DOUBLE MAP?
 * Child bounties are indexed by (parentId, childId) because:
 * - Multiple parents can each have their own child bounties
 * - Child IDs only need to be unique within a parent
 * - Enables efficient queries for all children of a parent
 */
async function getChildBounty(client: Client<any, any>, parentIndex: number, childIndex: number): Promise<any | null> {
  const childBounty = await client.api.query.multiAssetBounties.childBounties(parentIndex, childIndex)
  return (childBounty as any).isSome ? (childBounty as any).unwrap() : null
}

/**
 * Get curator deposit for a bounty or child bounty
 *
 * WHY CURATOR DEPOSITS?
 * Curators must lock native tokens as a deposit to:
 * - Ensure skin in the game (they'll lose deposit if they misbehave)
 * - Prevent spam curator proposals
 * - Incentivize proper bounty management
 *
 * The deposit is returned when the bounty completes successfully.
 */
async function getCuratorDeposit(
  client: Client<any, any>,
  parentIndex: number,
  childIndex?: number,
): Promise<any | null> {
  const deposit = await client.api.query.multiAssetBounties.curatorDeposit(parentIndex, childIndex ?? null)
  return (deposit as any).isSome ? (deposit as any).unwrap() : null
}

/// -------
/// Helper Functions: Test Setup
/// -------

/**
 * Setup test accounts with both native and asset balances
 *
 * WHY SETUP BOTH?
 * - Native balance: Needed for transaction fees and curator deposits
 * - Asset balance: Needed for USDT bounty funding and payouts
 *
 * WHY USE dev.setStorage?
 * In Chopsticks (our test framework), we can directly modify chain storage
 * to quickly setup test scenarios without waiting for transactions.
 */
async function setupTestAccounts(
  client: Client<any, any>,
  accounts: string[] = ['alice', 'bob'],
  includeUSDT: boolean = false,
) {
  const accountMap = {
    alice: testAccounts.alice.address,
    bob: testAccounts.bob.address,
    charlie: testAccounts.charlie.address,
  }

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const testAccountBalance = TEST_ACCOUNT_BALANCE_MULTIPLIER * existentialDeposit

  // Setup native balances
  const accountData = accounts
    .filter((account) => accountMap[account as keyof typeof accountMap])
    .map((account) => [
      [accountMap[account as keyof typeof accountMap]],
      { providers: 1, data: { free: testAccountBalance } },
    ])

  const storageUpdates: any = {
    System: {
      account: accountData,
    },
  }

  // Setup USDT balances if requested
  if (includeUSDT) {
    const assetAccountData = accounts
      .filter((account) => accountMap[account as keyof typeof accountMap])
      .map((account) => [
        [USDT_ASSET_ID, accountMap[account as keyof typeof accountMap]],
        { balance: testAccountBalance * 1000n }, // USDT typically has more decimals
      ])

    storageUpdates.Assets = {
      account: assetAccountData,
    }
  }

  await client.dev.setStorage(storageUpdates)
}

/**
 * Create an asset kind for native token
 *
 * WHY THIS STRUCTURE?
 * XCM uses MultiLocation to identify assets:
 * - V4: Current XCM version
 * - location: { parents: 0, interior: 'Here' } = "this chain's native token"
 */
function createNativeAssetKind(): any {
  return {
    V5: {
      location: {
        parents: 0,
        interior: 'Here',
      },
      assetId: {
        parents: 1,
        interior: 'Here',
      },
    },
  }
}

/**
 * Create an asset kind for USDT (asset ID 1984) using V5 AssetKind
 *
 * Matches the runtime's multi-asset bounties AssetKind:
 * - location: current chain (parents: 0, interior: Here)
 * - assetId: MultiLocation pointing to Assets pallet (50) + GeneralIndex 1984
 */
function createUSDTAssetKind(): any {
  return {
    V5: {
      location: {
        parents: 0,
        interior: 'Here',
      },
      assetId: {
        parents: 0,
        interior: {
          X2: [
            { PalletInstance: 50 }, // Assets pallet
            { GeneralIndex: USDT_ASSET_ID },
          ],
        },
      },
    },
  }
}

/**
 * AssetKind for DOT as foreign asset on Asset Hub (ForeignAssets pallet).
 * Location: current chain (Here). AssetId: MultiLocation for DOT on Polkadot (parents: 2, X1(GlobalConsensus(Polkadot))).
 */
function createDOTAssetKind(): any {
  return {
    V5: {
      location: {
        parents: 0,
        interior: 'Here',
      },
      assetId: {
        parents: DOT_FOREIGN_ASSET_LOCATION.parents,
        interior: DOT_FOREIGN_ASSET_LOCATION.interior,
      },
    },
  }
}

/**
 * Get treasury pot account ID (used as funding source for bounties).
 */
function getTreasuryPotAccount(client: Client<any, any>): string {
  return client.api.consts.treasury.potAccount.toString()
}

/**
 * Query asset rate for an asset kind (AssetRate pallet).
 * Returns the rate if set, otherwise undefined. Used to avoid FailedToConvertBalance.
 * Tries both common storage names (assetRate / conversionRateToNative); runtime encoding
 * of the key can differ from our JS object so the query may still miss a rate we just created.
 */
async function getAssetRate(client: Client<any, any>, assetKind: any): Promise<{ rate: any } | undefined> {
  const q = (client.api.query as any).assetRate
  if (!q) return undefined
  const storageName = q.assetRate ? 'assetRate' : q.conversionRateToNative ? 'conversionRateToNative' : null
  if (!storageName) return undefined
  const rate = await q[storageName](assetKind)
  if (!rate?.isSome) return undefined
  return { rate: rate.unwrap() }
}

/**
 * Query treasury's balance of a given asset (Assets pallet).
 * Returns 0n if no account or balance.
 */
async function getTreasuryAssetBalance(client: Client<any, any>, assetId: number): Promise<bigint> {
  const treasuryPot = getTreasuryPotAccount(client)
  const account = await client.api.query.assets.account(assetId, treasuryPot)
  if (!account?.isSome) return 0n
  return (account as any).unwrap().balance.toBigInt()
}

/**
 * Query an account's balance of a foreign asset (ForeignAssets pallet).
 * assetLocation: MultiLocation identifying the foreign asset (e.g. DOT on Polkadot).
 * Returns 0n if no account or balance.
 */
async function getForeignAssetBalance(
  client: Client<any, any>,
  assetLocation: { parents: number; interior: any },
  accountId: string,
): Promise<bigint> {
  const q = (client.api.query as any).foreignAssets
  if (!q?.account) return 0n
  const account = await q.account(assetLocation, accountId)
  if (!account?.isSome) return 0n
  return (account as any).unwrap().balance.toBigInt()
}

/**
 * Query treasury's balance of a foreign asset (ForeignAssets pallet).
 * assetLocation: MultiLocation identifying the foreign asset (e.g. DOT on Polkadot).
 * Returns 0n if no account or balance.
 */
async function getTreasuryForeignAssetBalance(
  client: Client<any, any>,
  assetLocation: { parents: number; interior: any },
): Promise<bigint> {
  const treasuryPot = getTreasuryPotAccount(client)
  return getForeignAssetBalance(client, assetLocation, treasuryPot)
}

/**
 * Create beneficiary from account
 *
 * Based on Westend Asset Hub runtime configuration:
 * type Beneficiary = VersionedLocatableAccount (from parachains_common)
 *
 * VersionedLocatableAccount::V5 { location, account_id }
 * - location: Location::here() (current chain)
 * - account_id: Location with AccountId32 junction
 *
 * Returns a plain object so the API encodes it when building the call;
 * passing api.createType() instances can cause encoding errors (e.g. toLowerCase on undefined).
 * Uses camelCase keys (x1, accountId32) to match polkadot.js encoding expectations.
 */
export function createBeneficiary(_api: ApiPromise, account: KeyringPair) {
  return {
    V5: {
      location: { parents: 0, interior: 'Here' },
      accountId: {
        parents: 0,
        interior: {
          x1: [{ accountId32: { network: null, id: account.addressRaw } }],
        },
      },
    },
  }
}

/**
 * Create a preimage for bounty metadata
 *
 * WHY PREIMAGES?
 * Instead of storing large metadata on-chain directly:
 * 1. Store metadata content in Preimage pallet
 * 2. Store only the hash in the bounty
 * 3. Saves storage space and reduces costs
 *
 * The metadata typically contains:
 * - Bounty description
 * - Requirements
 * - Deliverables
 * - Contact information
 */
async function createPreimage(client: Client<any, any>, content: string): Promise<string> {
  const notePreimageTx = client.api.tx.preimage.notePreimage(`0x${Buffer.from(content).toString('hex')}`)
  await sendTransaction(notePreimageTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // Get the hash from the event
  const events = await client.api.query.system.events()
  const preimageEvent = events.find(({ event }: any) => event.section === 'preimage' && event.method === 'Noted')

  if (!preimageEvent) {
    throw new Error('Preimage creation failed')
  }

  return preimageEvent.event.data[0].toString()
}

/// -------
/// Test Functions
/// -------

/**
 * Test 1: Fund a Multi-Asset Bounty with Native Token
 *
 * WHAT THIS TESTS:
 * - Creating a bounty directly via SpendOrigin (no proposal phase!)
 * - Async payment initiation (FundingAttempted state)
 * - Proper event emission
 * - Storage updates
 *
 * WHY THIS IS DIFFERENT FROM TRADITIONAL BOUNTIES:
 * - No proposeBounty → approveBounty flow
 * - Directly funded via Treasurer origin (same as bounties.ts)
 * - Payment happens asynchronously via Paymaster
 */
export async function fundNativeBountyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // Setup: Fund Alice's account
  await setupTestAccounts(client, ['alice', 'bob'])

  // log balance of alice and bob (use system.account; balances.freeBalance is deprecated)
  const aliceAccount = await client.api.query.system.account(testAccounts.alice.address)
  const bobAccount = await client.api.query.system.account(testAccounts.bob.address)
  console.log('Alice balance:', aliceAccount.data.free.toString())
  console.log('Bob balance:', bobAccount.data.free.toString())

  const initialBountyCount = await getBountyCount(client)

  // Calculate bounty value
  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER

  // Create metadata preimage
  const metadata = await createPreimage(client, 'Build a DEX frontend for Kusama Asset Hub')

  await logAllEvents(client)

  // Create asset kind for native token
  const assetKind = createNativeAssetKind()

  // Fund the bounty with Treasurer origin (same as bounties.ts)
  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    bountyValue,
    testAccounts.bob.address, // curator
    metadata,
  )

  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )

  await client.dev.newBlock()

  await logAllEvents(client)

  // Verify BountyCreated event
  await checkSystemEvents(client, { section: 'multiAssetBounties', method: 'BountyCreated' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('native bounty creation events')

  // Verify Paid event (funding payment initiated)
  await checkSystemEvents(client, { section: 'multiAssetBounties', method: 'Paid' }).toMatchSnapshot(
    'native bounty funding payment events',
  )

  // Verify bounty count increased
  const newBountyCount = await getBountyCount(client)
  expect(newBountyCount).toBe(initialBountyCount + 1)

  // Verify bounty storage
  const bountyIndex = initialBountyCount
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty).toBeTruthy()
  expect(bounty.value.toBigInt()).toBe(bountyValue)
  expect(bounty.status.isFundingAttempted).toBe(true)
}

/**
 * USDT bounty value in asset 1984's smallest units (6 decimals: 1 USDT = 1e6).
 * This is the amount of USDT we fund the bounty with; it is NOT the native minimum.
 */
const USDT_BOUNTY_VALUE = 1_000_000_000n // 1000 USDT (1000 * 1e6)

/** DOT uses same scale as native (bountyValueMinimum * BOUNTY_MULTIPLIER) so chain accepts it (avoids InvalidValue). */

/**
 * FixedU128 in Substrate uses 10^18 as the denominator (DIV).
 * Conversion: native = (asset * rate_inner) / 1e18.
 * We need (usdtAmount * rate) / 1e18 >= bountyValueMinimum => rate >= bountyValueMinimum * 1e18 / usdtAmount.
 */
const FIXED_U128_DENOM = 10n ** 18n

function getUSDTToNativeRate(bountyValueMinimum: bigint, usdtAmount: bigint): bigint {
  const minRate = (bountyValueMinimum * FIXED_U128_DENOM) / usdtAmount
  return minRate + FIXED_U128_DENOM / 10n ** 9n // add ~0.001 so we're safely above minimum
}

/** Multiplier for treasury USDT seed (seed = USDT_BOUNTY_VALUE * this) */
const TREASURY_USDT_SEED_MULTIPLIER = 100n

/**
 * Ensures the chain is ready for USDT bounties: asset rate set for USDT (so BalanceConverter works)
 * and treasury has enough USDT. Call before fundBounty with USDT asset kind.
 */
async function ensureUSDTBountySetup(client: Client<any, any>, testConfig: TestConfig): Promise<{ assetKind: any }> {
  const assetKind = createUSDTAssetKind()
  const treasuryPot = getTreasuryPotAccount(client)
  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const treasuryUsdtSeedAmount = USDT_BOUNTY_VALUE * TREASURY_USDT_SEED_MULTIPLIER

  const assetRateInfo = await getAssetRate(client, assetKind)
  let weCreatedRate = false
  if (!assetRateInfo) {
    const createRateTx = (client.api.tx as any).assetRate?.create
    if (createRateTx) {
      const rate = getUSDTToNativeRate(bountyValueMinimum, USDT_BOUNTY_VALUE)
      await scheduleInlineCallWithOrigin(
        client,
        createRateTx(assetKind, rate).method.toHex(),
        { system: 'Root' },
        testConfig.blockProvider,
      )
      await client.dev.newBlock()
      weCreatedRate = true
    }
  }
  expect(
    assetRateInfo || weCreatedRate,
    'Asset rate must be set for USDT so BalanceConverter can convert for origin check',
  ).toBeTruthy()

  await client.dev.setStorage({
    Assets: {
      account: [[[USDT_ASSET_ID, treasuryPot], { balance: treasuryUsdtSeedAmount }]],
    },
  })
  const treasuryUsdtAfterSeed = await getTreasuryAssetBalance(client, USDT_ASSET_ID)
  expect(
    treasuryUsdtAfterSeed >= USDT_BOUNTY_VALUE,
    `Treasury must have at least ${USDT_BOUNTY_VALUE} USDT, got ${treasuryUsdtAfterSeed}`,
  ).toBe(true)

  return { assetKind }
}

/** Multiplier for treasury DOT seed. */
const TREASURY_DOT_SEED_MULTIPLIER = 100n

/**
 * Possible reasons for multiAssetBounties.FundingError / InsufficientPermission:
 *
 * 1. InsufficientPermission: native_amount > max_amount (SpendOrigin limit).
 * 2. FundingError: Paymaster::pay failed (treasury has no/insufficient foreign asset, or asset not created).
 */
const DOT_BOUNTY_MULTIPLIER = 10n // Keep below Treasurer spend limit

/**
 * Ensures the chain is ready for DOT (foreign asset, Polkadot location) bounties:
 * - If no asset rate for this asset kind: sets rate so 1 DOT = 1 KSM (1:1 FixedU128).
 * - Ensures the foreign asset exists (ForeignAssets.create with Root if missing).
 * - Seeds treasury with the foreign DOT; tops up if below dotBountyValue.
 */
async function ensureDOTBountySetup(
  client: Client<any, any>,
  testConfig: TestConfig,
): Promise<{ assetKind: any; dotBountyValue: bigint }> {
  const assetKind = createDOTAssetKind()
  const treasuryPot = getTreasuryPotAccount(client)

  const palletConsts = (client.api.consts as any).multiAssetBounties
  if (!palletConsts) {
    console.error('[ensureDOTBountySetup] api.consts.multiAssetBounties is UNDEFINED')
    console.error('Available consts pallets:', Object.keys(client.api.consts as any))
    const palletTx = (client.api.tx as any).multiAssetBounties
    console.error('api.tx.multiAssetBounties exists?', !!palletTx)
    if (palletTx) console.error('tx methods:', Object.keys(palletTx))
    const palletQuery = (client.api.query as any).multiAssetBounties
    console.error('api.query.multiAssetBounties exists?', !!palletQuery)
    if (palletQuery) console.error('query methods:', Object.keys(palletQuery))
    throw new Error('multiAssetBounties pallet constants not found in runtime metadata. Check pallet name.')
  }

  const bountyValueMinimum = (palletConsts.bountyValueMinimum as any).toBigInt()
  const assetLocation = DOT_FOREIGN_ASSET_LOCATION

  // 1. Asset rate for this asset kind (BalanceConverter)
  const assetRateInfo = await getAssetRate(client, assetKind)
  let weCreatedRate = false
  if (!assetRateInfo) {
    const createRateTx = (client.api.tx as any).assetRate?.create
    if (createRateTx) {
      const rateOneToOne = FIXED_U128_DENOM
      await scheduleInlineCallWithOrigin(
        client,
        createRateTx(assetKind, rateOneToOne).method.toHex(),
        { system: 'Root' },
        testConfig.blockProvider,
      )
      await client.dev.newBlock()
      weCreatedRate = true
    }
  }
  expect(
    assetRateInfo || weCreatedRate,
    'Asset rate must be set for DOT (foreign) so BalanceConverter can convert for origin check',
  ).toBeTruthy()

  const dotBountyValue = bountyValueMinimum * DOT_BOUNTY_MULTIPLIER
  const treasuryDotSeedAmount = dotBountyValue * TREASURY_DOT_SEED_MULTIPLIER

  // 2. Ensure foreign asset exists (ForeignAssets pallet)
  const faQuery = (client.api.query as any).foreignAssets
  const existingForeign = faQuery?.asset ? await faQuery.asset(assetLocation) : null
  if (!existingForeign?.isSome) {
    const createTx = (client.api.tx as any).foreignAssets?.create
    if (createTx) {
      // create(assetId, admin, minBalance, isFrozen) – admin treasury so it can hold balance
      const minBalance = 1n
      await scheduleInlineCallWithOrigin(
        client,
        createTx(assetLocation, treasuryPot, minBalance, false).method.toHex(),
        { system: 'Root' },
        testConfig.blockProvider,
      )
      await client.dev.newBlock()
      console.log('[DOT setup] Created foreign asset (DOT on Polkadot) via ForeignAssets.create')
    }
  }

  // 3. Seed treasury with foreign DOT
  console.log('[DOT setup] Treasury pot:', treasuryPot)
  console.log('[DOT setup] Asset kind (foreign DOT):', JSON.stringify(assetKind, null, 2))
  console.log(
    '[DOT setup] Setting ForeignAssets::account key (assetLocation, accountId), balance:',
    treasuryDotSeedAmount.toString(),
  )

  await client.dev.setStorage({
    ForeignAssets: {
      account: [[[assetLocation, treasuryPot], { balance: treasuryDotSeedAmount }]],
    },
  })
  let treasuryDotAfterSeed = await getTreasuryForeignAssetBalance(client, assetLocation)
  const rawAccountAfterSet = faQuery?.account ? await faQuery.account(assetLocation, treasuryPot) : null
  console.log('[DOT setup] After setStorage - getTreasuryForeignAssetBalance:', treasuryDotAfterSeed.toString())
  console.log('[DOT setup] After setStorage - raw foreignAssets.account isSome:', (rawAccountAfterSet as any)?.isSome)

  if (treasuryDotAfterSeed < dotBountyValue) {
    await client.dev.setStorage({
      ForeignAssets: {
        account: [[[assetLocation, treasuryPot], { balance: dotBountyValue * 2n }]],
      },
    })
    treasuryDotAfterSeed = await getTreasuryForeignAssetBalance(client, assetLocation)
  }
  expect(
    treasuryDotAfterSeed >= dotBountyValue,
    `Treasury must have at least ${dotBountyValue} foreign DOT for bounties, got ${treasuryDotAfterSeed}`,
  ).toBe(true)

  console.log('[DOT setup] treasury foreign DOT balance after seeding:', treasuryDotAfterSeed.toString())
  console.log('[DOT setup] bounty value for DOT:', dotBountyValue.toString())
  console.log(
    '[DOT setup] asset rate for DOT:',
    assetRateInfo?.rate?.toString() ?? 'undefined (we may have created it)',
  )
  console.log('[DOT setup] bounty value minimum:', bountyValueMinimum.toString())
  console.log('[DOT setup] Calling newBlock() to commit state before lifecycle test schedules fund_bounty...')
  await client.dev.newBlock()

  const treasuryAfterCommit = await getTreasuryForeignAssetBalance(client, assetLocation)
  console.log('[DOT setup] After newBlock() - treasury foreign DOT balance:', treasuryAfterCommit.toString())

  return { assetKind, dotBountyValue }
}

/**
 * Test: Fund a Multi-Asset Bounty with USDT (asset 1984)
 *
 * WHAT THIS TESTS:
 * - Funding a bounty with a non-native asset (USDT, asset ID 1984)
 * - AssetKind V5 with location (current chain) + assetId (PalletInstance 50, GeneralIndex 1984)
 * - Treasurer origin via Scheduler (same as native)
 * - Async payment initiation and BountyCreated / Paid events
 */
export async function fundUSDTBountyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  await setupTestAccounts(client, ['alice', 'bob'], true)

  const initialBountyCount = await getBountyCount(client)

  const metadata = await createPreimage(client, 'Build a USDT-funded integration for Kusama Asset Hub')

  const { assetKind } = await ensureUSDTBountySetup(client, testConfig)

  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    USDT_BOUNTY_VALUE,
    testAccounts.bob.address,
    metadata,
  )

  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  logAllEvents(client)

  await checkSystemEvents(client, { section: 'multiAssetBounties', method: 'BountyCreated' })
    .redact({ redactKeys: /index/ })
    .toMatchSnapshot('USDT bounty creation events')

  await checkSystemEvents(client, { section: 'multiAssetBounties', method: 'Paid' }).toMatchSnapshot(
    'USDT bounty funding payment events',
  )

  const newBountyCount = await getBountyCount(client)
  expect(newBountyCount).toBe(initialBountyCount + 1)

  const bountyIndex = initialBountyCount
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty).toBeTruthy()
  expect(bounty.value.toBigInt()).toBe(USDT_BOUNTY_VALUE)
  expect(bounty.status.isFundingAttempted).toBe(true)
}

/**
 * Test 2: Check Funding Status and Transition to Funded
 *
 * WHAT THIS TESTS:
 * - Checking payment status via checkStatus extrinsic
 * - Transition from FundingAttempted → Funded
 * - Proper event emission on successful funding
 *
 * WHY THIS STEP EXISTS:
 * Multi-asset bounties use async payments. After initiating payment:
 * 1. Payment goes to "Attempted" state with a payment ID
 * 2. Anyone calls checkStatus to query the Paymaster
 * 3. If successful, bounty becomes "Funded" and ready for curator
 */
export async function checkFundingStatusTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob'])

  // First, create a bounty
  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const metadata = await createPreimage(client, 'Test bounty for funding status check')
  const assetKind = createNativeAssetKind()

  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    bountyValue,
    testAccounts.bob.address,
    metadata,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  const bountyIndex = (await getBountyCount(client)) - 1

  // Now check the funding status
  const checkStatusTx = client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null)
  const statusEvents = await sendTransaction(checkStatusTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // Verify BountyFundingProcessed event
  await checkEvents(statusEvents, { section: 'multiAssetBounties', method: 'BountyFundingProcessed' }).toMatchSnapshot(
    'bounty funding processed events',
  )

  // Verify bounty is now in Funded state
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isFunded).toBe(true)
}

/**
 * Test 3: Curator Accepts Role
 *
 * WHAT THIS TESTS:
 * - Curator accepting their role via acceptCurator extrinsic
 * - Curator deposit being locked (in native token)
 * - Transition from Funded → Active state
 *
 * WHY CURATOR DEPOSITS MATTER:
 * - Ensures curators have "skin in the game"
 * - Deposit is calculated as % of bounty value
 * - Returned when bounty completes successfully
 * - Slashed if curator misbehaves
 */
export async function acceptCuratorTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob'])

  // Setup: Create and fund a bounty
  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const metadata = await createPreimage(client, 'Test bounty for curator acceptance')
  const assetKind = createNativeAssetKind()

  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    bountyValue,
    testAccounts.bob.address,
    metadata,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  const bountyIndex = (await getBountyCount(client)) - 1

  // Check funding status to move to Funded state
  const checkStatusTx = client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null)
  await sendTransaction(checkStatusTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // Curator (Bob) accepts the role
  const acceptCuratorTx = client.api.tx.multiAssetBounties.acceptCurator(bountyIndex, null)
  const acceptEvents = await sendTransaction(acceptCuratorTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // Verify BountyBecameActive event
  await checkEvents(acceptEvents, { section: 'multiAssetBounties', method: 'BountyBecameActive' }).toMatchSnapshot(
    'curator acceptance events',
  )

  // Verify bounty is now Active
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isActive).toBe(true)

  // Verify curator deposit was created
  const curatorDeposit = await getCuratorDeposit(client, bountyIndex)
  expect(curatorDeposit).toBeTruthy()
}

/**
 * Test 4: Award Bounty to Beneficiary
 *
 * WHAT THIS TESTS:
 * - Curator awarding bounty to a beneficiary
 * - Payout payment initiation
 * - Transition to PayoutAttempted state
 *
 * WHY TWO PAYMENT PHASES?
 * 1. Funding payment: Treasury → Bounty account
 * 2. Payout payment: Bounty account → Beneficiary
 *
 * This separation allows bounties to hold funds and create child bounties.
 */
export async function awardBountyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  // Setup: Create funded, active bounty
  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const metadata = await createPreimage(client, 'Test bounty for awarding')
  const assetKind = createNativeAssetKind()

  // Create and fund bounty
  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    bountyValue,
    testAccounts.bob.address,
    metadata,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  const bountyIndex = (await getBountyCount(client)) - 1

  // Check funding and accept curator
  await sendTransaction(client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await sendTransaction(client.api.tx.multiAssetBounties.acceptCurator(bountyIndex, null).signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // Award bounty to Charlie
  const beneficiary = createBeneficiary(client.api, testAccounts.charlie)
  const awardBountyTx = client.api.tx.multiAssetBounties.awardBounty(
    bountyIndex,
    null, // no child bounty
    beneficiary,
  )
  const awardEvents = await sendTransaction(awardBountyTx.signAsync(testAccounts.bob))
  await client.dev.newBlock()

  // Verify BountyAwarded event
  await checkEvents(awardEvents, { section: 'multiAssetBounties', method: 'BountyAwarded' }).toMatchSnapshot(
    'bounty awarded events',
  )

  // Verify Paid event (payout initiated)
  await checkEvents(awardEvents, { section: 'multiAssetBounties', method: 'Paid' }).toMatchSnapshot(
    'bounty payout payment events',
  )

  // Verify bounty is in PayoutAttempted state
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty.status.isPayoutAttempted).toBe(true)
}

/**
 * Test 5: Complete Bounty Lifecycle
 *
 * WHAT THIS TESTS:
 * - Full lifecycle from creation to completion
 * - Final payout status check
 * - Bounty removal from storage
 * - Curator deposit return
 *
 * WHY THIS TEST?
 * Ensures all pieces work together:
 * Fund → Check → Accept → Award → Check → Complete
 */
export async function completeBountyLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'])

  const bountyValueMinimum = (client.api.consts.multiAssetBounties.bountyValueMinimum as any).toBigInt()
  const bountyValue = bountyValueMinimum * BOUNTY_MULTIPLIER
  const metadata = await createPreimage(client, 'Complete lifecycle test bounty')
  const assetKind = createNativeAssetKind()

  // log the bounty params
  console.log('bounty value minimum:', bountyValueMinimum.toString())
  console.log('bounty value:', bountyValue.toString())
  console.log('metadata:', metadata.toString())
  console.log('asset kind:', JSON.stringify(assetKind, null, 2))

  // Step 1: Fund bounty
  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    bountyValue,
    testAccounts.bob.address,
    metadata,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  // log all events
  await logAllEvents(client)

  const bountyIndex = (await getBountyCount(client)) - 1

  // log bounty to human readable format
  const bountyAfterFund = await getBounty(client, bountyIndex)
  console.log('bounty after fund:', JSON.stringify(bountyAfterFund, null, 2))

  // Step 2: Check funding status
  await sendTransaction(client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await logAllEvents(client)

  // log bounty to human readable format after checkStatus
  const bountyAfterCheckStatus = await getBounty(client, bountyIndex)
  console.log('bounty after checkStatus:', JSON.stringify(bountyAfterCheckStatus, null, 2))

  // Step 3: Accept curator
  await sendTransaction(client.api.tx.multiAssetBounties.acceptCurator(bountyIndex, null).signAsync(testAccounts.bob))
  await client.dev.newBlock()

  await logAllEvents(client)

  // log bounty to human readable format after acceptCurator
  const bountyAfterAcceptCurator = await getBounty(client, bountyIndex)
  console.log('bounty after acceptCurator:', JSON.stringify(bountyAfterAcceptCurator, null, 2))

  // get charlies native balance before awardBounty
  const charlieNativeBalanceBeforeAwardBounty = await getFreeFunds(client, testAccounts.charlie.address)
  console.log('charlie native balance before awardBounty:', charlieNativeBalanceBeforeAwardBounty.toString())

  // Step 4: Award bounty
  const beneficiary = createBeneficiary(client.api, testAccounts.charlie)
  await sendTransaction(
    client.api.tx.multiAssetBounties.awardBounty(bountyIndex, null, beneficiary).signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()

  await logAllEvents(client)

  // log bounty to human readable format after awardBounty
  const bountyAfterAwardBounty = await getBounty(client, bountyIndex)
  console.log('bounty after awardBounty:', JSON.stringify(bountyAfterAwardBounty, null, 2))

  // get charlies native balance after awardBounty
  const charlieNativeBalanceAfterAwardBounty = await getFreeFunds(client, testAccounts.charlie.address)
  console.log('charlie native balance after awardBounty:', charlieNativeBalanceAfterAwardBounty.toString())

  // Step 5: Check payout status (completes the bounty)
  const finalCheckTx = client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null)
  const finalEvents = await sendTransaction(finalCheckTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  await logAllEvents(client)

  // log bounty to human readable format after final checkStatus
  const bountyAfterFinalCheckStatus = await getBounty(client, bountyIndex)
  console.log('bounty after final checkStatus:', JSON.stringify(bountyAfterFinalCheckStatus, null, 2))

  // Verify BountyPayoutProcessed event
  await checkEvents(finalEvents, { section: 'multiAssetBounties', method: 'BountyPayoutProcessed' }).toMatchSnapshot(
    'bounty completed events',
  )

  // verify charlies native balance after payout increased
  expect(charlieNativeBalanceAfterAwardBounty).toBeGreaterThan(charlieNativeBalanceBeforeAwardBounty)

  // Verify bounty is removed from storage
  const bounty = await getBounty(client, bountyIndex)
  expect(bounty).toBeNull()

  // get curator deposit
  const curatorDeposit = await getCuratorDeposit(client, bountyIndex)
  console.log('curator deposit:', JSON.stringify(curatorDeposit, null, 2))

  // verify curator deposit is removed (returned to curator)
  expect(curatorDeposit).toBeNull()
}

/**
 * Test: Complete USDT Bounty Lifecycle
 *
 * WHAT THIS TESTS:
 * - Full lifecycle with USDT (asset 1984): Fund → Check funding → Accept curator → Award → Check payout
 * - Asset rate and treasury USDT setup (same as fundUSDTBountyTest)
 * - Bounty removal and curator deposit return after completion
 */
export async function completeUSDTBountyLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'], true)

  const metadata = await createPreimage(client, 'Complete USDT bounty lifecycle')
  const { assetKind } = await ensureUSDTBountySetup(client, testConfig)

  // Step 1: Fund bounty with USDT
  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    USDT_BOUNTY_VALUE,
    testAccounts.bob.address,
    metadata,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  await client.dev.newBlock()

  logAllEvents(client)

  // get bounty index
  const bountyIndex = (await getBountyCount(client)) - 1

  // log bounty in human readable format
  const bountyAfterFund = await getBounty(client, bountyIndex)
  console.log('bounty after fund_bounty(tx):', JSON.stringify(bountyAfterFund, null, 2))

  // Step 2: Check funding status
  await sendTransaction(client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after checkStatus
  const bountyAfterCheckStatus = await getBounty(client, bountyIndex)
  console.log('bounty after checkStatus:', JSON.stringify(bountyAfterCheckStatus, null, 2))

  // Step 3: Accept curator
  await sendTransaction(client.api.tx.multiAssetBounties.acceptCurator(bountyIndex, null).signAsync(testAccounts.bob))
  await client.dev.newBlock()

  logAllEvents(client)

  // check if treasury has enough USDT for the bounty
  const treasuryUsdtBalance = await getTreasuryAssetBalance(client, USDT_ASSET_ID)
  console.log('treasury USDT balance:', treasuryUsdtBalance.toString())
  console.log('USDT bounty value:', USDT_BOUNTY_VALUE.toString())
  if (treasuryUsdtBalance < USDT_BOUNTY_VALUE) {
    console.log('treasury USDT balance is less than USDT bounty value, adding more USDT to treasury')
    const treasuryPot = getTreasuryPotAccount(client)
    console.log('treasury pot address:', treasuryPot)
    await client.dev.setStorage({
      Assets: {
        account: [[[USDT_ASSET_ID, treasuryPot], { balance: USDT_BOUNTY_VALUE * 2n }]],
      },
    })
  }
  expect(treasuryUsdtBalance).toBeGreaterThan(USDT_BOUNTY_VALUE)

  // add some USDT to the benefia
  // await client.dev.setStorage({
  //   Assets: {
  //     account: [[[USDT_ASSET_ID, testAccounts.charlie.address], { balance: USDT_BOUNTY_VALUE }]],
  //   },
  // })

  // log charlie's USDT balance
  // const charlieUsdtBalance = await getFreeFunds(client, testAccounts.charlie.address)
  // get charlie's USDT balance in asset 1984 using assets pallet
  const charlieUsdtBalanceInAsset1984 = await client.api.query.assets.account(
    USDT_ASSET_ID,
    testAccounts.charlie.address,
  )
  // console.log('charlie USDT balance:', charlieUsdtBalance.toString())
  console.log('charlie USDT balance in asset 1984:', charlieUsdtBalanceInAsset1984.toString())
  // log charlies native balance
  const charlieNativeBalance = await getFreeFunds(client, testAccounts.charlie.address)
  console.log('charlie native balance:', charlieNativeBalance.toString())
  // log charlies address
  console.log('charlie address:', testAccounts.charlie.address)

  // log bounty in human readable format after acceptCurator
  const bountyAfterAcceptCurator = await getBounty(client, bountyIndex)
  console.log('bounty after acceptCurator:', JSON.stringify(bountyAfterAcceptCurator, null, 2))

  // Step 4: Award bounty to charlie
  const beneficiary = createBeneficiary(client.api, testAccounts.charlie)
  await sendTransaction(
    client.api.tx.multiAssetBounties.awardBounty(bountyIndex, null, beneficiary).signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after awardBounty
  const bountyAfterAwardBounty = await getBounty(client, bountyIndex)
  console.log('bounty after awardBounty:', JSON.stringify(bountyAfterAwardBounty, null, 2))

  // Step 5: Check payout status (completes the bounty)
  const finalCheckTx = client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null)
  const finalEvents = await sendTransaction(finalCheckTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after checkStatus
  const bountyAfterFinalCheckStatus = await getBounty(client, bountyIndex)
  console.log('bounty after final checkStatus:', JSON.stringify(bountyAfterFinalCheckStatus, null, 2))

  await checkEvents(finalEvents, { section: 'multiAssetBounties', method: 'BountyPayoutProcessed' }).toMatchSnapshot(
    'USDT bounty completed events',
  )

  await client.dev.newBlock()
  await client.dev.newBlock()

  // log charlies USDT balance after final checkStatus using the assets pallet
  const charlieAfterFinalCheckStatus = await client.api.query.assets.account(
    USDT_ASSET_ID,
    testAccounts.charlie.address,
  )
  console.log('charlie USDT balance after final checkStatus in asset 1984:', charlieAfterFinalCheckStatus.toString())

  const bounty = await getBounty(client, bountyIndex)
  // log in human readable format
  console.log('bounty:', JSON.stringify(bounty, null, 2))
  //   expect(bounty).toBeNull()

  const curatorDeposit = await getCuratorDeposit(client, bountyIndex)
  // log in human readable format
  console.log('curatorDeposit:', JSON.stringify(curatorDeposit, null, 2))
  //   expect(curatorDeposit).toBeNull()
}

/**
 * Test: Complete DOT (asset 14) Bounty Lifecycle
 *
 * Full lifecycle with DOT on Kusama Asset Hub: Fund → Check funding → Accept curator → Award → Check payout.
 */
export async function completeDOTBountyLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  await setupTestAccounts(client, ['alice', 'bob', 'charlie'], true)

  const metadata = await createPreimage(client, 'Complete DOT bounty lifecycle')
  const { assetKind, dotBountyValue } = await ensureDOTBountySetup(client, testConfig)

  const initialBountyCount = await getBountyCount(client)
  const headerBefore = await client.api.rpc.chain.getHeader()
  console.log(
    '[DOT lifecycle] Initial bounty count:',
    initialBountyCount,
    '| current block number:',
    headerBefore.number.toString(),
  )

  const assetLocation = DOT_FOREIGN_ASSET_LOCATION
  const treasuryPot = getTreasuryPotAccount(client)
  const seedAmount = dotBountyValue * TREASURY_DOT_SEED_MULTIPLIER
  console.log(
    '[DOT lifecycle] Re-applying treasury foreign DOT: pot=',
    treasuryPot,
    '| assetLocation=',
    JSON.stringify(assetLocation),
    '| seedAmount=',
    seedAmount.toString(),
  )

  await client.dev.setStorage({
    ForeignAssets: {
      account: [[[assetLocation, treasuryPot], { balance: seedAmount }]],
    },
  })
  const treasuryDotBeforeSchedule = await getTreasuryForeignAssetBalance(client, assetLocation)
  const faQuery = (client.api.query as any).foreignAssets
  const rawBeforeSchedule = faQuery?.account ? await faQuery.account(assetLocation, treasuryPot) : null
  expect(
    treasuryDotBeforeSchedule >= dotBountyValue,
    `Treasury must have >= ${dotBountyValue} DOT before scheduling fund_bounty, got ${treasuryDotBeforeSchedule}`,
  ).toBe(true)
  console.log(
    '[DOT lifecycle] Before schedule - treasury DOT balance:',
    treasuryDotBeforeSchedule.toString(),
    '| bounty value:',
    dotBountyValue.toString(),
  )
  console.log(
    '[DOT lifecycle] Before schedule - raw foreignAssets.account(assetLocation, treasuryPot) isSome:',
    (rawBeforeSchedule as any)?.isSome,
    '| value:',
    rawBeforeSchedule?.toString(),
  )

  const fundBountyTx = client.api.tx.multiAssetBounties.fundBounty(
    assetKind,
    dotBountyValue,
    testAccounts.bob.address,
    metadata,
  )
  console.log('[DOT lifecycle] fundBountyTx (hex):', fundBountyTx.method.toHex())
  console.log('[DOT lifecycle] Asset kind passed to fund_bounty:', JSON.stringify(assetKind))

  const scheduledBlock = (await client.api.rpc.chain.getHeader()).number.toNumber() + 1
  console.log(
    '[DOT lifecycle] Scheduling fund_bounty for block',
    scheduledBlock,
    '| blockProvider:',
    testConfig.blockProvider,
  )
  await scheduleInlineCallWithOrigin(
    client,
    fundBountyTx.method.toHex(),
    { Origins: 'Treasurer' },
    testConfig.blockProvider,
  )
  console.log('[DOT lifecycle] Calling newBlock() - scheduler will run fund_bounty in this block...')
  await client.dev.newBlock()

  const headerAfter = await client.api.rpc.chain.getHeader()
  console.log(
    '[DOT lifecycle] After newBlock() - block number:',
    headerAfter.number.toString(),
    '(expected scheduler to run at',
    scheduledBlock + ')',
  )
  const treasuryDotAfterBlock = await getTreasuryForeignAssetBalance(client, assetLocation)
  const rawAfterBlock = faQuery?.account ? await faQuery.account(assetLocation, treasuryPot) : null
  console.log(
    '[DOT lifecycle] After newBlock() - treasury foreign DOT balance:',
    treasuryDotAfterBlock.toString(),
    '| (if FundingError: Paymaster did not debit; if lower than before: payment may have been attempted)',
  )
  console.log('[DOT lifecycle] After newBlock() - raw foreignAssets.account isSome:', (rawAfterBlock as any)?.isSome)

  await logAllEvents(client)

  const newBountyCount = await getBountyCount(client)
  console.log(
    '[DOT lifecycle] Bounty count after fund_bounty block:',
    newBountyCount,
    '(expected',
    initialBountyCount + 1,
    ')',
  )

  if (newBountyCount === initialBountyCount) {
    const rateAtFailure = await getAssetRate(client, assetKind)
    console.log('[DOT lifecycle] *** FundingError diagnosis (fund_bounty did not create a bounty) ***')
    console.log('[DOT lifecycle] Treasury pot account we seeded:', treasuryPot)
    console.log(
      '[DOT lifecycle] Treasury DOT before block:',
      treasuryDotBeforeSchedule.toString(),
      '| after block:',
      treasuryDotAfterBlock.toString(),
      '| (unchanged => Paymaster::pay likely failed before debit)',
    )
    console.log('[DOT lifecycle] Asset rate for DOT at failure:', rateAtFailure?.rate?.toString() ?? 'undefined')
    console.log('[DOT lifecycle] Possible reasons:')
    console.log(
      '[DOT lifecycle] 1. FundingSource in runtime may resolve to a different account than treasury.potAccount for this chain (check PalletIdAsFundingSource vs Treasury::potAccount).',
    )
    console.log('[DOT lifecycle] 2. Paymaster::pay for foreign DOT may use different storage or fail on Asset Hub.')
    console.log(
      '[DOT lifecycle] 3. Chopsticks: setStorage may not be visible in the same block when the scheduler runs (block built from snapshot state).',
    )
    console.log(
      '[DOT lifecycle] 4. BalanceConverter requires an asset rate; missing/wrong rate can cause different errors.',
    )
    console.log(
      '[DOT lifecycle] 5. Check runtime: MultiAssetBounties FundingSource and Paymaster implementation for asset kind',
      JSON.stringify(assetKind),
    )
  }

  expect(newBountyCount, 'fund_bounty must succeed (bounty value >= minimum)').toBe(initialBountyCount + 1)
  const bountyIndex = initialBountyCount

  // log bounty in human readable format after fundBounty
  const bountyAfterFundBounty = await getBounty(client, bountyIndex)
  console.log('bounty after fundBounty:', JSON.stringify(bountyAfterFundBounty, null, 2))

  await sendTransaction(client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null).signAsync(testAccounts.alice))
  await client.dev.newBlock()

  logAllEvents(client)

  await sendTransaction(client.api.tx.multiAssetBounties.acceptCurator(bountyIndex, null).signAsync(testAccounts.bob))
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after acceptCurator
  const bountyAfterAcceptCurator = await getBounty(client, bountyIndex)
  console.log('bounty after acceptCurator:', JSON.stringify(bountyAfterAcceptCurator, null, 2))

  let treasuryDotBalance = await getTreasuryForeignAssetBalance(client, assetLocation)
  if (treasuryDotBalance < dotBountyValue) {
    const treasuryPot = getTreasuryPotAccount(client)
    await client.dev.setStorage({
      ForeignAssets: {
        account: [[[assetLocation, treasuryPot], { balance: dotBountyValue * 2n }]],
      },
    })
    treasuryDotBalance = await getTreasuryForeignAssetBalance(client, assetLocation)
  }
  expect(treasuryDotBalance).toBeGreaterThanOrEqual(dotBountyValue)

  const beneficiaryBalanceBeforeAward = await getForeignAssetBalance(
    client,
    assetLocation,
    testAccounts.charlie.address,
  )
  console.log(
    '[DOT lifecycle] Beneficiary (Charlie) foreign DOT balance before award:',
    beneficiaryBalanceBeforeAward.toString(),
  )

  const beneficiary = createBeneficiary(client.api, testAccounts.charlie)
  await sendTransaction(
    client.api.tx.multiAssetBounties.awardBounty(bountyIndex, null, beneficiary).signAsync(testAccounts.bob),
  )
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after awardBounty
  const bountyAfterAwardBounty = await getBounty(client, bountyIndex)
  console.log('bounty after awardBounty:', JSON.stringify(bountyAfterAwardBounty, null, 2))

  const finalCheckTx = client.api.tx.multiAssetBounties.checkStatus(bountyIndex, null)
  const finalEvents = await sendTransaction(finalCheckTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  logAllEvents(client)

  // log bounty in human readable format after final checkStatus
  const bountyAfterFinalCheckStatus = await getBounty(client, bountyIndex)
  console.log('bounty after final checkStatus:', JSON.stringify(bountyAfterFinalCheckStatus, null, 2))

  await checkEvents(finalEvents, { section: 'multiAssetBounties', method: 'BountyPayoutProcessed' }).toMatchSnapshot(
    'DOT bounty completed events',
  )

  const beneficiaryBalanceAfterPayout = await getForeignAssetBalance(
    client,
    assetLocation,
    testAccounts.charlie.address,
  )
  console.log(
    '[DOT lifecycle] Beneficiary (Charlie) foreign DOT balance after payout:',
    beneficiaryBalanceAfterPayout.toString(),
  )
  console.log(
    '[DOT lifecycle] Bounty value paid:',
    dotBountyValue.toString(),
    '| balance before award:',
    beneficiaryBalanceBeforeAward.toString(),
  )
  expect(
    beneficiaryBalanceAfterPayout,
    `Beneficiary must have received the bounty: balance before ${beneficiaryBalanceBeforeAward}, after ${beneficiaryBalanceAfterPayout}, bounty value ${dotBountyValue}`,
  ).toBeGreaterThanOrEqual(beneficiaryBalanceBeforeAward + dotBountyValue)

  const bounty = await getBounty(client, bountyIndex)
  const curatorDeposit = await getCuratorDeposit(client, bountyIndex)
  expect(bounty).toBeNull()
  expect(curatorDeposit).toBeNull()
}

/// -------
/// Base Test Tree Builder
/// -------

/**
 * Creates the complete test tree for Multi-Asset Bounties
 *
 * WHY THIS STRUCTURE?
 * Following the same pattern as bounties.ts:
 * - Groups tests by asset type (Native, USDT)
 * - Each group tests the full lifecycle
 * - Enables easy addition of new asset types
 */
async function logPalletInfo(chain: Chain<any, any>, _testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const api = client.api as ApiPromise

  const header = await api.rpc.chain.getHeader()
  const blockNumber = header.number.toNumber()
  const blockHash = header.hash.toHex()
  console.log(`\n====== Chain info ======`)
  console.log(`  Block number: ${blockNumber}`)
  console.log(`  Block hash:   ${blockHash}`)
  console.log(`  Chain:        ${(await api.rpc.system.chain()).toString()}`)
  console.log(
    `  Runtime version: ${api.runtimeVersion.specName.toString()} v${api.runtimeVersion.specVersion.toNumber()}`,
  )
  console.log(`====== end chain info ======\n`)

  console.log('\n====== multiAssetBounties pallet introspection ======\n')

  // Constants
  const palletConsts = (api.consts as any).multiAssetBounties
  if (palletConsts) {
    console.log('--- Constants ---')
    for (const key of Object.keys(palletConsts)) {
      try {
        const val = palletConsts[key]
        console.log(`  ${key}:`, val?.toString?.() ?? val)
      } catch (e: any) {
        console.log(`  ${key}: <error reading: ${e.message}>`)
      }
    }
  } else {
    console.log('WARNING: api.consts.multiAssetBounties is UNDEFINED')
    console.log('Available pallet constants:', Object.keys(api.consts as any))
  }

  // Extrinsics (tx)
  const palletTx = (api.tx as any).multiAssetBounties
  if (palletTx) {
    console.log('\n--- Extrinsics (tx) ---')
    for (const key of Object.keys(palletTx)) {
      if (typeof palletTx[key] === 'function') {
        console.log(`  ${key}()`)
      }
    }
  } else {
    console.log('WARNING: api.tx.multiAssetBounties is UNDEFINED')
    console.log('Available pallet tx:', Object.keys(api.tx as any))
  }

  // Storage
  const palletQuery = (api.query as any).multiAssetBounties
  if (palletQuery) {
    console.log('\n--- Storage queries ---')
    for (const key of Object.keys(palletQuery)) {
      if (typeof palletQuery[key] === 'function') {
        console.log(`  ${key}`)
      }
    }
  } else {
    console.log('WARNING: api.query.multiAssetBounties is UNDEFINED')
    console.log('Available pallet queries:', Object.keys(api.query as any))
  }

  console.log('\n====== end pallet introspection ======\n')
}

export function baseMultiAssetBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): DescribeNode {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'Log multiAssetBounties pallet constants, extrinsics, and storage',
        testFn: () => logPalletInfo(chain, testConfig),
      },
      {
        kind: 'describe',
        label: 'Native Token Bounties',
        children: [
          {
            kind: 'test',
            label: 'Should fund a bounty with native token',
            testFn: () => fundNativeBountyTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Should check funding status and transition to Funded',
            testFn: () => checkFundingStatusTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Should allow curator to accept role',
            testFn: () => acceptCuratorTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Should award bounty to beneficiary',
            testFn: () => awardBountyTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Should complete full bounty lifecycle',
            testFn: () => completeBountyLifecycleTest(chain, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'USDT Bounties',
        children: [
          {
            kind: 'test',
            label: 'Should fund a bounty with USDT',
            testFn: () => fundUSDTBountyTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'Should complete full USDT bounty lifecycle',
            testFn: () => completeUSDTBountyLifecycleTest(chain, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'DOT Bounties',
        children: [
          {
            kind: 'test',
            label: 'Should complete full DOT bounty lifecycle',
            testFn: () => completeDOTBountyLifecycleTest(chain, testConfig),
          },
        ],
      },
    ],
  }
}

export {
  // Helper functions
  getBountyCount,
  getBounty,
  getChildBounty,
  getCuratorDeposit,
  setupTestAccounts,
  createNativeAssetKind,
  createUSDTAssetKind,
  createDOTAssetKind,
  createPreimage,
  // Constants
  TEST_ACCOUNT_BALANCE_MULTIPLIER,
  BOUNTY_MULTIPLIER,
  CHILD_BOUNTY_MULTIPLIER,
  USDT_ASSET_ID,
  DOT_FOREIGN_ASSET_LOCATION,
}
