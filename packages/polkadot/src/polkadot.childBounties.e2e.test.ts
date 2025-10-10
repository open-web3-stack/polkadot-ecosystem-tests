import { polkadot } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseChildBountiesE2ETests(polkadot, { testSuiteName: 'Polkadot Child Bounties', addressEncoding: 0 }))
