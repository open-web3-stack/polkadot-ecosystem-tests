import { acala } from '@e2e-test/networks/chains'
import {
  accountsE2ETests,
  createAccountsConfig,
  createDefaultDepositActions,
  type FeeExtractor,
  type FeeInfo,
  manualLockAction,
  manualReserveAction,
  type ParaTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

/**
 * Fee extractor for Acala's `module-transaction-payment`.
 *
 * Acala's `TransactionFeePaid` event has 4 fields:
 *   `{ who, actual_fee, actual_tip, actual_surplus }`
 * vs the standard Substrate event with 3:
 *   `{ who, actual_fee, tip }`
 *
 * PJS augmented types don't cover Acala's custom event shape, so we use
 * string comparison and positional access instead of `api.events...is()`.
 */
const acalaFeeExtractor: FeeExtractor = (events, api) => {
  const results: FeeInfo[] = []
  for (const { event } of events) {
    if (api.events.transactionPayment.TransactionFeePaid.is(event)) {
      results.push({
        who: event.data[0].toString(),
        actualFee: BigInt(event.data[1].toString()),
        tip: BigInt(event.data[2].toString()),
      })
    }
  }
  return results
}

const testConfig: ParaTestConfig = {
  testSuiteName: 'Acala Accounts',
  addressEncoding: 10,
  chainEd: 'Normal',
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
  feeExtractor: acalaFeeExtractor,
}

const accountsCfg = createAccountsConfig({
  expectation: 'failure',
  actions: {
    reserveActions: [manualReserveAction()],
    lockActions: [manualLockAction()],
    depositActions: createDefaultDepositActions(),
  },
})

registerTestTree(accountsE2ETests(acala, testConfig, accountsCfg))
