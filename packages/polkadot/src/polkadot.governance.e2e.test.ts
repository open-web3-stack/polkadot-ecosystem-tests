import { polkadot } from '@e2e-test/networks/chains'
import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseGovernanceE2ETests(polkadot, { testSuiteName: 'Polkadot Governance', addressEncoding: 0 }))
