import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import { stringToU8a, u8aConcat } from '@polkadot/util'
import { blake2AsHex, blake2AsU8a, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkSystemEvents, scheduleCallWithOrigin, type TestConfig } from './helpers/index.js'

/// -------
/// Constants
/// -------

/** 1 token of a 6-decimal asset (the internal stablecoin, USDT and USDC). */
const UNIT = 1_000_000n

/** Minimum swap the suite configures on the PSM it creates, in internal units. */
const MIN_SWAP = 10n * UNIT

/** Debt ceiling the suite configures on the PSM it creates, in internal units. */
const MAX_DEBT = 10_000n * UNIT

/**
 * Ceiling weight given to each of the two 6-decimal externals at setup.
 *
 * The pallet normalises weights against the sum of weights on the same instance, so two
 * externals at 50% each land on `MAX_DEBT / 2` apiece.
 */
const HALF_WEIGHT = 500_000

/** Per-asset ceiling implied by `MAX_DEBT` and two equal `HALF_WEIGHT` externals. */
const ASSET_CEILING = MAX_DEBT / 2n

/**
 * Minting and redemption fee the pallet falls back to when no fee was ever set for a pair.
 * Expressed in parts per million, matching `Permill`.
 */
const DEFAULT_FEE = 5_000

/** `max_fee` that accepts whatever fee the instance has configured (100%, in parts per million). */
const ANY_FEE = 1_000_000

/**
 * Native-token balance for the accounts the suite signs with. Large enough to cover the
 * instance creation deposit, whose size is a runtime parameter rather than a pallet constant,
 * on chains with up to 12 decimals.
 */
const NATIVE_ENDOWMENT = 100_000n * 10n ** 12n

/** External balance handed to each swapping account, comfortably above every ceiling in use. */
const EXTERNAL_ENDOWMENT = 50_000n * UNIT

/**
 * PSM-specific test parameters.
 *
 * Kept separate from the chain definition because they describe the test scenario rather than
 * the chain. The suite creates its own PSM instance, so the only chain-derived requirement is
 * that `internalAssetId` is free and the external assets exist.
 */
export interface PsmTestConfig extends TestConfig {
  /** Unused local `Assets` id. The suite injects a 6-decimal internal stablecoin under it. */
  internalAssetId: number
  /** Local `Assets` id of a 6-decimal external, used as the primary external throughout. */
  primaryExternalId: number
  /** Local `Assets` id of a second 6-decimal external, used for per-asset ceiling tests. */
  secondaryExternalId: number
  /**
   * A `ForeignAssets` entry whose decimals differ from the internal asset's, used to exercise
   * decimal scaling and the foreign half of the PSM's asset union.
   */
  foreignExternal: {
    location: Record<string, any>
    decimals: number
  }
  /**
   * Further existing assets, approved only to reach the pallet's cap on approved externals.
   * They are never swapped, so their economics are irrelevant; they need only exist on chain.
   * Enough entries must be supplied that, with the three above, the cap can be exceeded.
   */
  capFillerExternals: Record<string, any>[]
}

const devAccounts = testAccounts

/// -------
/// Helpers
/// -------

/**
 * XCM location of an asset held in the local `Assets` pallet, as the PSM's asset union
 * resolves it. The PSM keys every map by location rather than by numeric id.
 */
const assetLocation = (assetId: number) => ({
  parents: 0,
  interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetId }] },
})

/**
 * Reserve account holding a PSM instance's external collateral.
 *
 * Mirrors the pallet's own derivation: `blake2_256` over the pallet-id type tag `modl`, the
 * pallet id `py/pegsm`, and the SCALE-encoded internal asset location. Derived here rather than
 * read from storage because the pallet exposes it only as a computed value.
 */
function psmReserveAccount(client: Client<any, any>, internalLocation: Record<string, any>): string {
  const encodedLocation = client.api.createType('StagingXcmV5Location', internalLocation).toU8a()
  const entropy = blake2AsU8a(u8aConcat(stringToU8a('modl'), stringToU8a('py/pegsm'), encodedLocation), 256)
  return encodeAddress(entropy, client.config.properties.addressEncoding)
}

/** Balance of a local `Assets` asset, returning `0n` when the account holds no entry. */
async function assetBalance(client: Client<any, any>, assetId: number, address: string): Promise<bigint> {
  const entry = await client.api.query.assets.account(assetId, address)
  return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
}

/** Balance of a `ForeignAssets` asset, returning `0n` when the account holds no entry. */
async function foreignAssetBalance(
  client: Client<any, any>,
  location: Record<string, any>,
  address: string,
): Promise<bigint> {
  const entry = (await client.api.query.foreignAssets.account(location, address)) as any
  return entry.isSome ? entry.unwrap().balance.toBigInt() : 0n
}

/** Debt a PSM instance has minted against one external, in internal units. */
async function psmDebt(
  client: Client<any, any>,
  internalLocation: Record<string, any>,
  externalLocation: Record<string, any>,
): Promise<bigint> {
  return ((await (client.api.query as any).psm.psmDebt(internalLocation, externalLocation)) as any).toBigInt()
}

/**
 * Assert that the last block's only extrinsic failed with a specific PSM error.
 *
 * `errorName` is looked up on the runtime's own error metadata, so a renamed or removed
 * variant fails the test rather than silently matching nothing.
 */
async function expectPsmError(client: Client<any, any>, errorName: string): Promise<void> {
  const events = await client.api.query.system.events()
  const failure = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failure, 'expected an ExtrinsicFailed event')
  assert(client.api.events.system.ExtrinsicFailed.is(failure.event))

  const { dispatchError } = failure.event.data
  assert(dispatchError.isModule, `expected a module error, got ${dispatchError.type}`)

  const psmErrors = (client.api.errors as any).psm
  assert(psmErrors[errorName], `runtime has no psm error named ${errorName}`)
  expect(psmErrors[errorName].is(dispatchError.asModule)).toBe(true)
}

/** Assert that the last block's only extrinsic failed with `BadOrigin`. */
async function expectBadOrigin(client: Client<any, any>): Promise<void> {
  const events = await client.api.query.system.events()
  const failure = events.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(failure, 'expected an ExtrinsicFailed event')
  assert(client.api.events.system.ExtrinsicFailed.is(failure.event))

  expect(failure.event.data.dispatchError.isBadOrigin).toBe(true)
}

/**
 * Inject the assets the suite swaps with, without creating a PSM.
 *
 * The internal stablecoin does not exist on the forked chain, so it is written directly into
 * the `Assets` pallet with alice as owner: the runtime's create origin admits the internal
 * asset's owner, which lets the suite create its PSM from a plain signed origin. Balances and
 * DOT endowments are storage writes rather than transfers so that no block is spent on setup.
 */
async function injectAssets(client: Client<any, any>, testConfig: PsmTestConfig): Promise<void> {
  const { internalAssetId, primaryExternalId, secondaryExternalId, foreignExternal } = testConfig
  const { alice, bob, charlie, dave } = devAccounts

  await client.dev.setStorage({
    System: {
      account: [
        // A consumer reference lets alice hold non-sufficient assets such as bridged DAI;
        // without it the assets pallet refuses to transfer from the injected account.
        [[alice.address], { providers: 1, consumers: 1, data: { free: NATIVE_ENDOWMENT } }],
        [[bob.address], { providers: 1, data: { free: NATIVE_ENDOWMENT } }],
        [[charlie.address], { providers: 1, data: { free: NATIVE_ENDOWMENT } }],
        [[dave.address], { providers: 1, data: { free: NATIVE_ENDOWMENT } }],
      ],
    },
    Assets: {
      asset: [
        [
          [internalAssetId],
          {
            owner: alice.address,
            issuer: alice.address,
            admin: alice.address,
            freezer: alice.address,
            supply: 0,
            deposit: 0,
            minBalance: 1,
            isSufficient: true,
            accounts: 0,
            sufficients: 0,
            approvals: 0,
            status: 'Live',
          },
        ],
      ],
      metadata: [
        [[internalAssetId], { deposit: 0, name: 'Polkadot USD', symbol: 'pUSD', decimals: 6, isFrozen: false }],
      ],
      account: [
        [[primaryExternalId, alice.address], { balance: EXTERNAL_ENDOWMENT }],
        [[primaryExternalId, bob.address], { balance: EXTERNAL_ENDOWMENT }],
        [[secondaryExternalId, alice.address], { balance: EXTERNAL_ENDOWMENT }],
      ],
    },
  })

  // The foreign external is a real, thinly-issued asset on the forked chain, so handing alice a
  // balance out of thin air would leave her holding more than its total issuance and desync the
  // account counters. Its details are read back and rewritten with an issuance and account count
  // that cover the injected holding, keeping the asset internally consistent.
  const foreignDetails = (await (client.api.query.foreignAssets.asset(foreignExternal.location) as any)).unwrap()
  const foreignEndowment = 100n * 10n ** BigInt(foreignExternal.decimals)

  await client.dev.setStorage({
    ForeignAssets: {
      asset: [
        [
          [foreignExternal.location],
          {
            ...foreignDetails.toJSON(),
            supply: foreignDetails.supply.toBigInt() + foreignEndowment,
            accounts: foreignDetails.accounts.toNumber() + 1,
          },
        ],
      ],
      account: [
        [
          [foreignExternal.location, alice.address],
          { balance: foreignEndowment, status: 'Liquid', reason: 'Consumer' },
        ],
      ],
    },
  })
}

/**
 * Create the PSM the majority of the suite operates on, in a single block.
 *
 * Alice owns the internal asset, so she can create the instance and is set as its `full_admin`;
 * bob is set as `emergency_admin` and dave as the fee destination, which keeps privilege and
 * fee-accrual assertions free of the balances the swapping accounts move. Both 6-decimal
 * externals are approved and given equal ceiling weight.
 */
async function createPsmInstance(client: Client<any, any>, testConfig: PsmTestConfig): Promise<void> {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts

  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  const setup = client.api.tx.utility.batchAll([
    psm.createPsm(
      internal,
      { system: { Signed: alice.address } },
      { system: { Signed: bob.address } },
      dave.address,
      MAX_DEBT,
      MIN_SWAP,
    ),
    psm.addExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.addExternalAsset(internal, assetLocation(secondaryExternalId)),
    psm.setAssetCeilingWeight(internal, assetLocation(primaryExternalId), HALF_WEIGHT),
    psm.setAssetCeilingWeight(internal, assetLocation(secondaryExternalId), HALF_WEIGHT),
  ])

  await sendTransaction(setup.signAsync(alice))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  assert(
    events.find(({ event }) => client.api.events.utility.BatchCompleted.is(event)),
    'PSM setup batch did not complete',
  )
}

/// -------
/// Tests - Instance lifecycle
/// -------

/**
 * Create a PSM from the internal asset's owner and verify the instance is recorded and paid for.
 *
 * 1. Create the PSM as alice, who owns the internal asset
 * 2. Verify the PsmCreated event carries the admins, fee destination and debt ceiling
 * 3. Verify the Psm entry stores the ceiling, minimum swap and snapshotted internal decimals
 * 4. Verify the PsmAdmin entry stores both admin origins
 * 5. Verify a creation deposit was placed on hold against alice
 */
async function createPsmAsAssetOwner(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  const reservedBefore = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()

  // 1. Create the PSM as the internal asset's owner
  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. PsmCreated event
  await checkSystemEvents(client, { section: 'psm', method: 'PsmCreated' }).toMatchSnapshot(
    'create PSM: PsmCreated event',
  )

  const events = await client.api.query.system.events()
  const created = events.find(({ event }) => event.section === 'psm' && event.method === 'PsmCreated')
  assert(created)
  const createdData = created.event.data as any
  expect(createdData.internalAsset.eq(internal)).toBe(true)
  expect(createdData.feeDestination.toString()).toBe(
    encodeAddress(dave.address, client.config.properties.addressEncoding),
  )
  expect(createdData.maxDebt.toBigInt()).toBe(MAX_DEBT)

  // 3. Psm storage entry
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.isSome).toBe(true)
  const psmInfo = info.unwrap()
  expect(psmInfo.maxDebt.toBigInt()).toBe(MAX_DEBT)
  expect(psmInfo.minSwapAmount.toBigInt()).toBe(MIN_SWAP)
  expect(psmInfo.internalDecimals.toNumber()).toBe(6)
  expect(psmInfo.externalCount.toNumber()).toBe(0)

  // 4. PsmAdmin storage entry
  const admin = await (client.api.query as any).psm.psmAdmin(internal)
  expect(admin.isSome).toBe(true)
  const adminInfo = admin.unwrap()
  expect(adminInfo.fullAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(alice.address, client.config.properties.addressEncoding),
  )
  expect(adminInfo.emergencyAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(bob.address, client.config.properties.addressEncoding),
  )

  // 5. Creation deposit held from the creator
  const reservedAfter = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()
  expect(reservedAfter).toBeGreaterThan(reservedBefore)
}

/**
 * A zero minimum swap is rejected, since it would admit swaps that round to nothing.
 *
 * 1. Attempt to create the PSM with a zero minimum swap
 * 2. Verify the call failed with ZeroMinSwapAmount
 * 3. Verify no instance was recorded
 */
async function createPsmZeroMinSwapFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  // 1. Create with a zero minimum swap
  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    0,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. ZeroMinSwapAmount
  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'zero min swap: ExtrinsicFailed',
  )
  await expectPsmError(client, 'ZeroMinSwapAmount')

  // 3. No instance recorded
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)
}

/**
 * An account that does not own the internal asset cannot create a PSM for it.
 *
 * 1. Attempt to create the PSM as charlie, who owns nothing
 * 2. Verify the call failed with BadOrigin
 * 3. Verify no instance was recorded
 */
async function createPsmByNonOwnerFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, charlie, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  // 1. Create as a non-owner
  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(charlie))
  await client.dev.newBlock()

  // 2. BadOrigin
  await expectBadOrigin(client)

  // 3. No instance recorded
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)
}

/**
 * A second PSM cannot be created for an internal asset that already has one.
 *
 * 1. Create the PSM and approve its externals
 * 2. Attempt to create a second PSM for the same internal asset
 * 3. Verify the call failed with PsmAlreadyExists
 */
async function createPsmTwiceFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  // 1. First instance
  await createPsmInstance(client, testConfig)

  // 2. Second instance for the same internal asset
  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. PsmAlreadyExists
  await expectPsmError(client, 'PsmAlreadyExists')
}

/**
 * A PSM cannot be dismantled while it still has approved externals, and can be once they are
 * withdrawn.
 *
 * 1. Create the PSM with two approved externals
 * 2. Attempt removal, and verify it failed with PsmHasApprovedExternals
 * 3. Remove both externals
 * 4. Remove the PSM, and verify the PsmRemoved event
 * 5. Verify both the Psm and PsmAdmin entries are gone and the deposit was returned
 */
async function removePsmRequiresNoExternals(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with two externals
  const reservedBefore = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()
  await createPsmInstance(client, testConfig)
  const reservedWithPsm = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()
  expect(reservedWithPsm).toBeGreaterThan(reservedBefore)

  // 2. Removal blocked while externals remain
  await sendTransaction(psm.removePsm(internal).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'PsmHasApprovedExternals')
  expect((await (client.api.query as any).psm.psm(internal)).isSome).toBe(true)

  // 3. Withdraw both externals
  const withdraw = client.api.tx.utility.batchAll([
    psm.removeExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.removeExternalAsset(internal, assetLocation(secondaryExternalId)),
  ])
  await sendTransaction(withdraw.signAsync(alice))
  await client.dev.newBlock()

  // 4. Removal now succeeds
  await sendTransaction(psm.removePsm(internal).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'PsmRemoved' }).toMatchSnapshot(
    'remove PSM: PsmRemoved event',
  )
  const events = await client.api.query.system.events()
  const removed = events.find(({ event }) => event.section === 'psm' && event.method === 'PsmRemoved')
  assert(removed)
  expect((removed.event.data as any).internalAsset.eq(internal)).toBe(true)

  // 5. Instance state cleared and deposit refunded
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)
  expect((await (client.api.query as any).psm.psmAdmin(internal)).isNone).toBe(true)
  const reservedAfter = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()
  expect(reservedAfter).toBe(reservedBefore)
}

/// -------
/// Tests - External asset management
/// -------

/**
 * Approving an external records its decimals and counts it against the instance.
 *
 * 1. Create a bare PSM with no externals
 * 2. Approve the primary external
 * 3. Verify the ExternalAssetAdded event
 * 4. Verify the ExternalAssets entry snapshots the external's decimals and starts fully enabled
 * 5. Verify the instance's external count incremented
 */
async function addExternalAssetRecordsDecimals(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Bare instance
  const createCall = psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. Approve the external
  await sendTransaction(psm.addExternalAsset(internal, external).signAsync(alice))
  await client.dev.newBlock()

  // 3. ExternalAssetAdded event
  await checkSystemEvents(client, { section: 'psm', method: 'ExternalAssetAdded' }).toMatchSnapshot(
    'add external: ExternalAssetAdded event',
  )
  const events = await client.api.query.system.events()
  const added = events.find(({ event }) => event.section === 'psm' && event.method === 'ExternalAssetAdded')
  assert(added)
  const addedData = added.event.data as any
  expect(addedData.internalAsset.eq(internal)).toBe(true)
  expect(addedData.externalAsset.eq(external)).toBe(true)

  // 4. Decimals snapshot, enabled by default
  const entry = await (client.api.query as any).psm.externalAssets(internal, external)
  expect(entry.isSome).toBe(true)
  expect(entry.unwrap().decimals.toNumber()).toBe(6)
  expect(entry.unwrap().status.isAllEnabled).toBe(true)

  // 5. External count
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.unwrap().externalCount.toNumber()).toBe(1)
}

/**
 * The same external cannot be approved twice on one instance.
 *
 * 1. Create the PSM, which already approves the primary external
 * 2. Approve the primary external again
 * 3. Verify the call failed with AssetAlreadyApproved
 */
async function addExternalAssetTwiceFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts

  // 1. Instance with the primary external already approved
  await createPsmInstance(client, testConfig)

  // 2. Approve it a second time
  const addCall = (client.api.tx as any).psm.addExternalAsset(
    assetLocation(internalAssetId),
    assetLocation(primaryExternalId),
  )
  await sendTransaction(addCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. AssetAlreadyApproved
  await expectPsmError(client, 'AssetAlreadyApproved')
}

/**
 * An external that does not exist on chain cannot be approved.
 *
 * 1. Create the PSM
 * 2. Approve an asset id that has no entry in the assets pallet
 * 3. Verify the call failed with AssetDoesNotExist
 */
async function addNonexistentExternalFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice } = devAccounts

  // 1. Instance
  await createPsmInstance(client, testConfig)

  // 2. Approve an unregistered asset id
  const missingAssetId = 4_294_967_000
  expect((await client.api.query.assets.asset(missingAssetId)).isNone).toBe(true)
  const addCall = (client.api.tx as any).psm.addExternalAsset(
    assetLocation(internalAssetId),
    assetLocation(missingAssetId),
  )
  await sendTransaction(addCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. AssetDoesNotExist
  await expectPsmError(client, 'AssetDoesNotExist')

  // 4. The external was not approved
  expect(
    (await (client.api.query as any).psm.externalAssets(assetLocation(internalAssetId), assetLocation(missingAssetId)))
      .isNone,
  ).toBe(true)
}

/**
 * An external carrying debt cannot be withdrawn, since doing so would strand the collateral.
 *
 * 1. Create the PSM and mint against the primary external
 * 2. Attempt to remove that external
 * 3. Verify the call failed with AssetHasDebt and the external is still approved
 */
async function removeExternalWithDebtFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance carrying debt
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, external)).toBe(100n * UNIT)

  // 2. Attempt removal
  await sendTransaction(psm.removeExternalAsset(internal, external).signAsync(alice))
  await client.dev.newBlock()

  // 3. AssetHasDebt, external untouched
  await expectPsmError(client, 'AssetHasDebt')
  expect((await (client.api.query as any).psm.externalAssets(internal, external)).isSome).toBe(true)
}

/// -------
/// Tests - Swaps
/// -------

/**
 * Mint the internal stablecoin against a 6-decimal external and verify every balance the swap
 * touches.
 *
 * 1. Create the PSM and record the balances the mint will move
 * 2. Mint 1000 units of the primary external
 * 3. Verify the Minted event reports the external consumed, internal received and fee
 * 4. Verify the fee is the pallet's default rate applied to the internal equivalent
 * 5. Verify alice paid the external and received the internal minus the fee
 * 6. Verify the external landed in the instance's reserve account
 * 7. Verify the fee was minted to the instance's fee destination
 * 8. Verify the instance's debt grew by the full internal equivalent, fee included
 */
async function mintAgainstExternal(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)

  // 1. Setup and balance snapshot
  await createPsmInstance(client, testConfig)
  const reserve = psmReserveAccount(client, internal)

  const externalBefore = await assetBalance(client, primaryExternalId, alice.address)
  const internalBefore = await assetBalance(client, internalAssetId, alice.address)
  const reserveBefore = await assetBalance(client, primaryExternalId, reserve)
  const feeDestBefore = await assetBalance(client, internalAssetId, dave.address)

  // 2. Mint
  const mintAmount = 1_000n * UNIT
  const mintCall = (client.api.tx as any).psm.mint(internal, external, mintAmount, ANY_FEE)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. Minted event
  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot('mint: Minted event')

  const events = await client.api.query.system.events()
  const minted = events.find(({ event }) => event.section === 'psm' && event.method === 'Minted')
  assert(minted)
  const mintedData = minted.event.data as any
  expect(mintedData.who.toString()).toBe(encodeAddress(alice.address, client.config.properties.addressEncoding))
  expect(mintedData.internalAsset.eq(internal)).toBe(true)
  expect(mintedData.externalAsset.eq(external)).toBe(true)
  expect(mintedData.externalConsumed.toBigInt()).toBe(mintAmount)

  // 4. Fee is the default rate on the internal equivalent, which is 1:1 at equal decimals
  const expectedFee = (mintAmount * BigInt(DEFAULT_FEE)) / 1_000_000n
  const expectedReceived = mintAmount - expectedFee
  expect(mintedData.internalFee.toBigInt()).toBe(expectedFee)
  expect(mintedData.internalReceived.toBigInt()).toBe(expectedReceived)

  // 5. Caller's balances
  expect(await assetBalance(client, primaryExternalId, alice.address)).toBe(externalBefore - mintAmount)
  expect(await assetBalance(client, internalAssetId, alice.address)).toBe(internalBefore + expectedReceived)

  // 6. Reserve holds the collateral
  expect(await assetBalance(client, primaryExternalId, reserve)).toBe(reserveBefore + mintAmount)

  // 7. Fee destination
  expect(await assetBalance(client, internalAssetId, dave.address)).toBe(feeDestBefore + expectedFee)

  // 8. Debt tracks the gross internal equivalent
  expect(await psmDebt(client, internal, external)).toBe(mintAmount)
}

/**
 * Redeem the internal stablecoin back into the external and verify the reserve unwinds.
 *
 * 1. Create the PSM and mint to build a reserve
 * 2. Redeem 500 internal units
 * 3. Verify the Redeemed event reports the internal consumed, external received and fee
 * 4. Verify alice received the external net of the redemption fee
 * 5. Verify the reserve shrank by exactly what alice received
 * 6. Verify the debt fell by the internal amount burned, excluding the fee
 */
async function redeemBackToExternal(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Setup with a funded reserve
  await createPsmInstance(client, testConfig)
  const reserve = psmReserveAccount(client, internal)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  const debtBefore = await psmDebt(client, internal, external)
  const externalBefore = await assetBalance(client, primaryExternalId, alice.address)
  const reserveBefore = await assetBalance(client, primaryExternalId, reserve)

  // 2. Redeem
  const redeemAmount = 500n * UNIT
  await sendTransaction(psm.redeem(internal, external, redeemAmount, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 3. Redeemed event
  await checkSystemEvents(client, { section: 'psm', method: 'Redeemed' }).toMatchSnapshot('redeem: Redeemed event')

  const events = await client.api.query.system.events()
  const redeemed = events.find(({ event }) => event.section === 'psm' && event.method === 'Redeemed')
  assert(redeemed)
  const redeemedData = redeemed.event.data as any
  expect(redeemedData.who.toString()).toBe(encodeAddress(alice.address, client.config.properties.addressEncoding))
  expect(redeemedData.internalAsset.eq(internal)).toBe(true)
  expect(redeemedData.externalAsset.eq(external)).toBe(true)

  const expectedFee = (redeemAmount * BigInt(DEFAULT_FEE)) / 1_000_000n
  const expectedExternalOut = redeemAmount - expectedFee
  expect(redeemedData.internalFee.toBigInt()).toBe(expectedFee)
  expect(redeemedData.externalReceived.toBigInt()).toBe(expectedExternalOut)
  expect(redeemedData.internalConsumed.toBigInt()).toBe(redeemAmount)

  // 4. Caller received the external
  expect(await assetBalance(client, primaryExternalId, alice.address)).toBe(externalBefore + expectedExternalOut)

  // 5. Reserve released exactly that amount
  expect(await assetBalance(client, primaryExternalId, reserve)).toBe(reserveBefore - expectedExternalOut)

  // 6. Debt falls by the burned amount, which excludes the fee
  expect(await psmDebt(client, internal, external)).toBe(debtBefore - expectedExternalOut)
}

/**
 * Swaps below the instance's minimum are rejected.
 *
 * 1. Create the PSM
 * 2. Mint an amount one unit under the configured minimum swap
 * 3. Verify the call failed with BelowMinimumSwap and no debt was recorded
 */
async function mintBelowMinimumFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)

  // 1. Instance
  await createPsmInstance(client, testConfig)

  // 2. Mint just under the minimum
  const mintCall = (client.api.tx as any).psm.mint(internal, external, MIN_SWAP - 1n, ANY_FEE)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. BelowMinimumSwap
  await expectPsmError(client, 'BelowMinimumSwap')
  expect(await psmDebt(client, internal, external)).toBe(0n)
}

/**
 * A caller who will not accept the instance's configured fee has the swap rejected rather than
 * silently overpaying.
 *
 * 1. Create the PSM, whose pairs carry the pallet's default fee
 * 2. Mint while capping the acceptable fee below that default
 * 3. Verify the call failed with FeeTooHigh
 * 4. Verify the same mint succeeds once the cap admits the configured fee
 */
async function mintAboveMaxFeeFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance carrying the default fee
  await createPsmInstance(client, testConfig)

  // 2. Mint with too tight a fee cap
  await sendTransaction(psm.mint(internal, external, 100n * UNIT, DEFAULT_FEE - 1).signAsync(alice))
  await client.dev.newBlock()

  // 3. FeeTooHigh
  await expectPsmError(client, 'FeeTooHigh')
  expect(await psmDebt(client, internal, external)).toBe(0n)

  // 4. Accepting the configured fee lets the same mint through
  await sendTransaction(psm.mint(internal, external, 100n * UNIT, DEFAULT_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, external)).toBe(100n * UNIT)
}

/**
 * An external that was never approved cannot be swapped, even when it exists on chain.
 *
 * 1. Create a PSM approving only the primary external
 * 2. Mint against the secondary external
 * 3. Verify the call failed with UnsupportedAsset
 */
async function mintUnapprovedExternalFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance approving one external only
  const setup = client.api.tx.utility.batchAll([
    psm.createPsm(
      internal,
      { system: { Signed: alice.address } },
      { system: { Signed: bob.address } },
      dave.address,
      MAX_DEBT,
      MIN_SWAP,
    ),
    psm.addExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.setAssetCeilingWeight(internal, assetLocation(primaryExternalId), HALF_WEIGHT),
  ])
  await sendTransaction(setup.signAsync(alice))
  await client.dev.newBlock()

  // 2. Mint against the unapproved external
  const mintCall = psm.mint(internal, assetLocation(secondaryExternalId), 100n * UNIT, ANY_FEE)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. UnsupportedAsset
  await expectPsmError(client, 'UnsupportedAsset')
}

/**
 * Swapping against an internal asset with no instance is rejected.
 *
 * 1. Mint against an internal asset for which no PSM was created
 * 2. Verify the call failed with PsmNotFound
 */
async function mintWithoutInstanceFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)

  // 1. Mint with no instance present
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)
  const mintCall = (client.api.tx as any).psm.mint(internal, assetLocation(primaryExternalId), 100n * UNIT, ANY_FEE)
  await sendTransaction(mintCall.signAsync(alice))
  await client.dev.newBlock()

  // 2. PsmNotFound
  await expectPsmError(client, 'PsmNotFound')
}

/// -------
/// Tests - Debt ceilings
/// -------

/**
 * An external can be minted up to its normalised share of the instance ceiling, and no further.
 *
 * 1. Create the PSM, giving both externals equal weight and so half the ceiling each
 * 2. Mint the primary external exactly up to its share
 * 3. Verify the debt sits on the ceiling
 * 4. Attempt one more minimum-sized mint and verify it failed with ExceedsMaxPsmDebt
 * 5. Verify the debt is unchanged
 */
async function perAssetCeilingIsEnforced(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with two equally weighted externals
  await createPsmInstance(client, testConfig)

  // 2. Mint up to the per-asset ceiling
  await sendTransaction(psm.mint(internal, external, ASSET_CEILING, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 3. Debt is exactly at the ceiling
  expect(await psmDebt(client, internal, external)).toBe(ASSET_CEILING)

  // 4. One more swap breaches it
  await sendTransaction(psm.mint(internal, external, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'ExceedsMaxPsmDebt')

  // 5. Debt unchanged
  expect(await psmDebt(client, internal, external)).toBe(ASSET_CEILING)
}

/**
 * Zeroing an external's weight closes it for minting and hands its share to the remaining
 * externals.
 *
 * 1. Create the PSM with both externals equally weighted
 * 2. Zero the secondary external's weight and verify the AssetCeilingWeightUpdated event
 * 3. Verify minting the zero-weighted external fails with ExceedsMaxPsmDebt
 * 4. Verify the primary external now absorbs the whole instance ceiling
 */
async function zeroWeightClosesExternal(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const primary = assetLocation(primaryExternalId)
  const secondary = assetLocation(secondaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with two equally weighted externals
  await createPsmInstance(client, testConfig)

  // 2. Zero the secondary weight
  await sendTransaction(psm.setAssetCeilingWeight(internal, secondary, 0).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'AssetCeilingWeightUpdated' }).toMatchSnapshot(
    'zero weight: AssetCeilingWeightUpdated event',
  )
  const events = await client.api.query.system.events()
  const updated = events.find(({ event }) => event.section === 'psm' && event.method === 'AssetCeilingWeightUpdated')
  assert(updated)
  const updatedData = updated.event.data as any
  expect(updatedData.externalAsset.eq(secondary)).toBe(true)
  expect(updatedData.newValue.toNumber()).toBe(0)

  // 3. The zero-weighted external can no longer be minted
  await sendTransaction(psm.mint(internal, secondary, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'ExceedsMaxPsmDebt')

  // 4. The remaining external absorbs the full ceiling
  await sendTransaction(psm.mint(internal, primary, MAX_DEBT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, primary)).toBe(MAX_DEBT)
}

/**
 * Lowering the instance ceiling below outstanding debt pauses minting without clawing anything
 * back, and redemptions still unwind the position.
 *
 * 1. Create the PSM and mint against the primary external
 * 2. Drop the instance ceiling to a fraction of the outstanding debt
 * 3. Verify the MaxDebtUpdated event reports the old and new ceilings
 * 4. Verify the outstanding debt is untouched
 * 5. Verify further minting fails with ExceedsMaxPsmDebt
 * 6. Verify redeeming still works and reduces the debt
 */
async function loweringCeilingPausesMinting(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance carrying debt
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)
  expect(debtBefore).toBe(1_000n * UNIT)

  // 2. Drop the ceiling below the outstanding debt
  await sendTransaction(psm.setMaxDebt(internal, 100n * UNIT).signAsync(alice))
  await client.dev.newBlock()

  // 3. MaxDebtUpdated event
  await checkSystemEvents(client, { section: 'psm', method: 'MaxDebtUpdated' }).toMatchSnapshot(
    'lower ceiling: MaxDebtUpdated event',
  )
  const events = await client.api.query.system.events()
  const updated = events.find(({ event }) => event.section === 'psm' && event.method === 'MaxDebtUpdated')
  assert(updated)
  const updatedData = updated.event.data as any
  expect(updatedData.oldValue.toBigInt()).toBe(MAX_DEBT)
  expect(updatedData.newValue.toBigInt()).toBe(100n * UNIT)

  // 4. Debt is not clawed back
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)

  // 5. Minting is paused
  await sendTransaction(psm.mint(internal, external, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'ExceedsMaxPsmDebt')

  // 6. Redemption still unwinds the position
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, external)).toBeLessThan(debtBefore)
}

/// -------
/// Tests - Circuit breaker and privilege
/// -------

/**
 * The intermediate breaker level stops minting while leaving redemptions open, so holders can
 * still exit.
 *
 * 1. Create the PSM and mint to build a position
 * 2. Set the external's breaker to MintingDisabled, and verify the AssetStatusUpdated event
 * 3. Verify minting fails with MintingStopped
 * 4. Verify redeeming still succeeds and reduces the debt
 */
async function mintingDisabledStopsMintOnly(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance carrying a position
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)

  // 2. Halt minting
  await sendTransaction(psm.setAssetStatus(internal, external, 'MintingDisabled').signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'AssetStatusUpdated' }).toMatchSnapshot(
    'minting disabled: AssetStatusUpdated event',
  )
  const events = await client.api.query.system.events()
  const statusUpdated = events.find(({ event }) => event.section === 'psm' && event.method === 'AssetStatusUpdated')
  assert(statusUpdated)
  expect((statusUpdated.event.data as any).status.isMintingDisabled).toBe(true)

  // 3. Minting is refused
  await sendTransaction(psm.mint(internal, external, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'MintingStopped')

  // 4. Redemption still works
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, external)).toBeLessThan(debtBefore)
}

/**
 * The top breaker level stops both directions.
 *
 * 1. Create the PSM and mint to build a position
 * 2. Set the external's breaker to AllDisabled
 * 3. Verify minting fails with MintingStopped
 * 4. Verify redeeming fails with AllSwapsStopped and the debt is unchanged
 */
async function allDisabledStopsBothDirections(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance carrying a position
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)

  // 2. Halt everything
  await sendTransaction(psm.setAssetStatus(internal, external, 'AllDisabled').signAsync(alice))
  await client.dev.newBlock()

  // 3. Minting refused
  await sendTransaction(psm.mint(internal, external, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'MintingStopped')

  // 4. Redemption refused, debt untouched
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'AllSwapsStopped')
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)
}

/**
 * The emergency admin may trip the breaker but may not touch economic parameters.
 *
 * 1. Create the PSM, whose emergency admin is bob
 * 2. Have bob set the breaker, and verify it took effect
 * 3. Have bob lower the debt ceiling, and verify it failed with InsufficientPrivilege
 * 4. Verify the ceiling is unchanged
 */
async function emergencyAdminIsLimitedToBreaker(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { bob } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with bob as emergency admin
  await createPsmInstance(client, testConfig)

  // 2. Bob may trip the breaker
  await sendTransaction(psm.setAssetStatus(internal, external, 'MintingDisabled').signAsync(bob))
  await client.dev.newBlock()
  const entry = await (client.api.query as any).psm.externalAssets(internal, external)
  expect(entry.unwrap().status.isMintingDisabled).toBe(true)

  // 3. Bob may not move the ceiling
  await sendTransaction(psm.setMaxDebt(internal, 1n * UNIT).signAsync(bob))
  await client.dev.newBlock()
  await expectPsmError(client, 'InsufficientPrivilege')

  // 4. Ceiling unchanged
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.unwrap().maxDebt.toBigInt()).toBe(MAX_DEBT)
}

/**
 * An account holding neither admin role cannot administer the instance at all.
 *
 * 1. Create the PSM, whose admins are alice and bob
 * 2. Have charlie try to trip the breaker
 * 3. Verify the call failed with BadOrigin rather than a privilege error
 * 4. Verify the external is still fully enabled
 */
async function nonAdminCannotAdminister(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { charlie } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)

  // 1. Instance administered by alice and bob
  await createPsmInstance(client, testConfig)

  // 2. Charlie attempts to trip the breaker
  const statusCall = (client.api.tx as any).psm.setAssetStatus(internal, external, 'AllDisabled')
  await sendTransaction(statusCall.signAsync(charlie))
  await client.dev.newBlock()

  // 3. BadOrigin, since charlie matches neither stored admin origin
  await expectBadOrigin(client)

  // 4. Breaker untouched
  const entry = await (client.api.query as any).psm.externalAssets(internal, external)
  expect(entry.unwrap().status.isAllEnabled).toBe(true)
}

/// ----------
/// Tests - Decimal scaling
/// ----------

/**
 * An external with more decimals than the internal asset is scaled down on mint and back up on
 * redeem.
 *
 * 1. Create the PSM and approve the higher-decimal foreign external alongside the others
 * 2. Mint 20 whole units of it
 * 3. Verify the debt is the internal-scaled equivalent rather than the raw external amount
 * 4. Redeem half of that debt and verify the external returned is scaled back up
 */
async function higherDecimalExternalScales(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, foreignExternal } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = foreignExternal.location
  const psm = (client.api.tx as any).psm

  // 1. Approve the foreign external and give it weight
  await createPsmInstance(client, testConfig)
  const approve = client.api.tx.utility.batchAll([
    psm.addExternalAsset(internal, external),
    psm.setAssetCeilingWeight(internal, external, HALF_WEIGHT),
  ])
  await sendTransaction(approve.signAsync(alice))
  await client.dev.newBlock()

  const approveEvents = await client.api.query.system.events()
  assert(
    approveEvents.find(({ event }) => client.api.events.utility.BatchCompleted.is(event)),
    'approving the higher-decimal external did not complete',
  )

  const externalUnit = 10n ** BigInt(foreignExternal.decimals)
  const scale = externalUnit / UNIT

  // 2. Mint 20 whole units of the foreign external
  const mintAmount = 20n * externalUnit
  await sendTransaction(psm.mint(internal, external, mintAmount, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'high decimal mint: Minted event',
  )

  // 3. Debt is denominated in internal units
  const expectedDebt = mintAmount / scale
  expect(await psmDebt(client, internal, external)).toBe(expectedDebt)

  const externalBefore = await foreignAssetBalance(client, external, alice.address)

  // 4. Redeem half, and confirm the external returned is scaled back up
  const redeemAmount = expectedDebt / 2n
  await sendTransaction(psm.redeem(internal, external, redeemAmount, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  const expectedFee = (redeemAmount * BigInt(DEFAULT_FEE)) / 1_000_000n
  const expectedExternalOut = (redeemAmount - expectedFee) * scale
  expect(await foreignAssetBalance(client, external, alice.address)).toBe(externalBefore + expectedExternalOut)
}

/**
 * A swap too small to survive scaling into the internal asset is rejected rather than
 * transferring nothing.
 *
 * 1. Create the PSM and approve the higher-decimal foreign external
 * 2. Mint an amount that scales down to zero internal units
 * 3. Verify the call failed with AmountTooSmallAfterConversion
 */
async function dustSwapIsRejected(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, foreignExternal } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = foreignExternal.location
  const psm = (client.api.tx as any).psm

  // 1. Approve the foreign external
  await createPsmInstance(client, testConfig)
  const approve = client.api.tx.utility.batchAll([
    psm.addExternalAsset(internal, external),
    psm.setAssetCeilingWeight(internal, external, HALF_WEIGHT),
  ])
  await sendTransaction(approve.signAsync(alice))
  await client.dev.newBlock()

  const approveEvents = await client.api.query.system.events()
  assert(
    approveEvents.find(({ event }) => client.api.events.utility.BatchCompleted.is(event)),
    'approving the higher-decimal external did not complete',
  )

  // 2. Mint an amount below one internal unit's worth
  const scale = 10n ** BigInt(foreignExternal.decimals) / UNIT
  await sendTransaction(psm.mint(internal, external, scale - 1n, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 3. AmountTooSmallAfterConversion
  await expectPsmError(client, 'AmountTooSmallAfterConversion')
}

/// -------
/// Tests - Instance creation
/// -------

/**
 * A PSM cannot be created over an internal asset that does not exist.
 *
 * The rejection is `BadOrigin` rather than the pallet's `AssetDoesNotExist`, because the create
 * origin resolves the asset's owner first and a missing asset has none, so no signed caller can
 * satisfy it. `AssetDoesNotExist` is therefore reachable on this call only through an origin
 * that bypasses the ownership check.
 *
 * 1. Pick an asset id with no entry in the assets pallet
 * 2. Attempt to create a PSM keyed by it
 * 3. Verify the call was refused with BadOrigin
 * 4. Verify no instance was recorded
 */
async function createPsmForMissingAssetFails(client: Client<any, any>, _testConfig: PsmTestConfig) {
  const { alice, bob, dave } = devAccounts

  // 1. An unregistered asset id
  const missingAssetId = 4_294_967_001
  expect((await client.api.query.assets.asset(missingAssetId)).isNone).toBe(true)

  // 2. Create a PSM over it
  const createCall = (client.api.tx as any).psm.createPsm(
    assetLocation(missingAssetId),
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. BadOrigin, since the asset has no owner to match against
  await expectBadOrigin(client)

  // 4. No instance recorded
  expect((await (client.api.query as any).psm.psm(assetLocation(missingAssetId))).isNone).toBe(true)
}

/**
 * Root creates a PSM without paying the deposit a signed owner would.
 *
 * The runtime's create origin admits either the internal asset's owner, who is charged a
 * deposit, or Root, which is not. The call is too large to travel in the scheduler's inline
 * form, whose encoded bound is 128 bytes, so it is noted as a preimage and scheduled by lookup;
 * scheduling it inline would leave an agenda entry the runtime cannot decode, which is silently
 * discarded rather than dispatched.
 *
 * 1. Note the creation call as a preimage
 * 2. Schedule it by lookup with a Root origin
 * 3. Verify the scheduler dispatched it successfully
 * 4. Verify the instance was recorded and no deposit was charged to the named admin
 * 5. Verify the named full admin, not Root, administers the instance
 */
async function createPsmByRootTakesNoDeposit(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  const encoded = createCall.method.toHex()

  // 1. Note the call as a preimage
  await sendTransaction(client.api.tx.preimage.notePreimage(encoded).signAsync(alice))
  await client.dev.newBlock()

  const reservedBefore = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()

  // 2. Schedule by lookup under a Root origin
  await scheduleCallWithOrigin(
    client,
    { Lookup: { hash: blake2AsHex(encoded, 256), len: (encoded.length - 2) / 2 } },
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // 3. Dispatched without error
  const events = await client.api.query.system.events()
  const dispatched = events.find(({ event }) => client.api.events.scheduler.Dispatched.is(event))
  assert(dispatched, 'the scheduler did not dispatch the creation call')
  assert(client.api.events.scheduler.Dispatched.is(dispatched.event))
  expect(dispatched.event.data.result.isOk).toBe(true)

  // 4. Instance recorded, no deposit charged
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.isSome).toBe(true)
  expect(info.unwrap().maxDebt.toBigInt()).toBe(MAX_DEBT)
  const reservedAfter = (await client.api.query.system.account(alice.address)).data.reserved.toBigInt()
  expect(reservedAfter).toBe(reservedBefore)

  // 5. The named admin administers the instance
  await sendTransaction((client.api.tx as any).psm.setMaxDebt(internal, 1_000n * UNIT).signAsync(alice))
  await client.dev.newBlock()
  const updated = await (client.api.query as any).psm.psm(internal)
  expect(updated.unwrap().maxDebt.toBigInt()).toBe(1_000n * UNIT)
}

/**
 * An owner who cannot cover the creation deposit does not get an instance.
 *
 * 1. Strip alice's free balance to just above existential, leaving nothing for the deposit
 * 2. Attempt to create the PSM
 * 3. Verify no instance was recorded
 */
async function createPsmWithoutDepositFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)

  // 1. Leave alice unable to fund the deposit
  await client.dev.setStorage({
    System: { account: [[[alice.address], { providers: 1, consumers: 1, data: { free: 2n * 10n ** 10n } }]] },
  })

  // 2. Attempt creation
  const createCall = (client.api.tx as any).psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()

  // 3. No instance recorded
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)
}

/// -------
/// Tests - Instance removal
/// -------

/**
 * Removal is refused to an account holding neither admin role.
 *
 * 1. Create the PSM and withdraw its externals so only the admin check can fail
 * 2. Attempt removal as charlie
 * 3. Verify BadOrigin and that the instance survives
 */
async function removePsmByNonAdminFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, charlie } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with no approved externals
  await createPsmInstance(client, testConfig)
  const withdraw = client.api.tx.utility.batchAll([
    psm.removeExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.removeExternalAsset(internal, assetLocation(secondaryExternalId)),
  ])
  await sendTransaction(withdraw.signAsync(alice))
  await client.dev.newBlock()

  // 2. Removal by a stranger
  await sendTransaction(psm.removePsm(internal).signAsync(charlie))
  await client.dev.newBlock()

  // 3. BadOrigin, instance intact
  await expectBadOrigin(client)
  expect((await (client.api.query as any).psm.psm(internal)).isSome).toBe(true)
}

/**
 * The emergency admin cannot dismantle the instance it guards.
 *
 * 1. Create the PSM and withdraw its externals
 * 2. Attempt removal as the emergency admin
 * 3. Verify InsufficientPrivilege and that the instance survives
 */
async function removePsmByEmergencyAdminFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, bob } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with no approved externals
  await createPsmInstance(client, testConfig)
  const withdraw = client.api.tx.utility.batchAll([
    psm.removeExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.removeExternalAsset(internal, assetLocation(secondaryExternalId)),
  ])
  await sendTransaction(withdraw.signAsync(alice))
  await client.dev.newBlock()

  // 2. Removal by the emergency admin
  await sendTransaction(psm.removePsm(internal).signAsync(bob))
  await client.dev.newBlock()

  // 3. InsufficientPrivilege, instance intact
  await expectPsmError(client, 'InsufficientPrivilege')
  expect((await (client.api.query as any).psm.psm(internal)).isSome).toBe(true)
}

/**
 * Removing an instance twice fails, since the second attempt finds no admin record to check.
 *
 * 1. Create the PSM, withdraw its externals and remove it
 * 2. Attempt removal a second time
 * 3. Verify PsmNotFound
 */
async function removePsmTwiceFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Create, empty and remove
  await createPsmInstance(client, testConfig)
  const teardown = client.api.tx.utility.batchAll([
    psm.removeExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.removeExternalAsset(internal, assetLocation(secondaryExternalId)),
    psm.removePsm(internal),
  ])
  await sendTransaction(teardown.signAsync(alice))
  await client.dev.newBlock()
  expect((await (client.api.query as any).psm.psm(internal)).isNone).toBe(true)

  // 2. Remove again
  await sendTransaction(psm.removePsm(internal).signAsync(alice))
  await client.dev.newBlock()

  // 3. PsmNotFound
  await expectPsmError(client, 'PsmNotFound')
}

/// -------
/// Tests - Redemption rejections
/// -------

/**
 * Redemptions below the instance minimum are rejected, mirroring the mint side.
 *
 * 1. Create the PSM and mint so a position exists to redeem against
 * 2. Redeem one unit under the minimum swap
 * 3. Verify BelowMinimumSwap and that the debt is untouched
 */
async function redeemBelowMinimumFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Position to redeem against
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)

  // 2. Redeem under the minimum
  await sendTransaction(psm.redeem(internal, external, MIN_SWAP - 1n, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 3. BelowMinimumSwap, debt untouched
  await expectPsmError(client, 'BelowMinimumSwap')
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)
}

/**
 * A redeemer who will not accept the configured redemption fee is rejected rather than charged.
 *
 * 1. Create the PSM and mint so a position exists
 * 2. Redeem with a fee cap below the pallet's default rate
 * 3. Verify FeeTooHigh and that the debt is untouched
 * 4. Verify the same redemption succeeds once the cap admits the configured fee
 */
async function redeemAboveMaxFeeFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Position to redeem against
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)

  // 2. Too tight a fee cap
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, DEFAULT_FEE - 1).signAsync(alice))
  await client.dev.newBlock()

  // 3. FeeTooHigh, debt untouched
  await expectPsmError(client, 'FeeTooHigh')
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)

  // 4. Accepting the configured fee lets it through
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, DEFAULT_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, external)).toBeLessThan(debtBefore)
}

/**
 * Redeeming into an external that was never approved is rejected.
 *
 * 1. Create a PSM approving only the primary external, and mint against it
 * 2. Redeem naming the secondary external
 * 3. Verify UnsupportedAsset
 */
async function redeemUnapprovedExternalFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance approving one external, carrying debt
  const setup = client.api.tx.utility.batchAll([
    psm.createPsm(
      internal,
      { system: { Signed: alice.address } },
      { system: { Signed: bob.address } },
      dave.address,
      MAX_DEBT,
      MIN_SWAP,
    ),
    psm.addExternalAsset(internal, assetLocation(primaryExternalId)),
    psm.setAssetCeilingWeight(internal, assetLocation(primaryExternalId), HALF_WEIGHT),
  ])
  await sendTransaction(setup.signAsync(alice))
  await client.dev.newBlock()
  await sendTransaction(psm.mint(internal, assetLocation(primaryExternalId), 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 2. Redeem into the unapproved external
  await sendTransaction(psm.redeem(internal, assetLocation(secondaryExternalId), 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 3. UnsupportedAsset
  await expectPsmError(client, 'UnsupportedAsset')
}

/**
 * A redemption larger than the debt an external carries is refused, so one external's reserve
 * cannot be drained through a claim it never backed.
 *
 * 1. Create the PSM and mint a modest position against the primary external
 * 2. Hand bob more of the internal asset than that position is worth
 * 3. Have bob redeem beyond the recorded debt
 * 4. Verify InsufficientReserve and that the debt and reserve are untouched
 */
async function redeemBeyondDebtFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, bob } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Modest position
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 500n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const debtBefore = await psmDebt(client, internal, external)
  const reserve = psmReserveAccount(client, internal)
  const reserveBefore = await assetBalance(client, primaryExternalId, reserve)

  // 2. Bob holds more internal asset than the position backs
  await client.dev.setStorage({
    Assets: { account: [[[internalAssetId, bob.address], { balance: 5_000n * UNIT }]] },
  })

  // 3. Bob redeems past the recorded debt
  await sendTransaction(psm.redeem(internal, external, 2_000n * UNIT, ANY_FEE).signAsync(bob))
  await client.dev.newBlock()

  // 4. InsufficientReserve, nothing moved
  await expectPsmError(client, 'InsufficientReserve')
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)
  expect(await assetBalance(client, primaryExternalId, reserve)).toBe(reserveBefore)
}

/// -------
/// Tests - Fee configuration
/// -------

/**
 * The minting fee is configurable per pair and changes what a mint pays out.
 *
 * 1. Create the PSM and raise the minting fee to 5%
 * 2. Verify the MintingFeeUpdated event carries the old and new rates
 * 3. Mint, and verify the fee charged matches the new rate rather than the default
 * 4. Verify the fee reached the instance's fee destination
 */
async function mintingFeeIsConfigurable(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Raise the fee
  await createPsmInstance(client, testConfig)
  const newFee = 50_000
  await sendTransaction(psm.setMintingFee(internal, external, newFee).signAsync(alice))
  await client.dev.newBlock()

  // 2. MintingFeeUpdated event
  await checkSystemEvents(client, { section: 'psm', method: 'MintingFeeUpdated' }).toMatchSnapshot(
    'minting fee: MintingFeeUpdated event',
  )
  const events = await client.api.query.system.events()
  const updated = events.find(({ event }) => event.section === 'psm' && event.method === 'MintingFeeUpdated')
  assert(updated)
  const updatedData = updated.event.data as any
  expect(updatedData.oldValue.toNumber()).toBe(DEFAULT_FEE)
  expect(updatedData.newValue.toNumber()).toBe(newFee)

  // 3. Mint pays the new rate
  const feeDestBefore = await assetBalance(client, internalAssetId, dave.address)
  const mintAmount = 1_000n * UNIT
  await sendTransaction(psm.mint(internal, external, mintAmount, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  const mintEvents = await client.api.query.system.events()
  const minted = mintEvents.find(({ event }) => event.section === 'psm' && event.method === 'Minted')
  assert(minted)
  const expectedFee = (mintAmount * BigInt(newFee)) / 1_000_000n
  expect((minted.event.data as any).internalFee.toBigInt()).toBe(expectedFee)

  // 4. Fee destination credited
  expect(await assetBalance(client, internalAssetId, dave.address)).toBe(feeDestBefore + expectedFee)
}

/**
 * The redemption fee is configurable per pair and changes what a redemption returns.
 *
 * 1. Create the PSM, mint a position, and raise the redemption fee to 5%
 * 2. Verify the RedemptionFeeUpdated event carries the old and new rates
 * 3. Redeem, and verify the fee charged matches the new rate
 */
async function redemptionFeeIsConfigurable(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Position, then raise the fee
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 2_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  const newFee = 50_000
  await sendTransaction(psm.setRedemptionFee(internal, external, newFee).signAsync(alice))
  await client.dev.newBlock()

  // 2. RedemptionFeeUpdated event
  await checkSystemEvents(client, { section: 'psm', method: 'RedemptionFeeUpdated' }).toMatchSnapshot(
    'redemption fee: RedemptionFeeUpdated event',
  )
  const events = await client.api.query.system.events()
  const updated = events.find(({ event }) => event.section === 'psm' && event.method === 'RedemptionFeeUpdated')
  assert(updated)
  const updatedData = updated.event.data as any
  expect(updatedData.oldValue.toNumber()).toBe(DEFAULT_FEE)
  expect(updatedData.newValue.toNumber()).toBe(newFee)

  // 3. Redemption charges the new rate
  const redeemAmount = 500n * UNIT
  await sendTransaction(psm.redeem(internal, external, redeemAmount, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  const redeemEvents = await client.api.query.system.events()
  const redeemed = redeemEvents.find(({ event }) => event.section === 'psm' && event.method === 'Redeemed')
  assert(redeemed)
  expect((redeemed.event.data as any).internalFee.toBigInt()).toBe((redeemAmount * BigInt(newFee)) / 1_000_000n)
}

/**
 * Fees cannot be set for a pair the instance never approved.
 *
 * 1. Create a PSM approving only the primary external
 * 2. Set a minting fee naming the secondary external
 * 3. Verify AssetNotApproved
 */
async function feeForUnapprovedExternalFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance approving one external
  const setup = client.api.tx.utility.batchAll([
    psm.createPsm(
      internal,
      { system: { Signed: alice.address } },
      { system: { Signed: bob.address } },
      dave.address,
      MAX_DEBT,
      MIN_SWAP,
    ),
    psm.addExternalAsset(internal, assetLocation(primaryExternalId)),
  ])
  await sendTransaction(setup.signAsync(alice))
  await client.dev.newBlock()

  // 2. Fee for the unapproved external
  await sendTransaction(psm.setMintingFee(internal, assetLocation(secondaryExternalId), 10_000).signAsync(alice))
  await client.dev.newBlock()

  // 3. AssetNotApproved
  await expectPsmError(client, 'AssetNotApproved')
}

/// -------
/// Tests - Admin reassignment
/// -------

/**
 * Reassigning the full admin moves every administrative power to the new origin and strips the
 * old one.
 *
 * 1. Create the PSM with alice as full admin
 * 2. Reassign the full admin to charlie, and verify the FullAdminChanged event
 * 3. Verify charlie can now set the debt ceiling
 * 4. Verify alice can no longer, and is refused with BadOrigin
 */
async function fullAdminReassignmentMovesPower(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId } = testConfig
  const { alice, charlie } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with alice as full admin
  await createPsmInstance(client, testConfig)

  // 2. Hand the role to charlie
  await sendTransaction(psm.setFullAdmin(internal, { system: { Signed: charlie.address } }).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'FullAdminChanged' }).toMatchSnapshot(
    'full admin: FullAdminChanged event',
  )
  const events = await client.api.query.system.events()
  const changed = events.find(({ event }) => event.section === 'psm' && event.method === 'FullAdminChanged')
  assert(changed)
  const changedData = changed.event.data as any
  expect(changedData.oldAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(alice.address, client.config.properties.addressEncoding),
  )
  expect(changedData.newAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(charlie.address, client.config.properties.addressEncoding),
  )

  // 3. Charlie now administers
  await sendTransaction(psm.setMaxDebt(internal, 4_000n * UNIT).signAsync(charlie))
  await client.dev.newBlock()
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.unwrap().maxDebt.toBigInt()).toBe(4_000n * UNIT)

  // 4. Alice is locked out
  await sendTransaction(psm.setMaxDebt(internal, 1n * UNIT).signAsync(alice))
  await client.dev.newBlock()
  await expectBadOrigin(client)
  const unchanged = await (client.api.query as any).psm.psm(internal)
  expect(unchanged.unwrap().maxDebt.toBigInt()).toBe(4_000n * UNIT)
}

/**
 * Reassigning the emergency admin moves the breaker power and strips the old holder.
 *
 * 1. Create the PSM with bob as emergency admin
 * 2. Reassign the emergency role to charlie, and verify the EmergencyAdminChanged event
 * 3. Verify charlie can trip the breaker
 * 4. Verify bob can no longer, and is refused with BadOrigin
 */
async function emergencyAdminReassignmentMovesPower(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, bob, charlie } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with bob as emergency admin
  await createPsmInstance(client, testConfig)

  // 2. Hand the emergency role to charlie
  await sendTransaction(psm.setEmergencyAdmin(internal, { system: { Signed: charlie.address } }).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'EmergencyAdminChanged' }).toMatchSnapshot(
    'emergency admin: EmergencyAdminChanged event',
  )
  const events = await client.api.query.system.events()
  const changed = events.find(({ event }) => event.section === 'psm' && event.method === 'EmergencyAdminChanged')
  assert(changed)
  expect((changed.event.data as any).newAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(charlie.address, client.config.properties.addressEncoding),
  )

  // 3. Charlie can trip the breaker
  await sendTransaction(psm.setAssetStatus(internal, external, 'MintingDisabled').signAsync(charlie))
  await client.dev.newBlock()
  const entry = await (client.api.query as any).psm.externalAssets(internal, external)
  expect(entry.unwrap().status.isMintingDisabled).toBe(true)

  // 4. Bob is locked out
  await sendTransaction(psm.setAssetStatus(internal, external, 'AllDisabled').signAsync(bob))
  await client.dev.newBlock()
  await expectBadOrigin(client)
  const stillMintingDisabled = await (client.api.query as any).psm.externalAssets(internal, external)
  expect(stillMintingDisabled.unwrap().status.isMintingDisabled).toBe(true)
}

/// -------
/// Tests - External asset bounds
/// -------

/**
 * An instance accepts no more approved externals than the pallet's cap allows.
 *
 * 1. Create the PSM, which already approves two externals
 * 2. Approve further externals up to the cap reported by the runtime
 * 3. Verify the instance's external count sits exactly on the cap
 * 4. Approve one more, and verify TooManyAssets
 */
async function externalApprovalsAreCapped(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, foreignExternal, capFillerExternals } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with two externals already approved
  await createPsmInstance(client, testConfig)
  const cap = ((client.api.consts as any).psm.maxExternals as any).toNumber()

  // 2. Fill up to the cap
  const queue = [foreignExternal.location, ...capFillerExternals]
  const toFill = queue.slice(0, cap - 2)
  const fill = client.api.tx.utility.batchAll(toFill.map((loc) => psm.addExternalAsset(internal, loc)))
  await sendTransaction(fill.signAsync(alice))
  await client.dev.newBlock()

  // 3. Sitting exactly on the cap
  const info = await (client.api.query as any).psm.psm(internal)
  expect(info.unwrap().externalCount.toNumber()).toBe(cap)

  // 4. One more is refused
  const surplus = queue[cap - 2]
  await sendTransaction(psm.addExternalAsset(internal, surplus).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'TooManyAssets')
}

/**
 * Withdrawing an external clears the configuration attached to it, so a later re-approval starts
 * from the pallet's defaults rather than inheriting stale settings.
 *
 * 1. Create the PSM and give the primary external a non-default fee and ceiling weight
 * 2. Withdraw the external, and verify the ExternalAssetRemoved event
 * 3. Verify its fee, weight, status and debt rows are gone
 * 4. Re-approve it, and verify the fee is back to the pallet default
 */
async function removingExternalWipesConfiguration(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Non-default configuration
  await createPsmInstance(client, testConfig)
  const configure = client.api.tx.utility.batchAll([
    psm.setMintingFee(internal, external, 70_000),
    psm.setAssetCeilingWeight(internal, external, 250_000),
  ])
  await sendTransaction(configure.signAsync(alice))
  await client.dev.newBlock()
  expect(((await (client.api.query as any).psm.mintingFee(internal, external)) as any).toNumber()).toBe(70_000)

  // 2. Withdraw it
  await sendTransaction(psm.removeExternalAsset(internal, external).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'ExternalAssetRemoved' }).toMatchSnapshot(
    'remove external: ExternalAssetRemoved event',
  )
  const events = await client.api.query.system.events()
  const removed = events.find(({ event }) => event.section === 'psm' && event.method === 'ExternalAssetRemoved')
  assert(removed)
  expect((removed.event.data as any).externalAsset.eq(external)).toBe(true)

  // 3. Per-external rows cleared
  expect((await (client.api.query as any).psm.externalAssets(internal, external)).isNone).toBe(true)
  expect(((await (client.api.query as any).psm.assetCeilingWeight(internal, external)) as any).toNumber()).toBe(0)
  expect(await psmDebt(client, internal, external)).toBe(0n)

  // 4. Re-approval starts from the default fee
  await sendTransaction(psm.addExternalAsset(internal, external).signAsync(alice))
  await client.dev.newBlock()
  expect(((await (client.api.query as any).psm.mintingFee(internal, external)) as any).toNumber()).toBe(DEFAULT_FEE)
}

/**
 * Swaps stop if an external's decimals diverge from the snapshot taken when it was approved,
 * rather than silently converting at the wrong scale.
 *
 * 1. Create the PSM, which snapshots the primary external's decimals on approval
 * 2. Rewrite that asset's metadata to declare different decimals
 * 3. Attempt a mint, and verify DecimalsMismatch
 * 4. Verify no debt was recorded
 */
async function divergentDecimalsBlockSwaps(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)

  // 1. Approval snapshots decimals
  await createPsmInstance(client, testConfig)
  const snapshotted = (await (client.api.query as any).psm.externalAssets(internal, external))
    .unwrap()
    .decimals.toNumber()
  expect(snapshotted).toBe(6)

  // 2. Live metadata now disagrees
  await client.dev.setStorage({
    Assets: {
      metadata: [
        [[primaryExternalId], { deposit: 0, name: 'Tether USD', symbol: 'USDt', decimals: 8, isFrozen: false }],
      ],
    },
  })

  // 3. Mint is refused
  await sendTransaction((client.api.tx as any).psm.mint(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'DecimalsMismatch')

  // 4. No debt recorded
  expect(await psmDebt(client, internal, external)).toBe(0n)
}

/// -------
/// Tests - Aggregate ceiling
/// -------

/**
 * The instance-wide ceiling binds even when an external's own normalised ceiling would still
 * allow more, which is reachable once weights are re-cut after minting.
 *
 * 1. Create the PSM and mint both externals up to their equal halves of the ceiling
 * 2. Zero the secondary external's weight, handing the primary the whole normalised ceiling
 * 3. Verify the primary's debt is now below its own ceiling, so only the aggregate can bind
 * 4. Mint again, and verify ExceedsMaxPsmDebt
 */
async function aggregateCeilingBindsAfterReweighting(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const primary = assetLocation(primaryExternalId)
  const secondary = assetLocation(secondaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Fill both halves
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, primary, ASSET_CEILING, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await sendTransaction(psm.mint(internal, secondary, ASSET_CEILING, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  expect(await psmDebt(client, internal, primary)).toBe(ASSET_CEILING)
  expect(await psmDebt(client, internal, secondary)).toBe(ASSET_CEILING)

  // 2. Re-cut the weights in the primary's favour
  await sendTransaction(psm.setAssetCeilingWeight(internal, secondary, 0).signAsync(alice))
  await client.dev.newBlock()

  // 3. The primary now sits below its own ceiling, which is the whole instance ceiling
  expect(await psmDebt(client, internal, primary)).toBeLessThan(MAX_DEBT)

  // 4. The aggregate still binds
  await sendTransaction(psm.mint(internal, primary, MIN_SWAP, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  await expectPsmError(client, 'ExceedsMaxPsmDebt')
}

/// ----------
/// Tests - Stale administrator after ownership transfer
/// ----------

/**
 * A PSM's administrator is recorded when the instance is created and is never re-derived from
 * the internal asset's current owner, so transferring the asset does not transfer control of the
 * PSM attached to it.
 *
 * The creation gate admits the internal asset's owner, on the stated grounds that minting through
 * a PSM bypasses the asset's issuer check. That predicate is evaluated once. Authorisation for
 * every administrative call afterwards compares the caller against the stored origins, so the
 * account that created the instance keeps full control of an asset it no longer owns, and the new
 * owner cannot administer or dismantle the instance at all.
 *
 * The acquirer is deliberately an account holding no role on the instance, so the refusals below
 * are the pallet denying the current owner outright rather than a privilege tier being applied.
 *
 * 1. Create the PSM as alice, the internal asset's owner, naming herself full admin
 * 2. Transfer ownership of the internal asset to charlie
 * 3. Have charlie take the remaining asset roles, the handover a new owner would perform
 * 4. Verify alice can no longer mint the asset directly, so the assets pallet considers her revoked
 * 5. Verify alice nonetheless still passes the PSM's admin check
 * 6. Verify bob, the current owner, is refused by every administrative call including removal
 * 7. Verify alice can still mint the internal asset through the PSM, raising its total issuance
 */
async function staleAdminSurvivesOwnershipTransfer(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, charlie } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Alice owns the internal asset and creates the instance over it
  await createPsmInstance(client, testConfig)
  const ownerBefore = (await client.api.query.assets.asset(internalAssetId)).unwrap().owner.toString()
  expect(ownerBefore).toBe(encodeAddress(alice.address, client.config.properties.addressEncoding))

  // 2. Ownership moves to bob
  await sendTransaction(client.api.tx.assets.transferOwnership(internalAssetId, charlie.address).signAsync(alice))
  await client.dev.newBlock()

  const details = (await client.api.query.assets.asset(internalAssetId)).unwrap()
  expect(details.owner.toString()).toBe(encodeAddress(charlie.address, client.config.properties.addressEncoding))

  // 3. Bob takes the issuer, admin and freezer roles, completing the handover
  await sendTransaction(
    client.api.tx.assets.setTeam(internalAssetId, charlie.address, charlie.address, charlie.address).signAsync(charlie),
  )
  await client.dev.newBlock()

  const afterHandover = (await client.api.query.assets.asset(internalAssetId)).unwrap()
  expect(afterHandover.issuer.toString()).toBe(encodeAddress(charlie.address, client.config.properties.addressEncoding))

  // 4. The assets pallet now refuses alice, confirming the handover took effect
  await sendTransaction(client.api.tx.assets.mint(internalAssetId, alice.address, 1_000n * UNIT).signAsync(alice))
  await client.dev.newBlock()

  const directMintEvents = await client.api.query.system.events()
  const directMintFailure = directMintEvents.find(({ event }) => client.api.events.system.ExtrinsicFailed.is(event))
  assert(directMintFailure, 'alice should no longer be able to mint the asset directly')
  assert(client.api.events.system.ExtrinsicFailed.is(directMintFailure.event))
  const directMintError = directMintFailure.event.data.dispatchError
  assert(directMintError.isModule)
  expect(client.api.errors.assets.NoPermission.is(directMintError.asModule)).toBe(true)

  // 5. The PSM still recognises alice as its full admin
  const adminRecord = await (client.api.query as any).psm.psmAdmin(internal)
  expect(adminRecord.unwrap().fullAdmin.asSystem.asSigned.toString()).toBe(
    encodeAddress(alice.address, client.config.properties.addressEncoding),
  )

  await sendTransaction(psm.setMaxDebt(internal, 9_000n * UNIT).signAsync(alice))
  await client.dev.newBlock()
  const reconfigured = await (client.api.query as any).psm.psm(internal)
  expect(reconfigured.unwrap().maxDebt.toBigInt()).toBe(9_000n * UNIT)

  // 6. The current owner is refused, and has no way to dismantle the instance
  await sendTransaction(psm.setMaxDebt(internal, 1n * UNIT).signAsync(charlie))
  await client.dev.newBlock()
  await expectBadOrigin(client)

  await sendTransaction(psm.removePsm(internal).signAsync(charlie))
  await client.dev.newBlock()
  await expectBadOrigin(client)
  expect((await (client.api.query as any).psm.psm(internal)).isSome).toBe(true)

  // 7. Alice still mints the asset through the PSM, which does not consult the issuer
  const supplyBefore = (await client.api.query.assets.asset(internalAssetId)).unwrap().supply.toBigInt()

  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'psm', method: 'Minted' }).toMatchSnapshot(
    'stale admin: Minted event after ownership transfer',
  )
  const mintEvents = await client.api.query.system.events()
  const minted = mintEvents.find(({ event }) => event.section === 'psm' && event.method === 'Minted')
  assert(minted, 'the former owner should still be able to mint through the PSM')
  expect((minted.event.data as any).who.toString()).toBe(
    encodeAddress(alice.address, client.config.properties.addressEncoding),
  )

  const supplyAfter = (await client.api.query.assets.asset(internalAssetId)).unwrap().supply.toBigInt()
  expect(supplyAfter).toBeGreaterThan(supplyBefore)
}

/// -------
/// Tests - Conversion and state guards
/// -------

/**
 * An external whose decimals sit further from the internal asset's than the pallet permits is
 * refused at approval, before any swap can attempt the conversion.
 *
 * 1. Declare the internal asset with decimals far above the external's
 * 2. Create the PSM, which snapshots those decimals
 * 3. Approve the 6-decimal external, a gap of 25 places
 * 4. Verify DecimalsRangeExceeded and that the external was not approved
 */
async function decimalsGapBeyondRangeRejected(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Internal asset declares 31 decimals against the external's 6
  await client.dev.setStorage({
    Assets: {
      metadata: [
        [[internalAssetId], { deposit: 0, name: 'Polkadot USD', symbol: 'pUSD', decimals: 31, isFrozen: false }],
      ],
    },
  })

  // 2. Creation snapshots the internal decimals
  const createCall = psm.createPsm(
    internal,
    { system: { Signed: alice.address } },
    { system: { Signed: bob.address } },
    dave.address,
    MAX_DEBT,
    MIN_SWAP,
  )
  await sendTransaction(createCall.signAsync(alice))
  await client.dev.newBlock()
  expect((await (client.api.query as any).psm.psm(internal)).unwrap().internalDecimals.toNumber()).toBe(31)

  // 3. Approve the external, a gap of 25 places
  await sendTransaction(psm.addExternalAsset(internal, external).signAsync(alice))
  await client.dev.newBlock()

  // 4. DecimalsRangeExceeded, external not approved
  await expectPsmError(client, 'DecimalsRangeExceeded')
  expect((await (client.api.query as any).psm.externalAssets(internal, external)).isNone).toBe(true)
}

/**
 * A swap whose scaled amount does not fit the balance type is refused rather than wrapping.
 *
 * With the widest decimal gap the pallet accepts, scaling multiplies by ten to the twenty-fourth,
 * so a large enough external amount overflows a 128-bit balance.
 *
 * 1. Declare the internal asset at the top of the permitted decimal range for a 6-decimal external
 * 2. Create the PSM and approve that external
 * 3. Hand the caller an external balance large enough that scaling it overflows
 * 4. Mint, and verify ConversionOverflow with no debt recorded
 */
async function conversionOverflowRejected(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice, bob, dave } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. A gap of exactly 24 decimal places, the widest the pallet approves
  await client.dev.setStorage({
    Assets: {
      metadata: [
        [[internalAssetId], { deposit: 0, name: 'Polkadot USD', symbol: 'pUSD', decimals: 30, isFrozen: false }],
      ],
    },
  })

  // 2. Instance over that pair
  const setup = client.api.tx.utility.batchAll([
    psm.createPsm(
      internal,
      { system: { Signed: alice.address } },
      { system: { Signed: bob.address } },
      dave.address,
      MAX_DEBT,
      MIN_SWAP,
    ),
    psm.addExternalAsset(internal, external),
    psm.setAssetCeilingWeight(internal, external, HALF_WEIGHT),
  ])
  await sendTransaction(setup.signAsync(alice))
  await client.dev.newBlock()
  const events = await client.api.query.system.events()
  assert(
    events.find(({ event }) => client.api.events.utility.BatchCompleted.is(event)),
    'setup did not complete',
  )

  // 3. An external balance whose scaled value exceeds a 128-bit balance
  const overflowing = 500_000_000_000_000n
  const externalDetails = (await client.api.query.assets.asset(primaryExternalId)).unwrap()
  await client.dev.setStorage({
    Assets: {
      asset: [
        [[primaryExternalId], { ...externalDetails.toJSON(), supply: externalDetails.supply.toBigInt() + overflowing }],
      ],
      account: [[[primaryExternalId, alice.address], { balance: overflowing }]],
    },
  })

  // 4. Mint overflows the conversion
  await sendTransaction(psm.mint(internal, external, overflowing, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  await expectPsmError(client, 'ConversionOverflow')
  expect(await psmDebt(client, internal, external)).toBe(0n)
}

/**
 * An instance carrying debt cannot be dismantled, even with no external approved.
 *
 * The two conditions cannot both arise from the dispatchables, since an external can only be
 * withdrawn once its own debt is zero and withdrawal clears its debt row. The guard is therefore
 * a backstop against debt rows outliving their external, and this drives it directly.
 *
 * 1. Create the PSM and withdraw every approved external
 * 2. Leave a debt row behind for a withdrawn external
 * 3. Attempt removal
 * 4. Verify PsmHasDebt and that the instance survives
 */
async function removePsmWithOrphanedDebtFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId, secondaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with no approved externals
  await createPsmInstance(client, testConfig)
  const withdraw = client.api.tx.utility.batchAll([
    psm.removeExternalAsset(internal, external),
    psm.removeExternalAsset(internal, assetLocation(secondaryExternalId)),
  ])
  await sendTransaction(withdraw.signAsync(alice))
  await client.dev.newBlock()
  expect((await (client.api.query as any).psm.psm(internal)).unwrap().externalCount.toNumber()).toBe(0)

  // 2. A debt row outliving its external
  await client.dev.setStorage({ Psm: { psmDebt: [[[internal, external], 500n * UNIT]] } })
  expect(await psmDebt(client, internal, external)).toBe(500n * UNIT)

  // 3. Attempt removal
  await sendTransaction(psm.removePsm(internal).signAsync(alice))
  await client.dev.newBlock()

  // 4. PsmHasDebt, instance intact
  await expectPsmError(client, 'PsmHasDebt')
  expect((await (client.api.query as any).psm.psm(internal)).isSome).toBe(true)
}

/**
 * A redemption stops rather than part-paying when the reserve holds less than the tracked debt
 * says it should.
 *
 * Debt and reserve move together through the dispatchables, so this too is a backstop. Draining
 * the reserve behind the pallet's back drives it, and confirms the redemption is refused outright
 * rather than transferring whatever remains.
 *
 * 1. Create the PSM and mint, funding the reserve
 * 2. Empty the reserve's external balance, leaving the debt untouched
 * 3. Redeem within the recorded debt
 * 4. Verify the swap was refused by the pallet's reserve guard and the caller received nothing
 */
async function redeemAgainstDrainedReserveFails(client: Client<any, any>, testConfig: PsmTestConfig) {
  const { internalAssetId, primaryExternalId } = testConfig
  const { alice } = devAccounts
  const internal = assetLocation(internalAssetId)
  const external = assetLocation(primaryExternalId)
  const psm = (client.api.tx as any).psm

  // 1. Instance with a funded reserve
  await createPsmInstance(client, testConfig)
  await sendTransaction(psm.mint(internal, external, 1_000n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()
  const reserve = psmReserveAccount(client, internal)
  expect(await assetBalance(client, primaryExternalId, reserve)).toBe(1_000n * UNIT)
  const debtBefore = await psmDebt(client, internal, external)

  // 2. Drain the reserve without touching the debt
  await client.dev.setStorage({
    Assets: { account: [[[primaryExternalId, reserve], { balance: 0 }]] },
  })
  expect(await assetBalance(client, primaryExternalId, reserve)).toBe(0n)

  // 3. Redeem within the recorded debt
  const externalBefore = await assetBalance(client, primaryExternalId, alice.address)
  await sendTransaction(psm.redeem(internal, external, 100n * UNIT, ANY_FEE).signAsync(alice))
  await client.dev.newBlock()

  // 4. Refused by the reserve guard, nothing paid out, debt untouched
  await expectPsmError(client, 'Unexpected')
  expect(await assetBalance(client, primaryExternalId, alice.address)).toBe(externalBefore)
  expect(await psmDebt(client, internal, external)).toBe(debtBefore)
}

/// ----------
/// Test tree
/// ----------

export function psmE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: PsmTestConfig): RootTestTree {
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
      // Every test starts from assets present but no PSM, so instance creation is itself
      // under test rather than assumed.
      await injectAssets(client, testConfig)
    },
    afterAll: async () => {
      await client.api.disconnect().catch(() => {})
      await client.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'describe',
        label: 'Instance lifecycle',
        children: [
          {
            kind: 'test',
            label: 'create PSM as internal asset owner — instance recorded, deposit held',
            testFn: () => createPsmAsAssetOwner(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM by root — no deposit taken, named admin administers',
            testFn: () => createPsmByRootTakesNoDeposit(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM with zero minimum swap — ZeroMinSwapAmount',
            testFn: () => createPsmZeroMinSwapFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM as non-owner — BadOrigin',
            testFn: () => createPsmByNonOwnerFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM twice for one internal asset — PsmAlreadyExists',
            testFn: () => createPsmTwiceFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM over an unregistered asset — BadOrigin, no owner to match',
            testFn: () => createPsmForMissingAssetFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'create PSM without funds for the deposit — no instance recorded',
            testFn: () => createPsmWithoutDepositFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'remove PSM with approved externals — blocked, then succeeds once withdrawn',
            testFn: () => removePsmRequiresNoExternals(client, testConfig),
          },
          {
            kind: 'test',
            label: 'remove PSM as non-admin — BadOrigin',
            testFn: () => removePsmByNonAdminFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'remove PSM as emergency admin — InsufficientPrivilege',
            testFn: () => removePsmByEmergencyAdminFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'remove PSM twice — PsmNotFound',
            testFn: () => removePsmTwiceFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'External asset management',
        children: [
          {
            kind: 'test',
            label: 'addExternalAsset — decimals snapshotted, external counted',
            testFn: () => addExternalAssetRecordsDecimals(client, testConfig),
          },
          {
            kind: 'test',
            label: 'addExternalAsset twice — AssetAlreadyApproved',
            testFn: () => addExternalAssetTwiceFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'addExternalAsset for unregistered asset — AssetDoesNotExist',
            testFn: () => addNonexistentExternalFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'addExternalAsset beyond the cap — TooManyAssets',
            testFn: () => externalApprovalsAreCapped(client, testConfig),
          },
          {
            kind: 'test',
            label: 'removeExternalAsset while carrying debt — AssetHasDebt',
            testFn: () => removeExternalWithDebtFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'removeExternalAsset — per-external configuration wiped, re-approval defaults',
            testFn: () => removingExternalWipesConfiguration(client, testConfig),
          },
          {
            kind: 'test',
            label: 'external decimals diverge from snapshot — DecimalsMismatch',
            testFn: () => divergentDecimalsBlockSwaps(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Swaps',
        children: [
          {
            kind: 'test',
            label: 'mint — collateral to reserve, internal to caller, fee to destination',
            testFn: () => mintAgainstExternal(client, testConfig),
          },
          {
            kind: 'test',
            label: 'redeem — reserve released, debt reduced by burned amount',
            testFn: () => redeemBackToExternal(client, testConfig),
          },
          {
            kind: 'test',
            label: 'mint below minimum swap — BelowMinimumSwap',
            testFn: () => mintBelowMinimumFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'mint with fee cap below configured fee — FeeTooHigh',
            testFn: () => mintAboveMaxFeeFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'mint unapproved external — UnsupportedAsset',
            testFn: () => mintUnapprovedExternalFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'mint without an instance — PsmNotFound',
            testFn: () => mintWithoutInstanceFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'redeem below minimum swap — BelowMinimumSwap',
            testFn: () => redeemBelowMinimumFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'redeem with fee cap below configured fee — FeeTooHigh',
            testFn: () => redeemAboveMaxFeeFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'redeem into unapproved external — UnsupportedAsset',
            testFn: () => redeemUnapprovedExternalFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'redeem beyond the debt an external carries — InsufficientReserve',
            testFn: () => redeemBeyondDebtFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Fee configuration',
        children: [
          {
            kind: 'test',
            label: 'setMintingFee — event emitted, new rate charged to fee destination',
            testFn: () => mintingFeeIsConfigurable(client, testConfig),
          },
          {
            kind: 'test',
            label: 'setRedemptionFee — event emitted, new rate charged on redemption',
            testFn: () => redemptionFeeIsConfigurable(client, testConfig),
          },
          {
            kind: 'test',
            label: 'set fee for unapproved external — AssetNotApproved',
            testFn: () => feeForUnapprovedExternalFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Admin reassignment',
        children: [
          {
            kind: 'test',
            label: 'setFullAdmin — power moves to the new origin, old one locked out',
            testFn: () => fullAdminReassignmentMovesPower(client, testConfig),
          },
          {
            kind: 'test',
            label: 'setEmergencyAdmin — breaker power moves, old holder locked out',
            testFn: () => emergencyAdminReassignmentMovesPower(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Debt ceilings',
        children: [
          {
            kind: 'test',
            label: 'mint to normalised per-asset ceiling — further mint ExceedsMaxPsmDebt',
            testFn: () => perAssetCeilingIsEnforced(client, testConfig),
          },
          {
            kind: 'test',
            label: 'zero ceiling weight — external closed, remainder reweighted',
            testFn: () => zeroWeightClosesExternal(client, testConfig),
          },
          {
            kind: 'test',
            label: 'setMaxDebt below outstanding debt — minting paused, redeems work',
            testFn: () => loweringCeilingPausesMinting(client, testConfig),
          },
          {
            kind: 'test',
            label: 'aggregate ceiling binds after reweighting — ExceedsMaxPsmDebt',
            testFn: () => aggregateCeilingBindsAfterReweighting(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Circuit breaker and privilege',
        children: [
          {
            kind: 'test',
            label: 'MintingDisabled — mint stopped, redeem allowed',
            testFn: () => mintingDisabledStopsMintOnly(client, testConfig),
          },
          {
            kind: 'test',
            label: 'AllDisabled — both directions stopped',
            testFn: () => allDisabledStopsBothDirections(client, testConfig),
          },
          {
            kind: 'test',
            label: 'emergency admin sets breaker but not ceiling — InsufficientPrivilege',
            testFn: () => emergencyAdminIsLimitedToBreaker(client, testConfig),
          },
          {
            kind: 'test',
            label: 'account holding neither admin role — BadOrigin',
            testFn: () => nonAdminCannotAdminister(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Decimal scaling',
        children: [
          {
            kind: 'test',
            label: 'higher-decimal external — debt scaled down, redemption scaled up',
            testFn: () => higherDecimalExternalScales(client, testConfig),
          },
          {
            kind: 'test',
            label: 'swap that scales to zero internal units — AmountTooSmallAfterConversion',
            testFn: () => dustSwapIsRejected(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Conversion and state guards',
        children: [
          {
            kind: 'test',
            label: 'decimal gap beyond the permitted range — DecimalsRangeExceeded',
            testFn: () => decimalsGapBeyondRangeRejected(client, testConfig),
          },
          {
            kind: 'test',
            label: 'scaled amount exceeding the balance type — ConversionOverflow',
            testFn: () => conversionOverflowRejected(client, testConfig),
          },
          {
            kind: 'test',
            label: 'debt row outliving its external — PsmHasDebt blocks removal',
            testFn: () => removePsmWithOrphanedDebtFails(client, testConfig),
          },
          {
            kind: 'test',
            label: 'reserve drained below tracked debt — redemption refused outright',
            testFn: () => redeemAgainstDrainedReserveFails(client, testConfig),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'Stale administrator after ownership transfer',
        children: [
          {
            kind: 'test',
            label: 'former owner keeps full admin and mint; current owner cannot administer or remove',
            testFn: () => staleAdminSurvivesOwnershipTransfer(client, testConfig),
          },
        ],
      },
    ],
  }
}
