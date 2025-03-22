import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { Vec } from '@polkadot/types'
import type { PalletProxyProxyDefinition } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'
import { assert, describe, test } from 'vitest'
import { check, checkEvents } from './helpers/index.js'

/**
 * Delay parameter for proxy tests.
 */
const PROXY_DELAY = 5

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
  const proxyAccounts: {
    [k: string]: KeyringPair
  } = Object.fromEntries(
    Object.entries(proxyTypes).map(([proxyType, _]) => [proxyType, kr.addFromUri(`//Alice proxy ${proxyType}`)]),
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
    await check(proxy)
      .redact({ removeKeys: /proxyType/ })
      .toMatchObject({
        delegate: encodeAddress(proxyAccounts[proxy.proxyType.toString()].address, addressEncoding),
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
  })
}
