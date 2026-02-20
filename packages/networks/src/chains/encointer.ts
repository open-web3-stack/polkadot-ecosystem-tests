import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519 } from '../testAccounts.js'

const custom = {
  encointerKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (_config: typeof custom.encointerKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 10e12 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 10e12 } }],
    ],
  },
})

export const encointerKusama = defineChain({
  name: 'encointerKusama',
  endpoint: 'wss://kusama.api.encointer.org',
  paraId: 1001,
  networkGroup: 'kusama',
  custom: custom.encointerKusama,
  initStorages: getInitStorages(custom.encointerKusama),
  properties: {
    addressEncoding: 2,
    schedulerBlockProvider: 'Local',
    chainEd: 'LowEd',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})
