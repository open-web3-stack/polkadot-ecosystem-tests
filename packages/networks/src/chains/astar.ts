import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  astar: {
    relayToken: '340282366920938463463374607431768211455',
    aUSDToken: '18446744073709551617',

    paraAccount: '13YMK2eZzuFY1WZGagpYtTgbWBWGdoUD2CtrPj1mQPjY8Ldc',
    dot: 340282366920938463463374607431768211455n,
    astr: { Concrete: { parents: 0, interior: 'Here' } },
    aca: 18446744073709551616n,
    usdt: 4294969280n,
  },
  shiden: {
    relayToken: '340282366920938463463374607431768211455',
    aUSDToken: '18446744073709551616',

    paraAccount: 'F7fq1jNy74AqkJ1DP4KqSrWtnTGtXfNVoDwFhTvvPxUvJaq',
    ksm: 340282366920938463463374607431768211455n,
    sdn: { Concrete: { parents: 0, interior: 'Here' } },
    kar: 18446744073709551618n,
    usdt: 4294969280n,
  },
}

const getInitStorages = (config: typeof custom.astar | typeof custom.shiden) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: '100000000000000000000' } }]],
  },
  Assets: {
    account: [
      [[config.relayToken, defaultAccounts.alice.address], { balance: 10 * 1e12 }],
      [[config.aUSDToken, defaultAccounts.alice.address], { balance: 10 * 1e12 }],
    ],
  },
  Sudo: {
    key: defaultAccounts.alice.address,
  },
  PolkadotXcm: {
    // avoid sending xcm version change notifications to makes things faster
    $removePrefix: ['versionNotifyTargets', 'versionNotifiers', 'supportedVersion'],
  },
})

export const astar = defineChain({
  name: 'astar',
  paraId: 2006,
  endpoint: 'wss://astar-rpc.dwellir.com',
  custom: custom.astar,
  initStorages: getInitStorages(custom.astar),
})

export const shiden = defineChain({
  name: 'shiden',
  paraId: 2007,
  endpoint: 'wss://shiden-rpc.dwellir.com',
  custom: custom.shiden,
  initStorages: getInitStorages(custom.shiden),
})
