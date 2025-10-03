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

async function getAndVerifyMultisigEventData(client: Client<any, any>, signer: string, addressEncoding: number) {
  // Check the multisig creation event (and extract multisig account address)
  const events = await client.api.query.system.events()

  const [multisigEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })

  assert(client.api.events.multisig.NewMultisig.is(multisigEvent.event))

  const newMultisigEventData = multisigEvent.event.data

  expect(newMultisigEventData.approving.toString()).toBe(encodeAddress(signer, addressEncoding))

  const multisigExtrinsicIndex = multisigEvent.phase.asApplyExtrinsic.toNumber()
  const multisigAddress = newMultisigEventData.multisig
  const multisigCallHash = newMultisigEventData.callHash

  return [multisigAddress, multisigExtrinsicIndex, multisigCallHash]
}

async function getFreeFunds(client: Client<any, any>, address: any): Promise<number> {
  const account = await client.api.query.system.account(address)
  return account.data.free.toNumber()
}

async function getReservedFunds(client: Client<any, any>, address: any): Promise<number> {
  const account = await client.api.query.system.account(address)
  return account.data.reserved.toNumber()
}

async function getProxyCosts(client: Client<any, any>, numProxies: number): Promise<number> {
  const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor

  return proxyDepositBase.add(proxyDepositFactor.muln(numProxies)).toNumber()
}

async function getMultisigCosts(client: Client<any, any>, threshold: number): Promise<number> {
  const multisigBaseDeposit = client.api.consts.multisig.depositBase
  const multisigDepositFactor = client.api.consts.multisig.depositFactor

  return multisigBaseDeposit.add(multisigDepositFactor.muln(threshold)).toNumber()
}

/// -------
/// -------
/// -------

/// -------------
/// Success Tests
/// -------------

/**
 * Test basic multisig-with-pure-proxy creation and execution.
 *
 * 1. Bob creates a pure proxy
 * 2. Alice creates a 2-of-3 multisig operation with Bob's pure proxy and Charlie as other signatories
 *   - The operation is to send funds from the multisig to Dave
 * 3. Bob approves the multisig operation via his pure proxy
 * 4. Verify that the operations were performed successfully
 */
async function multisigWithPureProxyTest<
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

  // Check that Bob has no reserved funds.
  let bobReservedFunds = await getReservedFunds(client, bob.address)
  expect(bobReservedFunds, 'Bob should have no reserved funds').toBe(0)

  // Bob creates a pure proxy.
  const proxyType = proxyTypes['Any']
  const addProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(addProxyTx.signAsync(bob))

  await client.dev.newBlock()

  // Check that the pure proxy was created successfully.
  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, bob, addressEncoding)

  // Check that Bob has had funds reserved for the pure proxy.
  bobReservedFunds = await getReservedFunds(client, bob.address)
  expect(bobReservedFunds, 'Bob should have reserved funds').toBe(await getProxyCosts(client, 1))

  // Create a simple call to transfer funds to Dave from the 2-of-3 multisig
  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // Alice creates a multisig with Bob's pure proxy and Charlie (threshold: 2)
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = [pureProxyAddress, charlie.address].sort().reverse()

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

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event (and extract multisig account address)
  const [multisigAddress, multisigExtrinsicIndex, multisigCallHash] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    addressEncoding,
  )

  // Funds the multisig account to execute the call.
  const extraFunds = 1e10
  await setupBalances(client, [{ address: multisigAddress, amount: transferAmount + extraFunds }])

  // Approve the multisig call. This is the final approval, so `multisig.asMulti` is used.
  otherSignatories = [alice.address, charlie.address].sort()
  const finalApprovalTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    maxWeight,
  )

  // Check that Dave has no funds before the multisig executes.
  let daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have no funds before multisig executes').toBe(0)

  // Execute the multisig call via Bob's pure proxy.
  const proxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, finalApprovalTx)
  const finalApprovalEvents = await sendTransaction(proxyTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot("events when Bob's proxy approves the multisig call")

  // Check that Dave has received the funds.
  daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that the multisig account has no funds
  const multisigFreeFunds = await getFreeFunds(client, multisigAddress)
  expect(multisigFreeFunds, 'Multisig account should have expected funds after multisig executes').toBe(extraFunds)

  // Check the emitted event
  const events = await client.api.query.system.events()
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

/**
 * Test basic multisig-as-standard-proxy creation and execution.
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie as other signatories
 *   - the operation is to send funds from Dave to Charlie
 * 3. Dave adds the multisig as his proxy
 * 2. Bob approves the multisig operation and triggers the sending of the funds
 * 4. Verify that the operations were performed successfully
 */
async function multisigAsStandardProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave

  await setupBalances(client, [
    { address: alice.address, amount: 100e10 },
    { address: bob.address, amount: 100e10 },
    { address: charlie.address, amount: 0e10 },
    { address: dave.address, amount: 200e10 },
  ])

  // The call to transfer funds to Charlie
  const transferAmount: number = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)

  // Bob performs a proxy call to transfer funds to Charlie
  const proxyTx = client.api.tx.proxy.proxy(dave.address, null, transferCall)

  // First and last approvals require encoded call; the following approvals - the non-final ones - require a hash.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = [bob.address, charlie.address].sort()

  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    proxyTx.method.toHex(),
    maxWeight,
  )

  const multisigEvents = await sendTransaction(asMultiTx.signAsync(alice))
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event.
  const [multisigAddress, multisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    addressEncoding,
  )

  // Funds the multisig account to execute the call
  const extraFunds = 1e10
  await setupBalances(client, [{ address: multisigAddress, amount: transferAmount + extraFunds }])

  // Dave should have no reserved funds yet.
  let daveReservedFunds = await getReservedFunds(client, dave.address)
  expect(daveReservedFunds, 'Dave should have no reserved funds').toBe(0)

  // Dave adds the multisig as his proxy.
  const addProxyTx = client.api.tx.proxy.addProxy(multisigAddress, 'Any', 0)
  await sendTransaction(addProxyTx.signAsync(dave))

  await client.dev.newBlock()

  // Check that Dave has had funds reserved for the proxy.
  daveReservedFunds = await getReservedFunds(client, dave.address)
  expect(daveReservedFunds, 'Dave should have reserved funds').toBe(await getProxyCosts(client, 1))

  // Check that Charlie has no free funds.
  let charlieFreeFunds = await getFreeFunds(client, charlie.address)
  const daveOldFreeFunds = await getFreeFunds(client, dave.address)
  expect(charlieFreeFunds, 'Charlie should have no free funds').toBe(0)

  // Approve the multisig call. This is the final approval, so `multisig.asMulti` is used.
  otherSignatories = [alice.address, charlie.address].sort()

  const finalApprovalTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    proxyTx.method.toHex(),
    maxWeight,
  )

  const finalApprovalEvents = await sendTransaction(finalApprovalTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      redactKeys: /height/,
    })
    .toMatchSnapshot('events when Bob approves multisig call')

  // Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that Dave has lost funds and Charlie has gained funds.
  const daveNewFreeFunds = await getFreeFunds(client, dave.address)

  charlieFreeFunds = await getFreeFunds(client, charlie.address)
  expect(charlieFreeFunds, 'Charlie should have some free funds after the multisig executes').toBe(transferAmount)
  expect(daveOldFreeFunds - daveNewFreeFunds, 'Dave should have lost some free funds after the multisig executes').toBe(
    transferAmount,
  )
}

/**
 * Test basic multisig-with-pure-proxy-multisig creation and execution.
 *
 * 1. Charlie creates a pure proxy which will later change ownership to the secondary multisig
 *  - This is needed since the proxy must already exist when creating the secondary multisig
 * 2. Alice creates a 2-of-3 multisig operation with Bob and Charlies pure proxy as other signatories
 *  - The operation is to send funds from the primary multisig to Dave
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie as other signatories
 *   - the operation is to send funds from Dave to Charlie
 * 3. Dave adds the multisig as his proxy
 * 2. Bob approves the multisig operation and triggers the sending of the funds
 * 4. Verify that the operations were performed successfully
 */
async function multisigWithPureProxyMultisigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
  const [client] = await setupNetworks(chain)

  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie
  const dave = defaultAccountsSr25519.dave
  const eve = defaultAccountsSr25519.eve

  await setupBalances(client, [
    { address: alice.address, amount: 300e10 },
    { address: bob.address, amount: 100e10 },
    { address: charlie.address, amount: 100e10 },
    { address: dave.address, amount: 0e10 },
    { address: eve.address, amount: 100e10 },
  ])

  const proxyType = proxyTypes['Any']
  const createPureProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(createPureProxyTx.signAsync(charlie))

  await client.dev.newBlock()

  // Charlie should have had funds reserved for the pure proxy.
  const charlieReservedFunds = await getReservedFunds(client, charlie.address)
  expect(charlieReservedFunds, 'Charlie should have reserved funds').toBe(await getProxyCosts(client, 1))

  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, charlie, addressEncoding)

  // Alice creates a multisig with Bob and Charlie's pure proxy (threshold: 2)
  const threshold = 2
  const otherSignatories = [bob.address, pureProxyAddress].sort().reverse()
  const primarymaxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit

  const transferAmount = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // First and last approvals require encoded call; the following approvals - the non-final ones - require a hash.
  const primaryMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    primarymaxWeight,
  )

  const multisigEvents = await sendTransaction(primaryMultiFirstTx.signAsync(alice))
  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig').toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event and extract multisig account address.
  const [primaryMultisigAddress, primaryMultisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    addressEncoding,
  )

  // Funds the multisig account.
  const extraFunds = 1e10
  await setupBalances(client, [{ address: primaryMultisigAddress, amount: transferAmount + extraFunds }])

  // Approve the multisig call. This is the final approval, so `multisig.asMulti` is used.
  const primaryMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    [alice.address, bob.address].sort(),
    {
      height: currBlockNumber + 1,
      index: primaryMultisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    primarymaxWeight,
  )

  const proxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, primaryMultiLastTx)
  const secondaryMaxWeight = { refTime: 10000000000, proofSize: 10000000 } // Conservative weight limit

  const secondaryMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    [dave.address, eve.address].sort(),
    null, // No timepoint for first approval
    proxyTx.method.toHex(),
    secondaryMaxWeight,
  )

  await sendTransaction(secondaryMultiFirstTx.signAsync(charlie))
  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check the multisig creation event (and extract multisig account address)
  const [secondaryMultisigAddress, secondaryMultisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    charlie.address,
    addressEncoding,
  )

  await setupBalances(client, [{ address: pureProxyAddress, amount: 100e10 }])

  // Charlie makes the secondary multisig the co-owner of the pure proxy.
  const addProxyTx = client.api.tx.proxy.addProxy(secondaryMultisigAddress, 'Any', 0)
  let pureProxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, addProxyTx)

  await sendTransaction(pureProxyTx.signAsync(charlie))
  await client.dev.newBlock()

  // Charlie removes himself as the co-owner of the pure proxy.
  const removeProxyTx = client.api.tx.proxy.removeProxy(charlie.address, 'Any', 0)
  pureProxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, removeProxyTx)

  await sendTransaction(pureProxyTx.signAsync(charlie))
  await client.dev.newBlock()

  // Eve approves the secondary multisig call, which makes the pure proxy sign the first multisig call, thus funding Dave
  const secondaryMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    [charlie.address, dave.address].sort(),
    {
      height: currBlockNumber + 1,
      index: secondaryMultisigExtrinsicIndex,
    },
    proxyTx.method.toHex(),
    secondaryMaxWeight,
  )

  // Check that Dave has no funds before the multisig executes.
  let daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have no funds before multisig executes').toBe(0)

  await sendTransaction(secondaryMultiLastTx.signAsync(eve))
  await client.dev.newBlock()

  // Check that Dave has received the funds.
  daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that the primary multisig account has fewer funds.
  const primaryMultisigFreeFunds = await getFreeFunds(client, primaryMultisigAddress)
  expect(primaryMultisigFreeFunds, 'Primary multisig account should have fewer funds').toBe(extraFunds)

  // Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)
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
        label: '2-of-3 multisig with pure proxy creation and execution',
        testFn: () => multisigWithPureProxyTest(chain, testConfig.addressEncoding, proxyTypes),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig as standard proxy creation and execution',
        testFn: () => multisigAsStandardProxyTest(chain, testConfig.addressEncoding, proxyTypes),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig with pure proxy multisig creation and execution',
        testFn: () => multisigWithPureProxyMultisigTest(chain, testConfig.addressEncoding, proxyTypes),
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
