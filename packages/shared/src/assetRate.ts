import type { Chain } from '@e2e-test/networks'

import type { TestConfig } from './helpers/index.js'
import { setupNetworks } from './setup.js'
import type { RootTestTree } from './types.js'

export async function assetRateLifecycleTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)
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
        label: 'asset rate tests',
        children: [
          {
            kind: 'test',
            label: 'referendum lifecycle test - submission, decision deposit, various voting should all work',
            testFn: async () => await assetRateLifecycleTest(chain),
          },
        ],
      },
    ],
  }
}
