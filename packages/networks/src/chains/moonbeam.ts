import { defaultAccount } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'

const custom = {
  moonbeam: {
    dot: 42259045809535163221576417993425387648n,
  },
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
  endpoint: 'https://rpc.api.moonbeam.network',
  custom: custom.moonbeam,
  initStorages: getInitStorages(),
})

export const moonriver = defineChain({
  name: 'moonriver',
  paraId: 2023,
  endpoint: 'https://rpc.api.moonriver.moonbeam.network',
  initStorages: getInitStorages(),
})
