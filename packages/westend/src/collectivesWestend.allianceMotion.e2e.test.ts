import { collectivesWestend } from '@e2e-test/networks/chains'
import { allianceMotionE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  allianceMotionE2ETests(collectivesWestend, {
    testSuiteName: 'Westend Collectives AllianceMotion',
    // Collectives Westend derives a motion's hash from the call alone up to spec 1_025_002, and from
    // the call and the threshold from spec 1_026_000.
    thresholdInProposalHashSince: 1_026_000,
  }),
)
