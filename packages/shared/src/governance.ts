import { Chain, defaultAccounts } from '@e2e-test/networks'
import { assert, describe, test } from 'vitest'
import { check, checkEvents } from '@e2e-test/shared/helpers'
import { setupNetworks } from '@e2e-test/shared'

// `dot` is the name we gave to `npx papi add`
import {
  GovernanceOrigin,
  MultiAddress,
  PolkadotRuntimeOriginCaller,
  PreimagesBounded,
  TraitsScheduleDispatchTime,
  dot,
} from '@polkadot-api/descriptors'
import { createClient } from 'polkadot-api'
// import from "polkadot-api/ws-provider/node"
// if you are running in a NodeJS environment
import { getPolkadotSigner } from 'polkadot-api/signer'
import { getWsProvider } from 'polkadot-api/ws-provider/node'
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat'

import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers'
import { Keyring } from '@polkadot/api'
import { Option } from '@polkadot/types'
import { PalletReferendaReferendumInfoConvictionVotingTally } from '@polkadot/types/lookup'
import { sendTransaction } from '@acala-network/chopsticks-testing'
import { sr25519CreateDerive } from '@polkadot-labs/hdkd'

const entropy = mnemonicToEntropy(DEV_PHRASE)
const miniSecret = entropyToMiniSecret(entropy)
const derive = sr25519CreateDerive(miniSecret)
const hdkdKeyPair = derive('//Alice')

const aliceSigner = getPolkadotSigner(hdkdKeyPair.publicKey, 'Ed25519', hdkdKeyPair.sign)

const keyring = new Keyring({
  type: 'ed25519',
})

const alicePolkadotJs = keyring.addFromUri('//Alice')

// Connect to the polkadot relay chain.
const client = createClient(
  // Polkadot-SDK Nodes have issues, we recommend adding this enhancer
  // see Requirements page for more info
  withPolkadotSdkCompat(getWsProvider('wss://rpc-polkadot.luckyfriday.io')),
)

const dotApi = client.getTypedApi(dot)

/**
 * Test the process of
 * 1. creating a referendum for a treasury spend
 * 2. cancelling it
 */
export async function submitReferendumThenCancel<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>, addressEncoding: number) {
  /**
   * Setup relay and parachain clients
   */

  const [relayClient] = await setupNetworks(relayChain)

  const encodedProposal = relayClient.api.tx.treasury.spendLocal(1e10, defaultAccounts.bob.address).method.toHex()

  const preimageTx = relayClient.api.tx.preimage.notePreimage(encodedProposal)
  //const preImageEvents = await sendTransaction(preimageTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  //await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  const referendumNum = await relayClient.api.query.referenda.referendumCount()

  const submitReferendumTx = relayClient.api.tx.referenda.submit(
    {
      Origins: 'SmallTipper',
    } as any,
    {
      Inline: encodedProposal,
    },
    {
      After: 1,
    },
  )
  const submitReferendumEvents = await sendTransaction(submitReferendumTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(submitReferendumEvents, 'referenda').redact({}).toMatchSnapshot('referendum submission events')

  const referendumDataOpt: Option<PalletReferendaReferendumInfoConvictionVotingTally> =
    await relayClient.api.query.referenda.referendumInfoFor(referendumNum)
  assert(referendumDataOpt, "submitted referendum's data cannot be `None`")
  const referendumData: PalletReferendaReferendumInfoConvictionVotingTally = referendumDataOpt.unwrap()

  const unwantedFields: RegExp = new RegExp('alarm')

  await check(referendumData).redact({ removeKeys: unwantedFields }).toMatchSnapshot('referendum info')

  await relayClient.pause()

  return

  /**
   * Submit a referendum
   */
  const transferTx = dotApi.tx.Balances.transfer_keep_alive({
    dest: MultiAddress.Id(defaultAccounts.bob.address),
    value: 10n ** 10n,
  })

  const proposalOrigin = PolkadotRuntimeOriginCaller.Origins(GovernanceOrigin.SmallTipper())
  const enactMoment = TraitsScheduleDispatchTime.After(10)
  const proposal = PreimagesBounded.Inline(encodedProposal)

  const submitTx = dotApi.tx.Referenda.submit({
    proposal_origin: proposalOrigin,
    proposal,
    enactment_moment: enactMoment,
  })

  const txFinalized = await submitTx.signAndSubmit(aliceSigner)

  await relayClient.dev.newBlock()

  /*   const events = dotApi.event.Referenda.Submitted.filter(txFinalized.events)
  check(events).toMatchSnapshot('submit referendum from system')
 */
  // const [submittedEvent] = client.event.Referenda.Submitted.filter(tx.events)
  // check for events
}

export function governanceE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(relayChain: Chain<TCustom, TInitStoragesRelay>) {
  describe('Polkadot Governance', function () {
    test('setting on-chain identity and requesting judgement should work', { timeout: 1_000_000 }, async () => {
      await submitReferendumThenCancel(relayChain, 0)
    })
  })
}
