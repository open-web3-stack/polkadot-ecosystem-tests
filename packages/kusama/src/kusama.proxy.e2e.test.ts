import { kusama } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { KusamaProxyTypes } from '@e2e-test/shared'

proxyE2ETests(kusama, { testSuiteName: 'Kusama Proxy', addressEncoding: 2 }, KusamaProxyTypes)
