import type { Chain } from '@e2e-test/networks'

import type { TestConfig } from './helpers/index.js'
import { setupNetworks } from './index.js'
import type { RootTestTree } from './types.js'

export async function parasRegistrationE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const paras = await client.api.query.registrar.paras(1000)
  console.log('paras', paras.toJSON())
}

export async function parasRegistrarLifecycleE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const paras = await client.api.query.registrar.paras(1000)
  console.log('paras', paras.toJSON())
}

export function parasRegistrarE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: testConfig.testSuiteName,
        children: [
          {
            kind: 'test',
            label: 'paras registrar - registration functions',
            testFn: async () => await parasRegistrationE2ETest(chain),
          },
          {
            kind: 'test',
            label: 'paras registrar - lifecycle functions',
            testFn: async () => await parasRegistrarLifecycleE2ETest(chain),
          },
        ],
      },
    ],
  }
}
