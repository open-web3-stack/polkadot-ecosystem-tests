import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, captureSnapshot, createNetworks, testAccounts } from '@e2e-test/networks'
import type { Client, RootTestTree } from '@e2e-test/shared'

import { stringToU8a, u8aConcat } from '@polkadot/util'
import { blake2AsU8a, encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkSystemEvents, type TestConfig } from './helpers/index.js'

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
            label: 'remove PSM with approved externals — blocked, then succeeds once withdrawn',
            testFn: () => removePsmRequiresNoExternals(client, testConfig),
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
            label: 'removeExternalAsset while carrying debt — AssetHasDebt',
            testFn: () => removeExternalWithDebtFails(client, testConfig),
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
    ],
  }
}
