import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  peoplePolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
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

const getInitStorages = (
  _config: typeof custom.peoplePolkadot | typeof custom.peopleKusama | typeof custom.peopleWestend,
  free = 1000e10,
) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free } }],
      [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free } }],
      [[testAccounts.alice.address], { providers: 1, data: { free } }],
    ],
  },
  // Registrars to be used in E2E tests - required to test `RegistrarOrigin`-locked extrinsics.
  Identity: {
    Registrars: [aliceRegistrar, bobRegistrar],
  },
})

export const peoplePolkadot = defineChain({
  name: 'peoplePolkadot',
  endpoint: endpoints.peoplePolkadot,
  paraId: 1004,
  networkGroup: 'polkadot',
  custom: custom.peoplePolkadot,
  initStorages: getInitStorages(custom.peoplePolkadot),
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'NonLocal',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 4,
    feeExtractor: standardFeeExtractor,
  },
})

export const peopleKusama = defineChain({
  name: 'peopleKusama',
  endpoint: endpoints.peopleKusama,
  paraId: 1004,
  networkGroup: 'kusama',
  custom: custom.peopleKusama,
  initStorages: getInitStorages(custom.peopleKusama),
  properties: {
    addressEncoding: 2,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})

export const peopleWestend = defineChain({
  name: 'peopleWestend',
  endpoint: endpoints.peopleWestend,
  paraId: 1004,
  networkGroup: 'westend',
  custom: custom.peopleWestend,
  // Westend fees for megabyte-scale calls run to tens of WND, where the same calls cost
  // fractions of a KSM or DOT: the same-wasm upgrade tests submit the whole runtime in one
  // extrinsic, so the dev accounts carry a larger float here.
  initStorages: getInitStorages(custom.peopleWestend, 100_000e10),
  properties: {
    addressEncoding: 42,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})
