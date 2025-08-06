import { coretimeKusama } from '@e2e-test/networks/chains'

import { baseProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { CoretimeProxyTypes } from '@e2e-test/shared'

registerTestTree(
  baseProxyE2ETests(coretimeKusama, { testSuiteName: 'Kusama Coretime Proxy', addressEncoding: 2 }, CoretimeProxyTypes),
)
