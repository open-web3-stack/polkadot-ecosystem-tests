import { assetHubPaseo } from '@e2e-test/networks/chains'
import { multisigE2ETests } from '@e2e-test/shared'

multisigE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Multisig', addressEncoding: 0 })
