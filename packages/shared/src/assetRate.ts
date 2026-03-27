import type { Chain } from '@e2e-test/networks'

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
// FixedU128 representation of 1.0 (1 * 10^18)
const RATE = '1000000000000000000'
// FixedU128 representation of 2.0 (2 * 10^18)
const UPDATED_RATE = '2000000000000000000'

export async function assetRateCreateLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
  const api = client.api

  const createCall = api.tx.assetRate.create(ASSET_KIND as any, RATE)
  await scheduleInlineCallWithOrigin(
    client,
    createCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Assert AssetRateCreated event was emitted
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

  const events = await api.query.system.events()

  // Scheduled calls surface failures via scheduler.Dispatched, not system.ExtrinsicFailed
  const [dispatchedEvent] = (events as any).filter((record: any) => api.events.scheduler.Dispatched.is(record.event))
  assert(api.events.scheduler.Dispatched.is(dispatchedEvent.event))
  const dispatchError = dispatchedEvent.event.data.result.asErr
  assert(dispatchError.isModule)
  expect(api.errors.assetRate.AlreadyExists.is(dispatchError.asModule)).toBe(true)

  // Assert no AssetRateCreated event was emitted
  const assetRateCreatedEvents = (events as any).filter((record: any) =>
    api.events.assetRate.AssetRateCreated.is(record.event),
  )
  expect(assetRateCreatedEvents.length).toBe(0)

  // Trying to update unknown rate should fail
  const unknownAssetKind = {
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
  const unknownUpdateCall = api.tx.assetRate.update(unknownAssetKind as any, UPDATED_RATE)
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

  // Update the rate for the same asset — should succeed since the entry now exists
  const updateCall = api.tx.assetRate.update(ASSET_KIND as any, UPDATED_RATE)
  await scheduleInlineCallWithOrigin(
    client,
    updateCall.method.toHex(),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Assert AssetRateUpdated event was emitted
  await checkSystemEvents(client, { section: 'assetRate', method: 'AssetRateUpdated' })
    .redact()
    .toMatchSnapshot('AssetRateUpdated event')

  // Assert storage value reflects the new rate
  const updatedRate = await api.query.assetRate.conversionRateToNative(ASSET_KIND as any)
  expect(updatedRate.toString()).toBe(UPDATED_RATE)
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
            label: 'creates a conversion rate and emits AssetRateCreated event',
            testFn: async () => await assetRateCreateLifecycleTest(chain),
          },
        ],
      },
    ],
  }
}
