import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  peoplePolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdcIndex: 1337,
  },
  peopleKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
    usdcIndex: 1337,
  },
}

const aliceRegistrar = {
  account: defaultAccountsSr25519.alice.address,
  fee: 1,
  fields: 0,
}

const bobRegistrar = {
  account: defaultAccountsSr25519.bob.address,
  fee: 0,
  fields: 0,
}

const getInitStorages = (config: typeof custom.peoplePolkadot | typeof custom.peopleKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  Assets: {
    asset: [
      // USDC asset pre-registered to receive XCM transfers from Asset Hub
      [
        [config.usdcIndex],
        {
          owner: defaultAccounts.alice.address,
          issuer: defaultAccounts.alice.address,
          admin: defaultAccounts.alice.address,
          freezer: defaultAccounts.alice.address,
          supply: 0,
          deposit: 0,
          minBalance: 0,
          isSufficient: true,
          accounts: 0,
          sufficients: 0,
          approvals: 0,
          status: 'Live',
        },
      ],
    ],
    metadata: [
      [
        [config.usdcIndex],
        {
          deposit: 0,
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
          isFrozen: false,
        },
      ],
    ],
  },
  // Registrars to be used in E2E tests - required to test `RegistrarOrigin`-locked extrinsics.
  Identity: {
    Registrars: [aliceRegistrar, bobRegistrar],
  },
})

export const peoplePolkadot = defineChain({
  name: 'peoplePolkadot',
  endpoint: 'wss://polkadot-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peoplePolkadot,
  initStorages: getInitStorages(custom.peoplePolkadot),
})

export const peopleKusama = defineChain({
  name: 'peopleKusama',
  endpoint: 'wss://kusama-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peopleKusama,
  initStorages: getInitStorages(custom.peopleKusama),
})
