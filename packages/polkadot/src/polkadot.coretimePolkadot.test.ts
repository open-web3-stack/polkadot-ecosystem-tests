import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { coretimeAssignCoreE2ETests } from '@e2e-test/shared'

coretimeAssignCoreE2ETests(polkadot, coretimePolkadot, {
  testSuiteName: 'polkadot & coretimePolkadot: broker assign_core to relay chain',
})
