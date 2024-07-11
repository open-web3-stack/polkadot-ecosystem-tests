import { defaultAccount } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'

const custom = {
  moonbeam: {
    dot: 42259045809535163221576417993425387648n,
    aca: 224821240862170613278369189818311486111n,
    ldot: 225719522181998468294117309041779353812n,
  },
  moonriver: {},
}

const getInitStorages = () => ({
  System: {
    Account: [[[defaultAccount.alith.address], { providers: 1, data: { free: 1000n * 10n ** 18n } }]],
  },
  AuthorFilter: {
    EligibleRatio: 100,
    EligibleCount: 100,
  },
})

export const moonbeam = defineChain({
  name: 'moonbeam',
  paraId: 2004,
  endpoint: 'wss://moonbeam-rpc.dwellir.com',
  custom: custom.moonbeam,
  initStorages: getInitStorages(),
})

export const moonriver = defineChain({
  name: 'moonriver',
  paraId: 2023,
  endpoint: 'wss://moonriver-rpc.dwellir.com',
  custom: custom.moonriver,
  initStorages: getInitStorages(),
})
