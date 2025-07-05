import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { treasuryE2ETests } from '@e2e-test/shared'

treasuryE2ETests(polkadot, assetHubPolkadot, { testSuiteName: 'Polkadot Treasury', addressEncoding: 0 })
