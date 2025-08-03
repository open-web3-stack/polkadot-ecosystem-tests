import { coretimeKusama } from '@e2e-test/networks/chains'
import { CoretimeProxyTypes, proxyE2ETests } from '@e2e-test/shared'

proxyE2ETests(coretimeKusama, { testSuiteName: 'Kusama Coretime Proxy', addressEncoding: 2 }, CoretimeProxyTypes)
