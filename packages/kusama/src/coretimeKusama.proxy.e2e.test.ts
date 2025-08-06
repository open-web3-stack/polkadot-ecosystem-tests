import { coretimeKusama } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { CoretimeProxyTypes } from '@e2e-test/shared'

registerTestTree(
  fullProxyE2ETests(coretimeKusama, { testSuiteName: 'Kusama Coretime Proxy', addressEncoding: 2 }, CoretimeProxyTypes),
)
