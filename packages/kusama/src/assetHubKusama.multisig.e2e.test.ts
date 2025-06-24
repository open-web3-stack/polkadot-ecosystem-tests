import { assetHubKusama } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(assetHubKusama, { testSuiteName: 'AssetHubKusama Multisig', addressEncoding: 2 })
