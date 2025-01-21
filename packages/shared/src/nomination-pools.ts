import { dot , ksm, MultiAddress} from "@polkadot-api/descriptors"
import { createClient, getSs58AddressInfo } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";

import { encodeAddress } from '@polkadot/util-crypto'

import { Chain, defaultAccountsSr25199, defaultSigners, defaultSignersSr25519 } from "@e2e-test/networks";
import { setupNetworks } from '@e2e-test/shared'
import { check, checkEvents } from './helpers/index.js'

import { describe, test } from "vitest";

async function nominationPoolTest(relayChain, addressEncoding: number) {
  const [relayClientPJS] = await setupNetworks(relayChain)

// Connect to the polkadot relay chain.
  const relayClientPAPI = createClient(
    // Polkadot-SDK Nodes have issues, we recommend adding this enhancer
    // see Requirements page for more info
    withPolkadotSdkCompat(
      getWsProvider(relayClientPJS.url),
    )
  );

  // Fund test accounts not already provisioned in the test chain spec.
  await relayClientPJS.dev.setStorage({
    System: {
      account: [
        [[defaultAccountsSr25199.alice.address], { providers: 1, data: { free: 10000e10 } }],
        [[defaultAccountsSr25199.bob.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccountsSr25199.charlie.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccountsSr25199.dave.address], { providers: 1, data: { free: 10e10 } }],
        [[defaultAccountsSr25199.eve.address], { providers: 1, data: { free: 10e10 } }],
      ],
    },
  })

  // With the `client`, you can get information such as subscribing to the last
  // block to get the latest hash:
  relayClientPAPI.finalizedBlock$.subscribe((finalizedBlock) =>
    console.log(finalizedBlock.number, finalizedBlock.hash),
  )
   
  // To interact with the chain, you need to get the `TypedApi`, which includes
  // all the types for every call in that chain:
  const dotApi = relayClientPAPI.getTypedApi(dot)
   
  // get the value for an account
  const minJoinBond = await dotApi.query.NominationPools.MinJoinBond.getValue()
  const minCreateBond = await dotApi.query.NominationPools.MinCreateBond.getValue()
  const existentialDep = await dotApi.constants.Balances.ExistentialDeposit()

  const maxBI = (args: bigint[]) => args.reduce( (max, val) => max < val ? val : max, BigInt(Number.MIN_SAFE_INTEGER));

  const depositor_min_bond = maxBI([minJoinBond, minCreateBond, existentialDep])

  const aliceAddr = MultiAddress.Id(encodeAddress(defaultSignersSr25519.alice.publicKey, addressEncoding))
  const bobAddr = MultiAddress.Id(encodeAddress(defaultSignersSr25519.bob.publicKey, addressEncoding))

  const transferTx = dotApi.tx.Balances.transfer_allow_death({
    dest: bobAddr,
    value: 100_000_000_000n,
  })

  console.log(depositor_min_bond)

  const createNomPoolTx = dotApi.tx.NominationPools.create({
    amount: depositor_min_bond,
    root: aliceAddr,
    nominator: aliceAddr,
    bouncer: aliceAddr
  })

  // sign and submit the transaction while looking at the
  // different events that will be emitted
  const signedXtrnsc = await createNomPoolTx.sign(defaultSignersSr25519.alice)
  const txFinalizedPayload = await relayClientPAPI.submit(signedXtrnsc, "best")

  await relayClientPJS.dev.newBlock()

  await relayClientPJS.pause()
}

export function nominationPoolsE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  testConfig: { testSuiteName: string, addressEncoding: number, }
) {

  describe(testConfig.testSuiteName, function () {
    test(
      'nomination pools test',
      async () => {
        await nominationPoolTest(relayChain, testConfig.addressEncoding)
      })
  })
}
