import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccounts } from '@e2e-test/networks'

import { assert, expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import { setupNetworks } from './setup.js'
import type { RootTestTree } from './types.js'

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

export async function assetRateCreateTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const api = client.api

  // Assert that signed origin cannot create asset rate
  await sendTransaction(api.tx.assetRate.create(ASSET_KIND as any, RATE).signAsync(defaultAccounts.alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cannot create rate with signed origin',
  )

  const signedCreateEvents = await api.query.system.events()
  const [signedCreateFailed] = (signedCreateEvents as any).filter((record: any) =>
    api.events.system.ExtrinsicFailed.is(record.event),
  )
  assert(api.events.system.ExtrinsicFailed.is(signedCreateFailed.event))
  expect(signedCreateFailed.event.data.dispatchError.isBadOrigin).toBe(true)

  // Root origin can create a rate
  const createCall = api.tx.assetRate.create(ASSET_KIND as any, RATE)
  await scheduleInlineCallWithOrigin(
    client,
    createCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateCreated' })
    .redact()
    .toMatchSnapshot('AssetRateCreated event')

  const subEvents = await client.api.query.system.events()
  const [rateCreatedEvent] = subEvents.filter((record) => {
    const { event } = record
    return event.section === 'assetRate' && event.method === 'AssetRateCreated'
  })
  assert(client.api.events.assetRate.AssetRateCreated.is(rateCreatedEvent.event))
  const rateCreatedEventData = rateCreatedEvent.event.data
  expect(rateCreatedEventData.assetKind.toJSON()).toEqual(ASSET_KIND)
  expect(rateCreatedEventData.rate.toString()).toBe(RATE)

  // Assert storage value was set
  const storedRate = await api.query.assetRate.conversionRateToNative(ASSET_KIND as any)
  expect(storedRate.toString()).toBe(RATE)

  // Attempt to create a rate for the same asset — should fail with AlreadyExists
  const duplicateCreateCall = api.tx.assetRate.create(ASSET_KIND as any, RATE)
  await scheduleInlineCallWithOrigin(
    client,
    duplicateCreateCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const duplicateEvents = await api.query.system.events()
  const [dispatchedEvent] = (duplicateEvents as any).filter((record: any) =>
    api.events.scheduler.Dispatched.is(record.event),
  )
  assert(api.events.scheduler.Dispatched.is(dispatchedEvent.event))
  const dispatchError = dispatchedEvent.event.data.result.asErr
  assert(dispatchError.isModule)
  expect(api.errors.assetRate.AlreadyExists.is(dispatchError.asModule)).toBe(true)

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

  // Seed an existing rate so update and remove tests have something to work with
  await client.dev.setStorage({
    AssetRate: {
      ConversionRateToNative: [[[ASSET_KIND], RATE]],
    },
  })

  // Assert that signed origin cannot update asset rate
  await sendTransaction(api.tx.assetRate.update(ASSET_KIND as any, UPDATED_RATE).signAsync(defaultAccounts.alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cannot update rate with signed origin',
  )

  const signedUpdateEvents = await api.query.system.events()
  const [signedUpdateFailed] = (signedUpdateEvents as any).filter((record: any) =>
    api.events.system.ExtrinsicFailed.is(record.event),
  )
  assert(api.events.system.ExtrinsicFailed.is(signedUpdateFailed.event))
  expect(signedUpdateFailed.event.data.dispatchError.isBadOrigin).toBe(true)

  // Updating an unknown asset kind should fail with UnknownAssetKind
  const unknownUpdateCall = api.tx.assetRate.update(UNKNOWN_ASSET_KIND as any, UPDATED_RATE)
  await scheduleInlineCallWithOrigin(
    client,
    unknownUpdateCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const unknownUpdateEvents = await api.query.system.events()
  const [unknownDispatchedEvent] = (unknownUpdateEvents as any).filter((record: any) =>
    api.events.scheduler.Dispatched.is(record.event),
  )
  assert(api.events.scheduler.Dispatched.is(unknownDispatchedEvent.event))
  const unknownDispatchError = unknownDispatchedEvent.event.data.result.asErr
  assert(unknownDispatchError.isModule)
  expect(api.errors.assetRate.UnknownAssetKind.is(unknownDispatchError.asModule)).toBe(true)

  // Root origin can update an existing rate
  const updateCall = api.tx.assetRate.update(ASSET_KIND as any, UPDATED_RATE)
  await scheduleInlineCallWithOrigin(
    client,
    updateCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

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

  // Seed an existing rate so the remove test has something to work with
  await client.dev.setStorage({
    AssetRate: {
      ConversionRateToNative: [[[ASSET_KIND], RATE]],
    },
  })

  // Assert that signed origin cannot remove asset rate
  await sendTransaction(api.tx.assetRate.remove(ASSET_KIND as any).signAsync(defaultAccounts.alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cannot remove rate with signed origin',
  )

  const signedRemoveEvents = await api.query.system.events()
  const [signedRemoveFailed] = (signedRemoveEvents as any).filter((record: any) =>
    api.events.system.ExtrinsicFailed.is(record.event),
  )
  assert(api.events.system.ExtrinsicFailed.is(signedRemoveFailed.event))
  expect(signedRemoveFailed.event.data.dispatchError.isBadOrigin).toBe(true)

  // Removing an unknown asset kind should fail with UnknownAssetKind
  const unknownRemoveCall = api.tx.assetRate.remove(UNKNOWN_ASSET_KIND as any)
  await scheduleInlineCallWithOrigin(
    client,
    unknownRemoveCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const unknownRemoveEvents = await api.query.system.events()
  const [unknownRemoveDispatchedEvent] = (unknownRemoveEvents as any).filter((record: any) =>
    api.events.scheduler.Dispatched.is(record.event),
  )
  assert(api.events.scheduler.Dispatched.is(unknownRemoveDispatchedEvent.event))
  const unknownRemoveError = unknownRemoveDispatchedEvent.event.data.result.asErr
  assert(unknownRemoveError.isModule)
  expect(api.errors.assetRate.UnknownAssetKind.is(unknownRemoveError.asModule)).toBe(true)

  // Root origin can remove an existing rate
  const removeCall = api.tx.assetRate.remove(ASSET_KIND as any)
  await scheduleInlineCallWithOrigin(
    client,
    removeCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateRemoved' })
    .redact()
    .toMatchSnapshot('AssetRateRemoved event')

  const removeEvents = await api.query.system.events()
  const [rateRemovedEvent] = (removeEvents as any).filter((record: any) =>
    api.events.assetRate.AssetRateRemoved.is(record.event),
  )
  assert(api.events.assetRate.AssetRateRemoved.is(rateRemovedEvent.event))
  expect(rateRemovedEvent.event.data.assetKind.toJSON()).toEqual(ASSET_KIND)

  // Assert storage entry was deleted
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
