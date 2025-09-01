import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { baseTreasuryE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseTreasuryE2ETests(polkadot, assetHubPolkadot, { testSuiteName: 'Polkadot Treasury', addressEncoding: 0 }),
)
