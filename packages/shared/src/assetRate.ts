import type { Chain } from '@e2e-test/networks'

import { expect } from 'vitest'

import { checkSystemEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'
import { setupNetworks } from './setup.js'
import type { RootTestTree } from './types.js'

// USDT on Asset Hub (asset ID 1984), expressed as an XCM V4 versioned asset.
const ASSET_KIND = {
  V4: {
    location: {
      parents: 0,
      interior: {
        X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }],
      },
    },
    assetId: {
      parents: 0,
      interior: {
        X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }],
      },
    },
  },
}
// FixedU128 representation of 1.0 (1 * 10^18)
const RATE = '1000000000000000000'

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

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'cannot create an existing rate',
  )

  // Assert no AssetRateCreated event was emitted
  const assetRateCreatedEvents = (events as any).filter((record: any) =>
    api.events.assetRate.AssetRateCreated.is(record.event),
  )
  expect(assetRateCreatedEvents.length).toBe(0)
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
