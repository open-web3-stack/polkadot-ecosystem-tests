import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccounts } from '@e2e-test/networks'

import type { SubmittableExtrinsic } from '@polkadot/api/types'

import { assert, expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import { setupNetworks } from './setup.js'
import type { Client, RootTestTree } from './types.js'

// USDT on Asset Hub (asset ID 1984), expressed as an XCM V4 versioned asset.
// Keys use camelCase to match the PJS toJSON() output used in assertions.
const ASSET_KIND = {
  v4: {
    location: {
      parents: 0,
      interior: {
        x2: [{ palletInstance: 50 }, { generalIndex: 1984 }],
      },
    },
    assetId: {
      parents: 0,
      interior: {
        x2: [{ palletInstance: 50 }, { generalIndex: 1984 }],
      },
    },
  },
}

// An asset kind that is never seeded into storage, used to test UnknownAssetKind errors.
const UNKNOWN_ASSET_KIND = {
  v4: {
    location: {
      parents: 0,
      interior: {
        x2: [{ palletInstance: 50 }, { generalIndex: 1337 }],
      },
    },
    assetId: {
      parents: 0,
      interior: {
        x2: [{ palletInstance: 50 }, { generalIndex: 1337 }],
      },
    },
  },
}

// FixedU128 representation of 1.0 (1 * 10^18)
const RATE = '1000000000000000000'
// FixedU128 representation of 2.0 (2 * 10^18)
const UPDATED_RATE = '2000000000000000000'

/**
 * Submit a call signed by Alice and assert it fails with BadOrigin.
 * Used to verify that extrinsics requiring privileged origin reject regular signers.
 */
async function assertSignedOriginRejected(
  client: Client<any, any>,
  call: SubmittableExtrinsic<'promise'>,
): Promise<void> {
  await sendTransaction(call.signAsync(defaultAccounts.alice))
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const [failedEvent] = (events as any).filter((record: any) =>
    client.api.events.system.ExtrinsicFailed.is(record.event),
  )
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent.event))
  expect(failedEvent.event.data.dispatchError.isBadOrigin).toBe(true)
}

/**
 * Schedule a call with Root origin and assert it fails with the given module error.
 * Used to verify pallet-level guard conditions (e.g. AlreadyExists, UnknownAssetKind).
 */
async function assertRootCallFails(
  client: Client<any, any>,
  call: SubmittableExtrinsic<'promise'>,
  expectedError: { is: (error: any) => boolean },
): Promise<void> {
  await scheduleInlineCallWithOrigin(
    client,
    call.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const events = await client.api.query.system.events()
  const [dispatchedEvent] = (events as any).filter((record: any) =>
    client.api.events.scheduler.Dispatched.is(record.event),
  )
  assert(client.api.events.scheduler.Dispatched.is(dispatchedEvent.event))
  const dispatchError = dispatchedEvent.event.data.result.asErr
  assert(dispatchError.isModule)
  expect(expectedError.is(dispatchError.asModule)).toBe(true)
}

/**
 * Schedule a call with Root origin and advance one block.
 */
async function scheduleRootCall(client: Client<any, any>, call: SubmittableExtrinsic<'promise'>): Promise<void> {
  await scheduleInlineCallWithOrigin(
    client,
    call.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()
}

export async function assetRateCreateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const api = client.api

  // Signed origin cannot create asset rate
  await assertSignedOriginRejected(client, api.tx.assetRate.create(ASSET_KIND as any, RATE))

  // Root origin can create a rate
  await scheduleRootCall(client, api.tx.assetRate.create(ASSET_KIND as any, RATE))

  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateCreated' })
    .redact()
    .toMatchSnapshot('AssetRateCreated event')

  const subEvents = await api.query.system.events()
  const [rateCreatedEvent] = (subEvents as any).filter((record: any) =>
    api.events.assetRate.AssetRateCreated.is(record.event),
  )
  assert(api.events.assetRate.AssetRateCreated.is(rateCreatedEvent.event))
  const rateCreatedEventData = rateCreatedEvent.event.data
  expect(rateCreatedEventData.assetKind.toJSON()).toEqual(ASSET_KIND)
  expect(rateCreatedEventData.rate.toString()).toBe(RATE)

  const storedRate = await api.query.assetRate.conversionRateToNative(ASSET_KIND as any)
  expect(storedRate.toString()).toBe(RATE)

  // Duplicate create fails with AlreadyExists
  await assertRootCallFails(
    client,
    api.tx.assetRate.create(ASSET_KIND as any, RATE),
    api.errors.assetRate.AlreadyExists,
  )

  const duplicateEvents = await api.query.system.events()
  const assetRateCreatedEvents = (duplicateEvents as any).filter((record: any) =>
    api.events.assetRate.AssetRateCreated.is(record.event),
  )
  expect(assetRateCreatedEvents.length).toBe(0)
}

export async function assetRateUpdateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const api = client.api

  await client.dev.setStorage({
    AssetRate: {
      ConversionRateToNative: [[[ASSET_KIND], RATE]],
    },
  })

  // Signed origin cannot update asset rate
  await assertSignedOriginRejected(client, api.tx.assetRate.update(ASSET_KIND as any, UPDATED_RATE))

  // Updating an unknown asset kind fails with UnknownAssetKind
  await assertRootCallFails(
    client,
    api.tx.assetRate.update(UNKNOWN_ASSET_KIND as any, UPDATED_RATE),
    api.errors.assetRate.UnknownAssetKind,
  )

  // Root origin can update an existing rate
  await scheduleRootCall(client, api.tx.assetRate.update(ASSET_KIND as any, UPDATED_RATE))

  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateUpdated' })
    .redact()
    .toMatchSnapshot('AssetRateUpdated event')

  const updatedRate = await api.query.assetRate.conversionRateToNative(ASSET_KIND as any)
  expect(updatedRate.toString()).toBe(UPDATED_RATE)
}

export async function assetRateRemoveTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const api = client.api

  await client.dev.setStorage({
    AssetRate: {
      ConversionRateToNative: [[[ASSET_KIND], RATE]],
    },
  })

  // Signed origin cannot remove asset rate
  await assertSignedOriginRejected(client, api.tx.assetRate.remove(ASSET_KIND as any))

  // Removing an unknown asset kind fails with UnknownAssetKind
  await assertRootCallFails(
    client,
    api.tx.assetRate.remove(UNKNOWN_ASSET_KIND as any),
    api.errors.assetRate.UnknownAssetKind,
  )

  // Root origin can remove an existing rate
  await scheduleRootCall(client, api.tx.assetRate.remove(ASSET_KIND as any))

  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateRemoved' })
    .redact()
    .toMatchSnapshot('AssetRateRemoved event')

  const removeEvents = await api.query.system.events()
  const [rateRemovedEvent] = (removeEvents as any).filter((record: any) =>
    api.events.assetRate.AssetRateRemoved.is(record.event),
  )
  assert(api.events.assetRate.AssetRateRemoved.is(rateRemovedEvent.event))
  expect(rateRemovedEvent.event.data.assetKind.toJSON()).toEqual(ASSET_KIND)

  const removedRate = await api.query.assetRate.conversionRateToNative(ASSET_KIND as any)
  expect(removedRate.isEmpty).toBe(true)
}

export function baseAssetRateE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'assetRate.create',
        children: [
          {
            kind: 'test',
            label: 'rejects signed origin and creates a rate with root, rejecting duplicates',
            testFn: async () => await assetRateCreateTest(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'assetRate.update',
        children: [
          {
            kind: 'test',
            label: 'rejects signed origin and updates an existing rate with root, rejecting unknown assets',
            testFn: async () => await assetRateUpdateTest(chain),
          },
        ],
      },
      {
        kind: 'describe',
        label: 'assetRate.remove',
        children: [
          {
            kind: 'test',
            label: 'rejects signed origin and removes an existing rate with root, rejecting unknown assets',
            testFn: async () => await assetRateRemoveTest(chain),
          },
        ],
      },
    ],
  }
}
