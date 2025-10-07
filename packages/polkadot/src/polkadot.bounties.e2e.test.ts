import { polkadot } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseBountiesE2ETests(polkadot, { testSuiteName: 'Polkadot Bounties', addressEncoding: 0 }))
