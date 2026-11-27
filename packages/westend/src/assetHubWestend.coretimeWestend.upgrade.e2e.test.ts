import { assetHubWestend, coretimeWestend } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubWestend & coretimeWestend',
}

// AH-Westend referenda cannot run today: `placeDecisionDeposit` declares proofSize
// 12,778,893 against a `normal.maxExtrinsic` cap of 7,340,032, so the pool rejects the
// deposit with ExhaustsResources and no referendum reaches deciding.
// Reported upstream: https://github.com/paritytech/polkadot-sdk/issues/13900
const skipRootReferendumTests =
  'AH-Westend placeDecisionDeposit exceeds maxExtrinsic proofSize; referenda are unsubmittable'

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubWestend, coretimeWestend, testConfig, {
    skipRootReferendumTests,
  }),
)
