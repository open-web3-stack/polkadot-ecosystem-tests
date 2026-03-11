import { sendTransaction } from '@acala-network/chopsticks-testing'

import type { Chain } from '@e2e-test/networks'
import { type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { TestConfig } from './helpers/index.js'

export async function configurationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

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
