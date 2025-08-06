import { kusama } from '@e2e-test/networks/chains'

import { fullProxyE2ETests, registerTestTree } from '@e2e-test/shared'
import { KusamaProxyTypes } from '@e2e-test/shared'

registerTestTree(fullProxyE2ETests(kusama, { testSuiteName: 'Kusama Proxy', addressEncoding: 2 }, KusamaProxyTypes))
