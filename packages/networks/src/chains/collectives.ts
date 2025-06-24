import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  collectivesPolkadot: {
    units: 1e10,
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  collectivesWestend: {
    units: 1e12,
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (config: typeof custom.collectivesPolkadot | typeof custom.collectivesWestend) => {
  const baseAmount = 1000
  const amount = BigInt(baseAmount) * BigInt(config.units)

  return {
    System: {
      account: [
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccounts.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccounts.bob.address], { providers: 1, data: { free: amount } }],
      ],
    },
  }
}

export const collectivesPolkadot = defineChain({
  name: 'collectivesPolkadot',
  endpoint: 'wss://polkadot-collectives-rpc.polkadot.io',
  paraId: 1001,
  custom: custom.collectivesPolkadot,
  initStorages: getInitStorages(custom.collectivesPolkadot),
})

export const collectivesWestend = defineChain({
  name: 'collectivesWestend',
  endpoint: 'wss://westend-collectives-rpc.polkadot.io',
  paraId: 1001,
  custom: custom.collectivesWestend,
  initStorages: getInitStorages(custom.collectivesWestend),
})
