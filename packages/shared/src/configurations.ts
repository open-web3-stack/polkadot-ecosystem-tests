import type { Chain } from '@e2e-test/networks'
import { check, type RootTestTree, scheduleInlineCallWithOrigin, setupNetworks } from '@e2e-test/shared'

import type { u32, Vec } from '@polkadot/types'
import type { PolkadotRuntimeParachainsConfigurationHostConfiguration } from '@polkadot/types/lookup'
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

  const validationUpgradeCooldown = 13300
  const setValidationUpgradeCooldown =
    client.api.tx.configuration.setValidationUpgradeCooldown(validationUpgradeCooldown)

  await scheduleInlineCallWithOrigin(
    client,
    setValidationUpgradeCooldown.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  expect(pendingConfigs[0][1].validationUpgradeCooldown.toNumber()).toBe(validationUpgradeCooldown)

  // Core Configuration
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
