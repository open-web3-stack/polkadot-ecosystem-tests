import { defineChain } from '../defineChain.js'
import { defaultAccounts } from '../testAccounts.js'

const custom = {
  moonbeam: {
    dot: 42259045809535163221576417993425387648n,
    aca: 224821240862170613278369189818311486111n,
    ldot: 225719522181998468294117309041779353812n,
    xcmDot: { Concrete: { parents: 1, interior: 'Here' } },
    xcmAca: {
      Concrete: {
        parents: 1,
        interior: {
          X2: [
            { Parachain: 2000 },
            { GeneralKey: { data: '0x0000000000000000000000000000000000000000000000000000000000000000', length: 2 } },
          ],
        },
      },
    },
    xcmLdot: {
      Concrete: {
        parents: 1,
        interior: {
          X2: [
            { Parachain: 2000 },
            { GeneralKey: { data: '0x0003000000000000000000000000000000000000000000000000000000000000', length: 2 } },
          ],
        },
      },
    },
  },
  moonriver: {},
}

const getInitStorages = () => ({
  System: {
    Account: [[[defaultAccounts.alith.address], { providers: 1, data: { free: 1000n * 10n ** 18n } }]],
  },
  AuthorFilter: {
    EligibleRatio: 100,
    EligibleCount: 100,
  },
})

export const moonbeam = defineChain({
  name: 'moonbeam',
  paraId: 2004,
  endpoint: 'wss://wss.api.moonbeam.network',
  custom: custom.moonbeam,
  initStorages: getInitStorages(),
})

export const moonriver = defineChain({
  name: 'moonriver',
  paraId: 2023,
  endpoint: 'wss://wss.api.moonriver.moonbeam.network',
  custom: custom.moonriver,
  initStorages: getInitStorages(),
})
