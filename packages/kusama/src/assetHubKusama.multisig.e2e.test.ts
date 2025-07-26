import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseMultisigE2Etests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseMultisigE2Etests(assetHubKusama, { testSuiteName: 'AssetHubKusama Multisig', addressEncoding: 2 }))
