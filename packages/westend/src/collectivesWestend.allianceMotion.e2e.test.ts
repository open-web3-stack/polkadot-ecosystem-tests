import { collectivesWestend } from '@e2e-test/networks/chains'
import { allianceMotionE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  allianceMotionE2ETests(collectivesWestend, {
    testSuiteName: 'Westend Collectives AllianceMotion',
    // Collectives Westend at spec 1_025_002 derives a motion's hash from the call alone. The next
    // spec version is the first that can derive it from the call and the threshold.
    thresholdInProposalHashSince: 1_025_003,
  }),
)
