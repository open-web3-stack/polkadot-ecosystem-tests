import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupBalances, setupNetworks, verifyPureProxy } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { checkEvents } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

/// -------
/// -------
/// -------

/// -------------
/// Success Tests
/// -------------

async function getAndVerifyPureProxyAddress(
  client: Client<any, any>,
  owner: KeyringPair,
  addressEncoding: number,
): Promise<string> {
  const sysEvents = await client.api.query.system.events()
  const proxyEvents = sysEvents.filter((record) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'PureCreated'
  })

  let pureProxyAddress: string = ''

  for (const proxyEvent of proxyEvents) {
    assert(client.api.events.proxy.PureCreated.is(proxyEvent.event))
    const eventData = proxyEvent.event.data

    expect(pureProxyAddress).toBe('')
    pureProxyAddress = eventData.pure.toString()

    // Confer event data vs. storage
    await verifyPureProxy(client, eventData, owner.address, addressEncoding)
  }

  return pureProxyAddress
}

/**
 * Test basic multisig-with-proxy creation and execution.
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie's pure proxy as other signatories
 *   - the operation is to send funds to Dave
 * 2. Verify that Alice makes a deposit for the multisig creation
 * 3. Bob approves the multisig operation (with correct parameters passed to `multisig.asMulti`)
 * 4. Verify that the operation was performed
 */
async function basicMultisigProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  await setupBalances(client, [
    { address: alice.address, amount: 300e10 },
    { address: bob.address, amount: 300e10 },
    { address: charlie.address, amount: 300e10 },
    { address: dave.address, amount: 0 },
  ])

  const proxyType = proxyTypes['Any']
  const addProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(addProxyTx.signAsync(bob))

  await client.dev.newBlock()

  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, bob, addressEncoding)

  // Check that Bob has reserved funds for the pure proxy.
  const bobAccount = await client.api.query.system.account(bob.address)
  const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor

  expect(bobAccount.data.reserved.toNumber(), 'Bob should have reserved funds').toBe(
    proxyDepositBase.add(proxyDepositFactor).toNumber(),
  )

  // Create a simple call to transfer funds to Dave from the 2-of-3 multisig
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob and Charlie (threshold: 2)
  const threshold = 2
  const otherSignatories = [pureProxyAddress, charlie.address].sort()
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit

  // First and last approvals require encoded call; the following approvals - the non-final ones - require a hash.
  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved
  const multisigBaseDeposit = client.api.consts.multisig.depositBase
  const multisigDepositFactor = client.api.consts.multisig.depositFactor
  let aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), 'Alice should have reserved funds for multisig deposit').toBe(
    multisigBaseDeposit.add(multisigDepositFactor.muln(threshold)).toNumber(),
  )

  // Check the multisig creation event (and extract multisig account address)

  let events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))
  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()

  const newMultisigEventData = multisigEvent.event.data
  expect(newMultisigEventData.approving.toString()).toBe(encodeAddress(alice.address, addressEncoding))
  const multisigAddress = newMultisigEventData.multisig
  const multisigCallHash = newMultisigEventData.callHash

  // Funds the multisig account to execute the call
  const extraFunds = 1e10
  await setupBalances(client, [{ address: multisigAddress, amount: transferAmount + extraFunds }])

  // Approve the multisig call. This is the final approval, so `multisig.asMulti` is used.
  const finalApprovalTx = client.api.tx.multisig.asMulti(
    threshold,
    [alice.address, charlie.address].sort(),
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  const proxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, finalApprovalTx)
  const finalApprovalEvents = await sendTransaction(proxyTx.signAsync(bob))

  // Before the multisig executes, check that Dave has no funds, just for certainty.
  let daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have no funds before multisig executes').toBe(0)

  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot("events when Bob's proxy approves the multisig call")

  // Dave should now have some funds
  daveAccount = await client.api.query.system.account(dave.address)
  expect(daveAccount.data.free.toNumber(), 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that Alice's deposit is gone
  aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.reserved.toNumber(), "Alice's deposit should have been refunded").toBe(0)

  // Check that the multisig account has no funds
  const multisigAccount = await client.api.query.system.account(multisigAddress)
  expect(
    multisigAccount.data.free.toNumber(),
    'Multisig account should have expected funds after multisig executes',
  ).toBe(extraFunds)

  // Check the emitted event
  events = await client.api.query.system.events()
  const [multisigExecutedEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })
  assert(client.api.events.multisig.MultisigExecuted.is(multisigExecutedEvent.event))
  const multisigExecutedEventData = multisigExecutedEvent.event.data
  expect(multisigExecutedEventData.approving.toString()).toBe(encodeAddress(pureProxyAddress, addressEncoding))
  expect(multisigExecutedEventData.timepoint.height.toNumber()).toBe(currBlockNumber + 1)
  expect(multisigExecutedEventData.multisig.toString()).toBe(multisigAddress.toString())
  expect(multisigExecutedEventData.callHash.toString()).toBe(multisigCallHash.toString())
}

export function successMultisigProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: { testSuiteName: string; addressEncoding: number },
  proxyTypes: Record<string, number>,
): RootTestTree {
  return {
    kind: 'describe',
    label: 'success tests',
    children: [
      {
        kind: 'test',
        label: 'basic 2-of-3 multisig-with-proxy creation and execution',
        testFn: () => basicMultisigProxyTest(chain, testConfig.addressEncoding, proxyTypes),
      },
    ],
  }
}

/**
 * Default set of combined (multisig, proxy) end-to-end tests.
 *
 * Includes both success and failure cases.
 * A test tree structure allows some extensibility in case a chain needs to
 * change/add/remove default tests.
 *
 * @param chain - The chain to test.
 * @param testConfig - Test configuration data - address encoding, top-level test suite name, etc.
 * @returns A test tree structure.
 */
export function baseMultisigProxyE2Etests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: { testSuiteName: string; addressEncoding: number },
  proxyTypes: Record<string, number>,
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [successMultisigProxyE2ETests(chain, testConfig, proxyTypes)],
  }
}
