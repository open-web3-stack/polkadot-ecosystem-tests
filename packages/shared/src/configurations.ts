import type { Chain } from '@e2e-test/networks'
import { check, type RootTestTree, scheduleInlineCallListWithSameOrigin, setupNetworks } from '@e2e-test/shared'

import type { u32, Vec } from '@polkadot/types'
import type {
  PolkadotPrimitivesV8SchedulerParams,
  PolkadotRuntimeParachainsConfigurationHostConfiguration,
} from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'

import { expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'

export async function configurationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const activeConfig = await client.api.query.configuration.activeConfig()
  await check(activeConfig).redact({ number: 1 }).toMatchSnapshot('initial active configuration')

  let pendingConfigs = await client.api.query.configuration.pendingConfigs()
  expect(pendingConfigs.toJSON()).toEqual([])

  // Core configuration
  const validationUpgradeCooldown = 13300
  const validationUpgradeDelay = 700
  const codeRetentionPeriod = 14300
  const maxCodeSize = 3000000
  const maxPovSize = 10000000
  const maxHeadDataSize = 20000
  const numCores = 50

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setValidationUpgradeCooldown(validationUpgradeCooldown).method.toHex(),
      client.api.tx.configuration.setValidationUpgradeDelay(validationUpgradeDelay).method.toHex(),
      client.api.tx.configuration.setCodeRetentionPeriod(codeRetentionPeriod).method.toHex(),
      client.api.tx.configuration.setMaxCodeSize(maxCodeSize).method.toHex(),
      client.api.tx.configuration.setMaxPovSize(maxPovSize).method.toHex(),
      client.api.tx.configuration.setMaxHeadDataSize(maxHeadDataSize).method.toHex(),
      client.api.tx.configuration.setCoretimeCores(numCores).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const pending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(pending.validationUpgradeCooldown.toNumber()).toBe(validationUpgradeCooldown)
  expect(pending.validationUpgradeDelay.toNumber()).toBe(validationUpgradeDelay)
  expect(pending.codeRetentionPeriod.toNumber()).toBe(codeRetentionPeriod)
  expect(pending.maxCodeSize.toNumber()).toBe(maxCodeSize)
  expect(pending.maxPovSize.toNumber()).toBe(maxPovSize)
  expect(pending.maxHeadDataSize.toNumber()).toBe(maxHeadDataSize)
  expect((pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams).numCores.toNumber()).toBe(numCores)
}

/// ----------
/// Test Trees
/// ----------

export const configurationsE2ETests = <
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
>(
  chain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
): RootTestTree => ({
  kind: 'describe',
  label: testConfig.testSuiteName,
  children: [
    {
      kind: 'describe',
      label: 'configuration tests',
      children: [
        {
          kind: 'test',
          label: 'configurations test - can read and update configurations',
          testFn: async () => await configurationTest(chain),
        },
      ],
    },
  ],
})
