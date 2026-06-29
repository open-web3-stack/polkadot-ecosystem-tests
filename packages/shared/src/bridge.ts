import { connectBridgeHubs } from '@acala-network/chopsticks'

import { type Chain, type Client, createNetworks } from '@e2e-test/networks'

import type { ApiPromise } from '@polkadot/api'
import { Keyring } from '@polkadot/keyring'
import type { HexString } from '@polkadot/util/types'

import {
  assertExpectedEvents,
  checkSystemEvents,
  scheduleInlineCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import { setupBalances } from './setup.js'
import type { RootTestTree } from './types.js'

type BridgeHandle = Awaited<ReturnType<typeof connectBridgeHubs>>

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Wait until `api`'s tx pool holds a transaction (bounded by `timeoutMs`). `connectBridgeHubs` submits
// the bridge delivery into the pool out of band, so polling lets the test build the applying block as
// soon as it lands.
const waitForPoolTx = async (api: ApiPromise, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && (await api.rpc.author.pendingExtrinsics()).length === 0) {
    await delay(200)
  }
}

/**
 * The Polkadot Technical Fellowship (on Collectives) whitelists a call on Kusama Asset Hub over the
 * P↔K bridge. Kusama Asset Hub maps the bridged Fellowship location
 * `[GlobalConsensus(Polkadot), Parachain(1001), Plurality{Technical,Voice}, GeneralIndex(rank)]` to its
 * whitelist origin.
 *
 *   Collectives --HRMP--> Asset Hub Polkadot --bridge--> Bridge Hub Kusama --HRMP--> Asset Hub Kusama
 *
 * Collectives has no bridge router, so it routes through sibling Asset Hub Polkadot, which forwards over
 * the bridge with `InitiateTransfer { preserveOrigin: true }` to re-anchor the Fellowship origin onto
 * Kusama Asset Hub. The bridge hop is relayed by chopsticks' `connectBridgeHubs`.
 */
export function fellowshipWhitelistsCallOverBridge(
  collectivesChain: Chain,
  assetHubPolkadotChain: Chain,
  bridgeHubPolkadotChain: Chain,
  bridgeHubKusamaChain: Chain,
  assetHubKusamaChain: Chain,
  testConfig: TestConfig,
): RootTestTree {
  let collectives!: Client
  let ahPolkadot!: Client
  let bhPolkadot!: Client
  let bhKusama!: Client
  let ahKusama!: Client
  let forward!: BridgeHandle
  let reverse!: BridgeHandle

  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      // Separate Polkadot and Kusama groups: both Asset Hubs are para 1000 and both Bridge Hubs are
      // 1002, so a single group would collide in chopsticks' paraId-keyed HRMP routing.
      ;[collectives, ahPolkadot, bhPolkadot] = await createNetworks(
        collectivesChain,
        assetHubPolkadotChain,
        bridgeHubPolkadotChain,
      )
      ;[bhKusama, ahKusama] = await createNetworks(bridgeHubKusamaChain, assetHubKusamaChain)

      // `InitiateTransfer` and the bridge transport are XCM v5; pin every hop so version negotiation
      // can't downgrade them (the runtime's `force_xcm_version`).
      for (const c of [ahPolkadot, bhPolkadot, bhKusama, ahKusama]) {
        await c.dev.setStorage({ polkadotXcm: { safeXcmVersion: 5 } })
      }

      // One relayer per direction: both connectors submit to the same hubs, so a shared signer would
      // collide on its nonce and drop a tx. Funded on both hubs (the forks don't fund them).
      const keyring = new Keyring({ type: 'sr25519' })
      const relayerForward = keyring.addFromUri('//Alice')
      const relayerReverse = keyring.addFromUri('//Alice//reverse')
      const relayers = [
        { address: relayerForward.address, amount: 1_000_000_000_000_000n },
        { address: relayerReverse.address, amount: 1_000_000_000_000_000n },
      ]
      for (const hub of [bhPolkadot, bhKusama]) {
        await setupBalances(hub, relayers)
      }

      // Relay the bridge both ways (forward delivers Polkadot→Kusama; reverse carries confirmations back).
      forward = await connectBridgeHubs(bhPolkadot.api, bhKusama.api, { signer: relayerForward })
      reverse = await connectBridgeHubs(bhKusama.api, bhPolkadot.api, { signer: relayerReverse })
    },
    afterAll: async () => {
      await forward.disconnect().catch(() => {})
      await reverse.disconnect().catch(() => {})
      for (const c of [collectives, ahPolkadot, bhPolkadot, bhKusama, ahKusama]) {
        await c.api.disconnect().catch(() => {})
        await c.teardown().catch(() => {})
      }
    },
    children: [
      {
        kind: 'test',
        label: 'fellowship whitelistCall reaches Kusama Asset Hub via the P↔K bridge',
        flags: { timeout: 600_000 },
        testFn: async () => {
          // Dummy call hash to whitelist on Kusama Asset Hub.
          const callHash: HexString = '0x0101010101010101010101010101010101010101010101010101010101010101'
          const whitelistCall = ahKusama.api.tx.whitelist.whitelistCall(callHash).method.toHex() as HexString

          // Kusama Asset Hub from a Polkadot parachain (parents 2, into the Kusama consensus); Asset Hub
          // Polkadot from Collectives (a sibling).
          const kusamaAssetHub = {
            parents: 2,
            interior: { X2: [{ GlobalConsensus: { Kusama: null } }, { Parachain: 1000 }] },
          }
          const assetHubPolkadotDest = { parents: 1, interior: { X1: [{ Parachain: 1000 }] } }

          // Executed on Kusama Asset Hub under the re-anchored Fellowship origin.
          const xcmOnKusamaAssetHub = [
            { Transact: { originKind: 'Xcm', call: { encoded: whitelistCall }, fallbackMaxWeight: null } },
            { ExpectTransactStatus: 'Success' },
          ]

          // Executed on Asset Hub Polkadot: forward over the bridge, preserving the Fellowship origin.
          const xcmForAssetHubPolkadot = {
            V5: [
              { UnpaidExecution: { weightLimit: 'Unlimited', checkOrigin: null } },
              {
                InitiateTransfer: {
                  destination: kusamaAssetHub,
                  remoteFees: null,
                  preserveOrigin: true,
                  assets: [],
                  remoteXcm: xcmOnKusamaAssetHub,
                },
              },
            ],
          }

          // Collectives sends it to sibling Asset Hub Polkadot under the Fellowship origin.
          const send = collectives.api.tx.polkadotXcm
            .send({ V5: assetHubPolkadotDest }, xcmForAssetHubPolkadot)
            .method.toHex() as HexString
          await scheduleInlineCallWithOrigin(collectives, send, { FellowshipOrigins: 'Fellows' })

          // HRMP between forked chains is delivered synchronously inside `dev.newBlock`, so the HRMP
          // hops need no waiting; only the bridge hop is async.
          await collectives.dev.newBlock()
          await checkSystemEvents(collectives, 'polkadotXcm')
            .redact({ hash: false, redactKeys: /messageId/ })
            .toMatchSnapshot('collectives sends fellowship whitelist xcm toward kusama')

          // Asset Hub Polkadot forwards over the bridge (export to Bridge Hub Polkadot's outbound lane).
          await ahPolkadot.dev.newBlock()
          await bhPolkadot.dev.newBlock()

          // The connector reacts to Bridge Hub Polkadot's head out of band and submits the delivery into
          // Bridge Hub Kusama's pool; wait for it, then build the block that applies it.
          await waitForPoolTx(bhKusama.api)
          await bhKusama.dev.newBlock() // apply the delivery → HRMP to Kusama Asset Hub
          await ahKusama.dev.newBlock() // Kusama Asset Hub executes whitelist.whitelistCall

          await checkSystemEvents(ahKusama, 'whitelist', 'messageQueue')
            .redact({ hash: false, redactKeys: /id/ })
            .toMatchSnapshot('kusama asset hub whitelists the call via the bridged fellowship origin')

          assertExpectedEvents(await ahKusama.api.query.system.events(), [
            { type: ahKusama.api.events.whitelist.CallWhitelisted, args: { callHash } },
          ])
        },
      },
    ],
  }
}
