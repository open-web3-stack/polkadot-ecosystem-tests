import { coretimeKusama } from '@e2e-test/networks/chains'

import { proxyE2ETests } from '@e2e-test/shared'
import { CoretimeProxyTypes } from '@e2e-test/shared/helpers'

proxyE2ETests(coretimeKusama, { testSuiteName: 'Kusama Coretime Proxy', addressEncoding: 2 }, CoretimeProxyTypes)
