import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, setupBalances, setupNetworks, verifyPureProxy } from '@e2e-test/shared'

import type { KeyringPair } from '@polkadot/keyring/types'
import type { AccountId32 } from '@polkadot/types/interfaces/runtime'
import type { U8aFixed } from '@polkadot/types-codec'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import {
  blockProviderOffset,
  check,
  checkEvents,
  getBlockNumber,
  getFreeFunds,
  getReservedFunds,
  sortAddressesByBytes,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

/**
 * Verify that a pure proxy was created successfully by checking the event data after creation
 * and also obtain the pure proxy's address.
 */
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
 * Verify that a multisig was created successfully by checking the event data after creation
 * and also obtain the multisig's address, extrinsic index and the call's hash.
 */
async function getAndVerifyMultisigEventData(
  client: Client<any, any>,
  signer: string,
  addressEncoding: number,
): Promise<[AccountId32, number, U8aFixed]> {
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

/**
 * Get the costs for creating a number of proxies.
 */
async function getProxyCosts(client: Client<any, any>, numProxies: number): Promise<number> {
  const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor

  return proxyDepositBase.add(proxyDepositFactor.muln(numProxies)).toNumber()
}

/**
 * Get the costs for creating a multisig with a given threshold.
 */
async function getMultisigCosts(client: Client<any, any>, threshold: number): Promise<number> {
  const multisigBaseDeposit = client.api.consts.multisig.depositBase
  const multisigDepositFactor = client.api.consts.multisig.depositFactor

  return multisigBaseDeposit.add(multisigDepositFactor.muln(threshold)).toNumber()
}

/// -----
/// Tests
/// -----

/**
 * Test basic multisig-with-pure-proxy creation and execution.
 *
 * 1. Bob creates a pure proxy
 * 2. Alice creates a 2-of-3 multisig operation with Bob's pure proxy and Charlie as other signatories
 *    The operation is to send funds from the multisig to Dave
 * 3. Bob approves the multisig operation via his pure proxy
 * 4. Verify that the operations were performed successfully
 */
async function multisigWithPureProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  await setupBalances(client, [
    { address: alice.address, amount: 300n * 10n ** 10n },
    { address: bob.address, amount: 300n * 10n ** 10n },
    { address: charlie.address, amount: 300n * 10n ** 10n },
    { address: dave.address, amount: 0n },
  ])

  // Check that Bob has no reserved funds.
  let bobReservedFunds = await getReservedFunds(client, bob.address)
  expect(bobReservedFunds, 'Bob should have no reserved funds').toBe(0)

  // 1. Bob creates a pure proxy.
  const addProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(addProxyTx.signAsync(bob))

  await client.dev.newBlock()

  // Check that the pure proxy was created successfully.
  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, bob, chain.properties.addressEncoding)

  // Check that Bob has had funds reserved for the pure proxy.
  bobReservedFunds = await getReservedFunds(client, bob.address)
  expect(bobReservedFunds, 'Bob should have reserved funds').toBe(await getProxyCosts(client, 1))

  // Create a simple call to transfer funds to Dave from the 2-of-3 multisig.
  const transferAmount = 100n * 10n ** 10n
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // 2. Alice creates a 2-of-3 multisig with Bob's pure proxy and Charlie.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = sortAddressesByBytes([pureProxyAddress, charlie.address], chain.properties.addressEncoding)

  // The first and last approvals require an encoded call, while all intermediate approvals require a hash.
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

  // Check that the multisig was created successfully.
  await checkEvents(multisigEvents, 'multisig')
    .redact({ redactKeys: /multisig/ })
    .toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event and extract multisig account address.
  const [multisigAddress, multisigExtrinsicIndex, multisigCallHash] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Funds the multisig account to execute the call.
  const extraFunds = 100n * 10n ** 10n
  await setupBalances(client, [{ address: multisigAddress, amount: transferAmount + extraFunds }])

  // Prepare the second multisig approval call. As this is the final approval, `multisig.asMulti` is used.
  otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

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

  // 3. Bob approves the multisig operation via his pure proxy
  const proxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, finalApprovalTx)
  const finalApprovalEvents = await sendTransaction(proxyTx.signAsync(bob))

  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      // The approving address is the proxy, which is not deterministic.
      redactKeys: /approving|multisig|height/,
    })
    .toMatchSnapshot("events when Bob's proxy approves the multisig call")

  // 4. Check that Dave has received the funds.
  daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that the multisig account has no funds.
  const multisigFreeFunds = await getFreeFunds(client, multisigAddress)
  expect(multisigFreeFunds, 'Multisig account should have expected funds after multisig executes').toBe(extraFunds)

  // Check the emitted event.
  const events = await client.api.query.system.events()
  const [multisigExecutedEvent] = events.filter((record) => {
    const { event } = record
    return event.section === 'multisig'
  })
  assert(client.api.events.multisig.MultisigExecuted.is(multisigExecutedEvent.event))

  const multisigExecutedEventData = multisigExecutedEvent.event.data
  expect(multisigExecutedEventData.approving.toString()).toBe(
    encodeAddress(pureProxyAddress, chain.properties.addressEncoding),
  )
  expect(multisigExecutedEventData.timepoint.height.toNumber()).toBe(currBlockNumber + 1)
  expect(multisigExecutedEventData.multisig.toString()).toBe(multisigAddress.toString())
  expect(multisigExecutedEventData.callHash.toString()).toBe(multisigCallHash.toString())
}

/**
 * Test basic multisig-as-standard-proxy creation and execution.
 *
 * 1. Alice creates a 2-of-3 multisig operation with Bob and Charlie as other signatories
 *    The operation is to send funds from Dave to Charlie
 * 2. Dave adds the multisig as his proxy
 * 3. Bob approves the multisig operation, which triggers the sending of the funds
 * 4. Verify that the operations were performed successfully
 */
async function multisigAsStandardProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number, expectTransfer: boolean) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  await setupBalances(client, [
    { address: alice.address, amount: 100n * 10n ** 10n },
    { address: bob.address, amount: 100n * 10n ** 10n },
    { address: charlie.address, amount: 0n },
    { address: dave.address, amount: 200n * 10n ** 10n },
  ])

  // The proxy call to transfer funds to Charlie.
  const transferAmount = 100n * 10n ** 10n
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)
  const proxyTx = client.api.tx.proxy.proxy(dave.address, null, transferCall)

  // 1. Alice creates a 2-of-3 multisig for the transfer, with Bob and Charlie as the other signatories.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

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

  // Check that the multisig was created successfully.
  await checkEvents(multisigEvents, 'multisig')
    .redact({ redactKeys: /multisig/ })
    .toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event and extract the multisig address.
  const [multisigAddress, multisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Funds the multisig account to execute the call.
  const extraFunds = 100n * 10n ** 10n
  await setupBalances(client, [{ address: multisigAddress, amount: transferAmount + extraFunds }])

  // Dave should have no reserved funds yet.
  let daveReservedFunds = await getReservedFunds(client, dave.address)
  expect(daveReservedFunds, 'Dave should have no reserved funds').toBe(0)

  // 2. Dave adds the multisig as his proxy.
  const addProxyTx = client.api.tx.proxy.addProxy(multisigAddress, proxyType, 0)
  await sendTransaction(addProxyTx.signAsync(dave))

  await client.dev.newBlock()

  // Check that Dave has had funds reserved for the proxy.
  daveReservedFunds = await getReservedFunds(client, dave.address)
  expect(daveReservedFunds, 'Dave should have reserved funds').toBe(await getProxyCosts(client, 1))

  // Check that Charlie has no free funds.
  let charlieFreeFunds = await getFreeFunds(client, charlie.address)
  const daveOldFreeFunds = await getFreeFunds(client, dave.address)
  expect(charlieFreeFunds, 'Charlie should have no free funds').toBe(0)

  // 3. Bob approves the multisig operation, which triggers the sending of the funds if the proxy type allows it.
  otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

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
      redactKeys: /height|multisig/,
    })
    .toMatchSnapshot('events when Bob approves multisig call')

  // 4. Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that Dave has lost funds and Charlie has gained funds.
  const daveNewFreeFunds = await getFreeFunds(client, dave.address)

  charlieFreeFunds = await getFreeFunds(client, charlie.address)

  if (expectTransfer) {
    // The proxy type allowed the transfer, so it should have gone through.
    expect(charlieFreeFunds, 'Charlie should have some free funds after the multisig executes').toBe(transferAmount)
    expect(
      daveOldFreeFunds - daveNewFreeFunds,
      'Dave should have lost some free funds after the multisig executes',
    ).toBe(transferAmount)
  } else {
    // The proxy type did not allow the transfer, so it should not have gone through.
    expect(charlieFreeFunds, 'Charlie should have no free funds after the multisig executes').toBe(0)
    expect(daveOldFreeFunds - daveNewFreeFunds, 'Dave should have lost no free funds after the multisig executes').toBe(
      0,
    )
  }
}

/**
 * Test basic multisig-with-pure-proxy-multisig creation and execution.
 * 1. Charlie creates a pure proxy on his behalf.
 * 2. Alice creates a 2-of-3 multisig operation with Bob and Charlie's pure proxy as other signatories
 *    The operation is to send funds from the multisig account to Dave
 * 3. The pure proxy is bound to a secondary 2-of-3 multisig with Charlie, Dave and Eve as signatories
 * 4. Charlie approves the secondary multisig, then replaces himself with the multisig as the proxy's owner
 * 5. Eve co-approves the secondary multisig, which makes the pure proxy sign the first multisig call, thus funding Dave
 * 6. Verify that the operations were performed successfully
 */
async function multisigWithPureProxyMultisigTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave
  const eve = testAccounts.eve

  await setupBalances(client, [
    { address: alice.address, amount: 300n * 10n ** 10n },
    { address: bob.address, amount: 100n * 10n ** 10n },
    { address: charlie.address, amount: 300n * 10n ** 10n },
    { address: dave.address, amount: 0n },
    { address: eve.address, amount: 100n * 10n ** 10n },
  ])

  // 1. Charlie creates a pure proxy on his behalf.
  const createPureProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(createPureProxyTx.signAsync(charlie))

  await client.dev.newBlock()

  // Charlie should have had funds reserved for the pure proxy.
  const charlieReservedFunds = await getReservedFunds(client, charlie.address)
  expect(charlieReservedFunds, 'Charlie should have reserved funds').toBe(await getProxyCosts(client, 1))

  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, charlie, chain.properties.addressEncoding)

  // 2. Alice creates a 2-of-3 multisig operation with Bob and Charlie's pure proxy as other signatories.
  const threshold = 2
  const primarymaxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = sortAddressesByBytes([bob.address, pureProxyAddress], chain.properties.addressEncoding)

  const transferAmount = 100n * 10n ** 10n
  const transferCall = client.api.tx.balances.transferKeepAlive(dave.address, transferAmount)

  // The first and last approvals require an encoded call, while any intermediate approvals require a hash.
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

  // Check that the multisig was created successfully.
  await checkEvents(multisigEvents, 'multisig')
    .redact({ redactKeys: /multisig/ })
    .toMatchSnapshot('events when Alice creates multisig')

  // Check that Alice's multisig creation deposit was reserved.
  let aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event and extract multisig account address.
  const [primaryMultisigAddress, primaryMultisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Fund the multisig account.
  const extraFunds = 100n * 10n ** 10n
  await setupBalances(client, [{ address: primaryMultisigAddress, amount: transferAmount + extraFunds }])

  // Define the second (and last) approval call for the primary multisig.
  otherSignatories = sortAddressesByBytes([alice.address, bob.address], chain.properties.addressEncoding)
  const primaryMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: primaryMultisigExtrinsicIndex,
    },
    transferCall.method.toHex(),
    primarymaxWeight,
  )

  // 3. The pure proxy is bound to a secondary 2-of-3 multisig with Charlie, Dave and Eve as signatories.
  const proxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, primaryMultiLastTx)
  const secondaryMaxWeight = { refTime: 7000000000, proofSize: 3000000 } // Conservative weight limit

  // Charlie is the first approver of the secondary multisig.
  otherSignatories = sortAddressesByBytes([dave.address, eve.address], chain.properties.addressEncoding)
  const secondaryMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    proxyTx.method.toHex(),
    secondaryMaxWeight,
  )

  await sendTransaction(secondaryMultiFirstTx.signAsync(charlie))
  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.newBlock()

  // Check the multisig creation event so as to extract the secondary multisig's account address.
  const [secondaryMultisigAddress, secondaryMultisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    charlie.address,
    chain.properties.addressEncoding,
  )

  await setupBalances(client, [{ address: pureProxyAddress, amount: extraFunds }])

  // 4. Charlie makes the secondary multisig the co-owner of the pure proxy.
  const addProxyTx = client.api.tx.proxy.addProxy(secondaryMultisigAddress, proxyType, 0)
  let pureProxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, addProxyTx)

  await sendTransaction(pureProxyTx.signAsync(charlie))
  await client.dev.newBlock()

  // Charlie removes himself as the co-owner of the pure proxy.
  const removeProxyTx = client.api.tx.proxy.removeProxy(charlie.address, proxyType, 0)
  pureProxyTx = client.api.tx.proxy.proxy(pureProxyAddress, null, removeProxyTx)

  await sendTransaction(pureProxyTx.signAsync(charlie))
  await client.dev.newBlock()

  // 5. Eve approves the secondary multisig call, which makes the pure proxy sign the first multisig call, thus funding Dave
  otherSignatories = sortAddressesByBytes([charlie.address, dave.address], chain.properties.addressEncoding)

  const secondaryMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
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

  // 6. Check that Dave has received the funds.
  daveFreeFunds = await getFreeFunds(client, dave.address)
  expect(daveFreeFunds, 'Dave should have some funds after multisig executes').toBe(transferAmount)

  // Check that the primary multisig account has fewer funds.
  const primaryMultisigFreeFunds = await getFreeFunds(client, primaryMultisigAddress)
  expect(primaryMultisigFreeFunds, 'Primary multisig account should have fewer funds').toBe(extraFunds)

  // Check that Alice's deposit is gone.
  aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)
}

/**
 * Test basic multisig-with-pure-proxy creation and cancellation.
 *
 * 1. Alice creates a pure proxy and uses it to create a multisig with Bob and Charlie
 *    The operation is to send funds from the multisig to Charlie
 * 2. Alice cancels the multisig operation before any other approvals
 * 3. Verify that the operations were performed successfully
 */
async function cancelMultisigWithPureProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie

  await setupBalances(client, [
    { address: alice.address, amount: 300n * 10n ** 10n },
    { address: bob.address, amount: 0n },
    { address: charlie.address, amount: 0n },
  ])

  // 1. Alice creates a pure proxy.
  const addProxyTx = client.api.tx.proxy.createPure(proxyType, 0, 0)
  await sendTransaction(addProxyTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that the pure proxy was created successfully.
  const pureProxyAddress = await getAndVerifyPureProxyAddress(client, alice, chain.properties.addressEncoding)

  // Check that Alice has had funds reserved for the pure proxy.
  const aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds').toBe(await getProxyCosts(client, 1))

  // Create a simple call to transfer funds to Charlie from the 2-of-3 multisig.
  const transferAmount = 100n * 10n ** 10n
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)

  // Fund the pure proxy account to cover multisig deposit.
  await setupBalances(client, [{ address: pureProxyAddress, amount: 100n * 10n ** 10n }])

  // 1. Alice creates a 2-of-3 multisig with Bob's pure proxy and Charlie.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  const otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

  // The first and last approvals require an encoded call, while intermediate calls require a hash.
  const asMultiTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    transferCall.method.toHex(),
    maxWeight,
  )

  const createMultisigTx = client.api.tx.proxy.proxy(pureProxyAddress, null, asMultiTx)
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
  let multisigEvents = await sendTransaction(createMultisigTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that Alice's multisig creation deposit was reserved.
  let proxyReservedFunds = await getReservedFunds(client, pureProxyAddress)
  expect(proxyReservedFunds, 'The pure proxy should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Alice's reserved funds should not have changed.
  const newAliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(newAliceReservedFunds, 'Alice should have the same reserved funds').toBe(aliceReservedFunds)

  // Check that the multisig was created successfully
  await checkEvents(multisigEvents, 'multisig')
    .redact({ redactKeys: /multisig|approving/ })
    .toMatchSnapshot('events when Alice creates multisig')

  // Check the multisig creation event (and extract multisig account address)
  const [, multisigExtrinsicIndex, multisigCallHash] = await getAndVerifyMultisigEventData(
    client,
    pureProxyAddress,
    chain.properties.addressEncoding,
  )

  // Check that Charlie has no funds.
  let charlieFreeFunds = await getFreeFunds(client, charlie.address)
  expect(charlieFreeFunds, 'Charlie should have no funds before multisig cancellation').toBe(0)

  // 2. Alice cancels the multisig operation before any other approvals arrive.
  const cancelAsMultiTx = client.api.tx.multisig.cancelAsMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    multisigCallHash,
  )

  const cancelMultisigTx = client.api.tx.proxy.proxy(pureProxyAddress, null, cancelAsMultiTx)
  multisigEvents = await sendTransaction(cancelMultisigTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Check that the proxy's deposit is gone.
  proxyReservedFunds = await getReservedFunds(client, pureProxyAddress)
  expect(proxyReservedFunds, "The proxy's deposit should have been refunded").toBe(0)

  // Check that Charlie has no funds.
  charlieFreeFunds = await getFreeFunds(client, charlie.address)
  expect(charlieFreeFunds, 'Charlie should have no funds after multisig cancellation').toBe(0)
}

/**
 * Test basic multisig-as-standard-proxy announcements and rejections.
 *
 * 1. Alice creates a multisig with Bob and Charlie
 *    The operation is to send funds from Dave to Alice
 * 2. Dave nominates the multisig as his standard proxy
 * 3. The multisig announces the transfer call as a proxy on behalf of Dave
 * 4. Dave rejects the announced call
 * 5. The multisig re-announces the transfer call and it goes through the second time
 * 6. Verify that the operations were performed successfully
 */
async function multisigAsStandardProxyAnnouncementTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  await setupBalances(client, [
    { address: alice.address, amount: 100n * 10n ** 10n },
    { address: bob.address, amount: 100n * 10n ** 10n },
    { address: charlie.address, amount: 0n },
    { address: dave.address, amount: 100n * 10n ** 10n },
  ])

  // The call to transfer funds to Alice.
  const transferAmount = 10e10
  const transferCall = client.api.tx.balances.transferKeepAlive(alice.address, transferAmount)

  const announceTx = client.api.tx.proxy.announce(dave.address, transferCall.method.hash)

  // 1. Alice creates a 2-of-3 multisig with Bob and Charlie.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

  const announceMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    announceTx.method.toHex(),
    maxWeight,
  )

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await sendTransaction(announceMultiFirstTx.signAsync(alice))
  await client.dev.newBlock()

  // Check that Alice's multisig creation deposit was reserved.
  const aliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(aliceReservedFunds, 'Alice should have reserved funds for multisig deposit').toBe(
    await getMultisigCosts(client, threshold),
  )

  // Check the multisig creation event and extract the multisig account address.
  const [multisigAddress, multisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Funds the multisig account in order to execute the call.
  const multisigFunds = 100n * 10n ** 10n
  await setupBalances(client, [{ address: multisigAddress, amount: multisigFunds }])

  // 2. Dave nominates the multisig as his standard proxy.
  const addProxyTx = client.api.tx.proxy.addProxy(multisigAddress, proxyType, 0)

  await sendTransaction(addProxyTx.signAsync(dave))
  await client.dev.newBlock()

  // Check that Dave has had funds reserved for the proxy.
  const daveReservedFunds = await getReservedFunds(client, dave.address)
  expect(daveReservedFunds, 'Dave should have reserved funds').toBe(await getProxyCosts(client, 1))

  // 3. Bob co-signs the multisig, which allows it to announce the transfer as a proxy of Dave.
  otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

  let announceMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    announceTx.method.toHex(),
    maxWeight,
  )

  const finalApprovalEvents = await sendTransaction(announceMultiLastTx.signAsync(bob))
  await client.dev.newBlock()

  await checkEvents(finalApprovalEvents, 'multisig')
    .redact({
      redactKeys: /height|multisig/,
    })
    .toMatchSnapshot('events when Bob approves multisig call')

  const announcementObject = {
    real: encodeAddress(dave.address, chain.properties.addressEncoding),
    callHash: transferCall.method.hash.toHex(),
    height: await getBlockNumber(client.api, chain.properties.proxyBlockProvider!),
  }

  // Sanity check - the announcement should be associated to the multisig and not its delegator, Dave.
  let announcements = await client.api.query.proxy.announcements(dave.address)
  expect(announcements[0].length).toBe(0)
  expect(announcements[1].eq(0)).toBe(true)

  announcements = await client.api.query.proxy.announcements(multisigAddress)
  expect(announcements[0].length).toBe(1)
  await check(announcements[0][0]).toMatchObject(announcementObject)

  // 4. Dave now rejects the announced transfer.
  const rejectTx = client.api.tx.proxy.rejectAnnouncement(multisigAddress, transferCall.method.hash)
  const rejectEvents = await sendTransaction(rejectTx.signAsync(dave))
  await client.dev.newBlock()

  await checkEvents(rejectEvents, 'proxy').toMatchSnapshot('events when Dave rejects the announced call')

  // The multisig still attempts to execute the announced call.
  otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

  const proxyAnnouncedTx = client.api.tx.proxy.proxyAnnounced(multisigAddress, dave.address, null, transferCall)
  const proxyAnnouncedMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    proxyAnnouncedTx.method.toHex(),
    maxWeight,
  )

  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // Alice again signs the multisig first.
  await sendTransaction(proxyAnnouncedMultiFirstTx.signAsync(alice))
  await client.dev.newBlock()

  const [multisigAddress2, multisigExtrinsicIndex2] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Multisigs are uniquely defined by the set of signatories and the threshold only, so the address should be the same.
  expect(multisigAddress2.toString()).toBe(multisigAddress.toString())

  // Bob again co-signs the multisig.
  otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

  let proxyAnnouncedMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex2,
    },
    proxyAnnouncedTx.method.toHex(),
    maxWeight,
  )

  let oldAliceFreeFunds = await getFreeFunds(client, alice.address)

  await sendTransaction(proxyAnnouncedMultiLastTx.signAsync(bob))
  await client.dev.newBlock()

  // Check that Alice's deposit is gone.
  let newAliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(newAliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that Alice has not received the funds, because Dave has rejected the announcement earlier.
  let newAliceFreeFunds = await getFreeFunds(client, alice.address)
  expect(newAliceFreeFunds, 'Alice should have received funds after the multisig executes').toBe(
    oldAliceFreeFunds + aliceReservedFunds,
  )

  // 5. The multisig re-announces the transfer call, with Alice signing first.
  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await sendTransaction(announceMultiFirstTx.signAsync(alice))
  await client.dev.newBlock()

  // Bob co-signs the multisig that performs the announcement.
  announceMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    announceTx.method.toHex(),
    maxWeight,
  )

  await sendTransaction(announceMultiLastTx.signAsync(bob))
  await client.dev.newBlock()

  // The announcement is made and this time Dave doesn't reject it, so it should go through.
  currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // Alice again signs the multisig first, in order to execute the announced call.
  await sendTransaction(proxyAnnouncedMultiFirstTx.signAsync(alice))
  await client.dev.newBlock()

  proxyAnnouncedMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex2,
    },
    proxyAnnouncedTx.method.toHex(),
    maxWeight,
  )

  oldAliceFreeFunds = await getFreeFunds(client, alice.address)

  // And Bob again co-signs the multisig, thus executing the announced transfer.
  await sendTransaction(proxyAnnouncedMultiLastTx.signAsync(bob))
  await client.dev.newBlock()

  // 6. Check that Alice's deposit is gone.
  newAliceReservedFunds = await getReservedFunds(client, alice.address)
  expect(newAliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

  // Check that Alice has finally received the funds.
  newAliceFreeFunds = await getFreeFunds(client, alice.address)
  expect(newAliceFreeFunds, 'Alice should have received funds after the multisig executes').toBe(
    oldAliceFreeFunds + transferAmount + aliceReservedFunds,
  )
}

/**
 * Test basic multisig-as-standard-proxy announcements when the proxy has delays.
 *
 * 1. Alice creates a multisig with Bob and Charlie
 *    The operation is to send funds from Dave to Alice
 * 2. Dave nominates the multisig as his standard proxy with a delay
 * 3. The multisig announces the transfer call as a proxy on behalf of Dave
 * 4. The multisig fails to execute the announced call before the delay has passed
 * 5. The multisig succeeds in executing the announced call after the delay has passed
 * 6. Verify that the operations were performed successfully
 */
async function multisigAsStandardProxyAnnouncementWithDelayTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyType: number, proxyDelay: number) {
  const [client] = await setupNetworks(chain)

  const alice = testAccounts.alice
  const bob = testAccounts.bob
  const charlie = testAccounts.charlie
  const dave = testAccounts.dave

  await setupBalances(client, [
    { address: alice.address, amount: 100n * 10n ** 10n },
    { address: bob.address, amount: 100n * 10n ** 10n },
    { address: charlie.address, amount: 0n },
    { address: dave.address, amount: 200n * 10n ** 10n },
  ])

  // The call to transfer funds to Alice.
  const transferAmount = 50e10
  const transferCall = client.api.tx.balances.transferKeepAlive(alice.address, transferAmount)

  const announceTx = client.api.tx.proxy.announce(dave.address, transferCall.method.hash)

  // 1. Alice creates a 2-of-3 multisig with Bob and Charlie.
  const threshold = 2
  const maxWeight = { refTime: 1000000000, proofSize: 1000000 } // Conservative weight limit
  let otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

  const announceMultiFirstTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    null, // No timepoint for first approval
    announceTx.method.toHex(),
    maxWeight,
  )

  let currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await sendTransaction(announceMultiFirstTx.signAsync(alice))
  await client.dev.newBlock()

  // Check the multisig creation event and extract the multisig account address.
  const [multisigAddress, multisigExtrinsicIndex] = await getAndVerifyMultisigEventData(
    client,
    alice.address,
    chain.properties.addressEncoding,
  )

  // Funds the multisig account in order to execute the call.
  const multisigFunds = 100n * 10n ** 10n
  await setupBalances(client, [{ address: multisigAddress, amount: multisigFunds }])

  // 2. Dave nominates the multisig as his standard proxy with a delay.
  const addProxyTx = client.api.tx.proxy.addProxy(multisigAddress, proxyType, proxyDelay)

  await sendTransaction(addProxyTx.signAsync(dave))
  await client.dev.newBlock()

  // 3. Bob co-signs the multisig, which allows it to announce the transfer.
  otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

  const announceMultiLastTx = client.api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    {
      height: currBlockNumber + 1,
      index: multisigExtrinsicIndex,
    },
    announceTx.method.toHex(),
    maxWeight,
  )

  await sendTransaction(announceMultiLastTx.signAsync(bob))
  await client.dev.newBlock()

  let transferDone = false

  // The multisig attempts to execute the announced call before and after the delay has passed.
  do {
    currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
    otherSignatories = sortAddressesByBytes([bob.address, charlie.address], chain.properties.addressEncoding)

    // Alice again signs the multisig first, in order to execute the announced call.
    const proxyAnnouncedTx = client.api.tx.proxy.proxyAnnounced(multisigAddress, dave.address, null, transferCall)
    const proxyAnnouncedMultiFirstTx = client.api.tx.multisig.asMulti(
      threshold,
      otherSignatories,
      null, // No timepoint for first approval
      proxyAnnouncedTx.method.toHex(),
      maxWeight,
    )

    await sendTransaction(proxyAnnouncedMultiFirstTx.signAsync(alice))
    await client.dev.newBlock()

    const blockOffset = blockProviderOffset(
      chain.properties.proxyBlockProvider!,
      (chain.properties as any).asyncBacking,
    )
    proxyDelay -= blockOffset

    const [, multisigExtrinsicIndex2] = await getAndVerifyMultisigEventData(
      client,
      alice.address,
      chain.properties.addressEncoding,
    )

    // Bob again co-signs the multisig.
    otherSignatories = sortAddressesByBytes([alice.address, charlie.address], chain.properties.addressEncoding)

    const proxyAnnouncedMultiLastTx = client.api.tx.multisig.asMulti(
      threshold,
      otherSignatories,
      {
        height: currBlockNumber + 1,
        index: multisigExtrinsicIndex2,
      },
      proxyAnnouncedTx.method.toHex(),
      maxWeight,
    )

    const oldAliceReservedFunds = await getReservedFunds(client, alice.address)
    const oldAliceFreeFunds = await getFreeFunds(client, alice.address)

    await sendTransaction(proxyAnnouncedMultiLastTx.signAsync(bob))
    await client.dev.newBlock()
    proxyDelay -= blockOffset

    // Check that Alice's deposit is gone.
    const newAliceReservedFunds = await getReservedFunds(client, alice.address)
    const newAliceFreeFunds = await getFreeFunds(client, alice.address)
    expect(newAliceReservedFunds, "Alice's deposit should have been refunded").toBe(0)

    if (proxyDelay <= 0) {
      // 5. The multisig succeeds in executing the announced call after the delay has passed.
      expect(newAliceFreeFunds, 'Alice should have received funds after the multisig executes').toBe(
        oldAliceFreeFunds + oldAliceReservedFunds + transferAmount,
      )
      transferDone = true
      break
    } else {
      // 4. The multisig fails to execute the announced call before the delay has passed.
      expect(newAliceFreeFunds, 'Alice should not have received funds before delay passes').toBe(
        oldAliceFreeFunds + oldAliceReservedFunds,
      )
    }
  } while (proxyDelay > 0)

  // 6. Verify that the operations were performed successfully.
  expect(transferDone, 'The transfer should have been completed after the delay has passed').toBe(true)
}

export function successMultisigProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyTypes: Record<string, number>): RootTestTree {
  return {
    kind: 'describe',
    label: 'success tests',
    children: [
      {
        kind: 'test',
        label: '2-of-3 multisig with pure proxy (any)',
        testFn: () => multisigWithPureProxyTest(chain, proxyTypes['Any']),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig with pure proxy (non-transfer)',
        testFn: () => multisigWithPureProxyTest(chain, proxyTypes['NonTransfer']),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig as standard proxy (any)',
        testFn: () => multisigAsStandardProxyTest(chain, proxyTypes['Any'], true),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig with pure proxy multisig',
        testFn: () => multisigWithPureProxyMultisigTest(chain, proxyTypes['Any']),
      },
      {
        kind: 'test',
        label: 'Cancel 2-of-3 multisig with pure proxy before any other approvals',
        testFn: () => cancelMultisigWithPureProxyTest(chain, proxyTypes['Any']),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig as standard proxy with announcement and rejection',
        testFn: () => multisigAsStandardProxyAnnouncementTest(chain, proxyTypes['Any']),
      },
      {
        kind: 'test',
        label: '2-of-3 multisig as standard proxy with announcement and delay',
        testFn: () => multisigAsStandardProxyAnnouncementWithDelayTest(chain, proxyTypes['Any'], 7),
      },
    ],
  }
}

export function failureMultisigProxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, proxyTypes: Record<string, number>): RootTestTree {
  return {
    kind: 'describe',
    label: 'failure tests',
    children: [
      {
        kind: 'test',
        label: '2-of-3 multisig as standard proxy (non-transfer)',
        testFn: () => multisigAsStandardProxyTest(chain, proxyTypes['NonTransfer'], false),
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
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig, proxyTypes: Record<string, number>): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [successMultisigProxyE2ETests(chain, proxyTypes), failureMultisigProxyE2ETests(chain, proxyTypes)],
  }
}
