import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import type { Keyring } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { Vec } from '@polkadot/types'
import type { PalletProxyProxyDefinition } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'
import { assert, describe, test } from 'vitest'
import { check, checkEvents } from './helpers/index.js'

import BN from 'bn.js'

/// -------
/// Helpers
/// -------

/**
 * Delay parameter for proxy tests.
 */
const PROXY_DELAY = 5

/**
 * Given a keyring and a network's proxy types, create a keypair for each proxy type.
 */
function createProxyAccounts(
  accountName: string,
  kr: Keyring,
  proxyTypes: Record<string, number>,
): Record<string, KeyringPair> {
  return Object.fromEntries(
    Object.entries(proxyTypes).map(([proxyType, _]) => [proxyType, kr.addFromUri(`${accountName} proxy ${proxyType}`)]),
  )
}

/**
 * Test to the process of adding and removing proxies to another account.
 *
 * 1. creates proxies of every type for an account
 *     - these proxies have a delay of 0
 * 2. checks that the proxies exist
 * 3. removes every previously created proxy
 * 4. checks that the proxies no longer exist
 * 5. creates proxies of every type for the same account, this time with a delay
 * 6. checks that the proxies exist
 * 7. removes every previously created proxy with `remove_proxies`
 * 8. checks that the proxies no longer exist
 */
export async function addRemoveProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>, delay: number) {
  const alice = defaultAccountsSr25519.alice
  const kr = defaultAccountsSr25519.keyring

  // Create object with keys as proxy types and values as an Sr25519 keypair
  const proxyAccounts = createProxyAccounts('Alice', kr, proxyTypes)

  // Map from proxy indices to proxy types
  const proxyIndicesToTypes = Object.fromEntries(
    Object.entries(proxyTypes).map(([proxyType, proxyTypeIx]) => [proxyTypeIx, proxyType]),
  )

  // Create proxies

  let batch: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(proxyAccounts[proxyType].address, proxyTypeIx, 0)
    batch.push(addProxyTx)
  }

  const batchAddProxyTx = client.api.tx.utility.batchAll(batch)
  const addProxyEvents = await sendTransaction(batchAddProxyTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(addProxyEvents, 'proxy').toMatchSnapshot(`events when adding proxies to Alice`)

  // Check created proxies

  let proxyData = await client.api.query.proxy.proxies(alice.address)
  let proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  assert(proxies.length === Object.keys(proxyTypes).length)

  let proxyDeposit = proxyData[1]
  let proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  let proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  let proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(Object.keys(proxyTypes).length))
  assert(proxyDeposit.eq(proxyDepositTotal))

  for (const proxy of proxies) {
    await check(proxy).toMatchObject({
      delegate: encodeAddress(proxyAccounts[proxy.proxyType.toString()].address, addressEncoding),
      proxyType: proxyIndicesToTypes[proxy.proxyType.toNumber()],
      delay: 0,
    })
  }

  // Remove proxies

  batch = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const removeProxyTx = client.api.tx.proxy.removeProxy(proxyAccounts[proxyType].address, proxyTypeIx, 0)
    batch.push(removeProxyTx)
  }
  const batchRemoveProxyTx = client.api.tx.utility.batchAll(batch)

  const removeProxyEvents = await sendTransaction(batchRemoveProxyTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(removeProxyEvents, 'proxy').toMatchSnapshot(`events when removing proxies from Alice (batch)`)

  const proxyDataAfterRemoval = await client.api.query.proxy.proxies(alice.address)
  const proxiesAfterRemoval: Vec<PalletProxyProxyDefinition> = proxyDataAfterRemoval[0]
  assert(proxiesAfterRemoval.length === 0)

  const proxyDepositAfterRemoval = proxyDataAfterRemoval[1]
  assert(proxyDepositAfterRemoval.eq(0))

  // Create proxies (with delay)

  batch = []

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(proxyAccounts[proxyType].address, proxyTypeIx, delay)
    batch.push(addProxyTx)
  }

  const batchAddProxyWithDelayTx = client.api.tx.utility.batchAll(batch)
  // No need to check proxy addition events again - just the delay having changed is uninteresting.
  await sendTransaction(batchAddProxyWithDelayTx.signAsync(alice))

  await client.dev.newBlock()

  // Check created proxies, again

  proxyData = await client.api.query.proxy.proxies(alice.address)
  proxies = proxyData[0]
  assert(proxies.length === Object.keys(proxyTypes).length)

  proxyDeposit = proxyData[1]
  proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(Object.keys(proxyTypes).length))
  assert(proxyDeposit.eq(proxyDepositTotal))

  for (const proxy of proxies) {
    await check(proxy)
      .redact({ removeKeys: /proxyType/ })
      .toMatchObject({
        delegate: encodeAddress(proxyAccounts[proxy.proxyType.toString()].address, addressEncoding),
        delay: delay,
      })
  }

  // Remove delay-having proxies

  const removeProxiesTx = client.api.tx.proxy.removeProxies()
  const removeProxiesEvents = await sendTransaction(removeProxiesTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(removeProxiesEvents, 'proxy').toMatchSnapshot(`events when removing all proxies from Alice`)

  proxyData = await client.api.query.proxy.proxies(alice.address)
  proxies = proxyData[0]
  assert(proxies.length === 0)

  proxyDeposit = proxyData[1]
  assert(proxyDeposit.eq(0))
}

/**
 * Test pure proxy management.
 *
 * 1. create as many pure proxies as there are proxy types in the current network
 * 2. use a `utility.batchAll` transaction
 * 2. check that they were all created
 * 3. (attempt to) delete all of them
 * 4. verify that they were deleted
 *     - only the `Any` proxy is currently removable via `proxy.killPure`, see #8056
 */
export async function createKillPureProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
  const alice = defaultAccountsSr25519.alice

  // Create pure proxies

  // Map between proxy types (represented as the index of the proxy type in the network's proxy enum), and
  // the index of the `proxy` extrinsic in the block in which the pure proxy was created.
  // To kill the pure proxies later, these data will be required.
  const pureProxyExtrinsicIndices = new Map<number, number>()
  // When creating pure proxies via batch calls, each proxy must be assigned a unique index.
  // Because this test uses a batch transaction to create several pure proxies of *different* types, the indices
  // can be the same for all proxies: zero.
  const proxyIx = 0
  // Map betewen proxy types (their indices, again), and their addresses.
  const pureProxyAddresses = new Map<number, string>()

  const batch: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const proxyTypeIx of Object.values(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.createPure(proxyTypeIx, 0, proxyIx)
    batch.push(addProxyTx)
  }

  const batchCreatePureProxiesTx = client.api.tx.utility.batchAll(batch)
  const createPureProxiesEvents = await sendTransaction(batchCreatePureProxiesTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(createPureProxiesEvents, 'proxy')
    .redact({ removeKeys: /pure/ })
    .toMatchSnapshot(`events when creating pure proxies for Alice`)

  // Check created proxies

  // Pure proxies aren't visible in the `proxies` query.
  const proxyData = await client.api.query.proxy.proxies(alice.address)
  const proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  assert(proxies.length === 0)
  const proxyDeposit = proxyData[1]
  assert(proxyDeposit.eq(0))

  const events = await client.api.query.system.events()

  const proxyEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'proxy' && event.method === 'PureCreated'
  })

  assert(proxyEvents.length === Object.keys(proxyTypes).length)

  for (const proxyEvent of proxyEvents) {
    assert(client.api.events.proxy.PureCreated.is(proxyEvent.event))
    const eventData = proxyEvent.event.data
    // Log the extrinsic index that the `pure_proxy` extrinsic that created this pure proxy was run in.
    pureProxyExtrinsicIndices.set(
      proxyEvent.event.data.proxyType.toNumber(),
      proxyEvent.phase.asApplyExtrinsic.toNumber(),
    )

    pureProxyAddresses.set(eventData.proxyType.toNumber(), eventData.pure.toString())

    // Confer event data vs. storage
    const pureProxy = await client.api.query.proxy.proxies(eventData.pure)
    assert(pureProxy[0].length === 1)
    assert(pureProxy[0][0].proxyType.eq(eventData.proxyType))
    assert(pureProxy[0][0].delay.eq(0))
    assert(pureProxy[0][0].delegate.eq(encodeAddress(alice.address, addressEncoding)))

    const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
    const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
    const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor)
    assert(pureProxy[1].eq(proxyDepositTotal))
  }

  // Kill pure proxies

  // To call `proxy.killPure`, the block number of `proxy.createPure` is required.
  // The current block number will have been the block in which the batch transaction containing all of the
  // `createPure` extrinsics were executed.
  const currBlockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()

  // For every pure proxy type, create a `proxy.proxy` call, containing a `proxy.killPure` extrinsic.
  // Note that in the case of pure proxies, the account which called `proxy.createPure` becomes the delegate,
  // and the created pure account will become the delegator this needs to be reflected in the arguments for
  // `proxy.proxy`.
  for (const [proxyTypeIx, extIndex] of pureProxyExtrinsicIndices.entries()) {
    const killProxyTx = client.api.tx.proxy.killPure(alice.address, proxyTypeIx, proxyIx, currBlockNumber, extIndex)

    const proxyTx = client.api.tx.proxy.proxy(pureProxyAddresses.get(proxyTypeIx)!, null, killProxyTx)

    const proxyEvents = await sendTransaction(proxyTx.signAsync(alice))

    await client.dev.newBlock()

    // `proxy.killPure` does not emit any events.
    // #7995 will fix this, eliciting a failed test run sometime in the future.
    await checkEvents(proxyEvents, 'proxy').toMatchSnapshot(
      `events when killing pure proxy of type ${proxyTypeIx} for Alice`,
    )
  }

  // Check that the pure proxies were killed

  for (const proxyEvent of proxyEvents) {
    assert(client.api.events.proxy.PureCreated.is(proxyEvent.event))
    const eventData = proxyEvent.event.data

    const pureProxy = await client.api.query.proxy.proxies(eventData.pure)

    // At present, only `Any` pure proxies can successfully call `proxy.killPure`.
    // Pending a fix (see #8056), this may be updated to check that all pure proxy types can be killed.
    if (eventData.proxyType.toNumber() === proxyTypes['Any']) {
      assert(pureProxy[0].length === 0)
      assert(pureProxy[1].eq(0))
    } else {
      assert(pureProxy[0].length === 1)
      assert(pureProxy[0][0].delegate.eq(encodeAddress(alice.address, addressEncoding)))

      const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
      const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
      const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor)
      assert(pureProxy[1].eq(proxyDepositTotal))
    }
  }
}

/**
 * Test a simple proxy scenario.
 *
 * 1. Alice adds Bob as their `Any` proxy, with no associated delay
 * 2. Bob performs a proxy call on behalf of Alice to transfer some funds to Charlie
 * 3. Charlie's balance is check, as is Alice's
 */
export async function proxyAnnouncementTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie

  // Fund test accounts not already provisioned in the test chain spec.
  await client.dev.setStorage({
    System: {
      account: [[[bob.address], { providers: 1, data: { free: 1000e10 } }]],
    },
  })

  // Alice adds Bob as a 0-delay proxy
  const addProxyTx = client.api.tx.proxy.addProxy(bob.address, 'Any', 0)
  await sendTransaction(addProxyTx.signAsync(alice))

  await client.dev.newBlock()

  // Bob performs a proxy call to transfer funds to Charlie
  const transferAmount: number = 100e10
  const transferCall = client.api.tx.balances.transferKeepAlive(charlie.address, transferAmount)
  const proxyTx = client.api.tx.proxy.proxy(alice.address, null, transferCall)

  const proxyEvents = await sendTransaction(proxyTx.signAsync(bob))

  // Check Charlie's balances beforehand
  const oldAliceBalance = (await client.api.query.system.account(alice.address)).data.free
  let charlieBalance = (await client.api.query.system.account(charlie.address)).data.free
  assert(charlieBalance.eq(0), 'Charlie should have no funds')

  await client.dev.newBlock()

  await checkEvents(proxyEvents, 'proxy').toMatchSnapshot("events when Bob transfers funds to Charlie as Alice's proxy")

  // Check Alice's and Charlie's balances
  const newAliceBalance = (await client.api.query.system.account(alice.address)).data.free
  assert(newAliceBalance.eq(oldAliceBalance.sub(new BN(transferAmount))), 'Alice should have transferred funds')
  charlieBalance = (await client.api.query.system.account(charlie.address)).data.free
  assert(charlieBalance.eq(transferAmount), 'Charlie should have the transferred funds')
}

/**
 * E2E tests for proxy functionality:
 * - Adding and removing proxies
 * - Executing calls through proxies
 * - Proxy types and filtering
 */
export async function proxyE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: { testSuiteName: string; addressEncoding: number },
  proxyTypes: Record<string, number>,
) {
  describe(testConfig.testSuiteName, async () => {
    const [client] = await setupNetworks(chain)

    test('add proxies (with/without delay) to an account, and remove them', async () => {
      await addRemoveProxyTest(client, testConfig.addressEncoding, proxyTypes, PROXY_DELAY)
    })

    test('create and kill pure proxies', async () => {
      await createKillPureProxyTest(client, testConfig.addressEncoding, proxyTypes)
    })

    test('perform proxy call on behalf of delegator', async () => {
      await proxyAnnouncementTest(client)
    })
  })
}
