import { coretimeKusama } from '@e2e-test/networks/chains'
import { CoretimeProxyTypes, fullProxyE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Coretime Proxy',
  addressEncoding: 2,
  relayOrPara: 'Para',
  asyncBacking: 'Enabled',
}

registerTestTree(fullProxyE2ETests(coretimeKusama, testConfig, CoretimeProxyTypes))
