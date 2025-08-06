import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(assetHubPolkadot, { testSuiteName: 'AssetHubPolkadot Multisig', addressEncoding: 0 })
