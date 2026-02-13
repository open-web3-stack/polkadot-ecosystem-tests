import { defineChain } from '../defineChain.js'
import { defaultAccounts } from '../testAccounts.js'

const custom = {
  acala: {
    relayToken: 'DOT',
    relayLiquidToken: 'LDOT',
    stableToken: 'AUSD',

    paraAccount: '13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy',
    dot: { Token: 'DOT' },
    ldot: { Token: 'LDOT' },
    dai: { Erc20: '0x54a37a01cd75b616d63e0ab665bffdb0143c52ae' },
    usdt: { ForeignAsset: 12 },
    ausd: { Token: 'AUSD' },
    aca: { Token: 'ACA' },
    lcdot: { LiquidCrowdloan: 13 },
    eth: { ForeignAsset: 21 },
  },
  karura: {
    relayToken: 'KSM',
    relayLiquidToken: 'LKSM',
    stableToken: 'KUSD',

    paraAccount: '13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy',
    ksm: { Token: 'KSM' },
    lksm: { Token: 'LKSM' },
    usdt: { ForeignAsset: 7 },
    rmrk: { ForeignAsset: 0 },
    dai: { Erc20: '0x4bb6afb5fa2b07a5d1c499e1c3ddb5a15e709a71' },
    ausd: { Token: 'KUSD' },
    kar: { Token: 'KAR' },
    bsx: { ForeignAsset: 11 },
  },
}

const getInitStorages = (config: typeof custom.acala | typeof custom.karura) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 4, data: { free: 10 * 1e12 } }]],
  },
  Tokens: {
    accounts: [
      [[defaultAccounts.alice.address, { Token: config.relayToken }], { free: 10 * 1e12 }],
      [[defaultAccounts.alice.address, { Token: config.relayLiquidToken }], { free: 100 * 1e12 }],
      [[defaultAccounts.alice.address, { Token: config.stableToken }], { free: 1000 * 1e12 }],
    ],
  },
  Sudo: {
    key: defaultAccounts.alice.address,
  },
  EvmAccounts: {
    accounts: [[['0x82a258cb20e2adb4788153cd5eb5839615ece9a0'], defaultAccounts.alice.address]],
    evmAddresses: [[[defaultAccounts.alice.address], '0x82a258cb20e2adb4788153cd5eb5839615ece9a0']],
  },
  Homa: {
    // avoid impact test outcome
    $removePrefix: ['redeemRequests', 'unbondings', 'toBondPool'],
    // so that bump era won't trigger unbond
    relayChainCurrentEra: 100,
  },
  PolkadotXcm: {
    // avoid sending xcm version change notifications to makes things faster
    $removePrefix: ['versionNotifyTargets', 'versionNotifiers'],
  },
})

export const acala = defineChain({
  name: 'acala',
  endpoint: ['wss://acala.ibp.network', 'wss://acala-rpc-1.aca-api.network', 'wss://acala-rpc.n.dwellir.com'],
  paraId: 2000,
  networkGroup: 'polkadot',
  custom: custom.acala,
  initStorages: getInitStorages(custom.acala),
})

export const karura = defineChain({
  name: 'karura',
  endpoint: [
    'wss://karura-rpc-1.aca-api.network',
    'wss://karura-rpc-2.aca-api.network/ws',
    'wss://karura-rpc-3.aca-api.network/ws',
  ],
  paraId: 2000,
  networkGroup: 'kusama',
  custom: custom.karura,
  initStorages: getInitStorages(custom.karura),
})
