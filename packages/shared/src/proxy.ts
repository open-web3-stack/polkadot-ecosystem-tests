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
 * Test to the process of adding a proxy to an account.
 *
 * 1. creates proxies of every type for an account
 * 2. checks that the proxies exist
 * 3. removes every previously created proxy
 * 4. checks that the proxies no longerexist
 * @param client
 */
export async function addProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
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

  const proxyData = await client.api.query.proxy.proxies(alice.address)
  const proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  assert(proxies.length === Object.keys(proxyTypes).length)

  const proxyDeposit = proxyData[1]
  const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(Object.keys(proxyTypes).length))
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

  await checkEvents(removeProxyEvents, 'proxy').toMatchSnapshot(`events when removing proxies from Alice`)

  const proxyDataAfterRemoval = await client.api.query.proxy.proxies(alice.address)
  const proxiesAfterRemoval: Vec<PalletProxyProxyDefinition> = proxyDataAfterRemoval[0]
  assert(proxiesAfterRemoval.length === 0)

  const proxyDepositAfterRemoval = proxyDataAfterRemoval[1]
  assert(proxyDepositAfterRemoval.eq(0))
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

    test('add proxies to an account', async () => {
      await addProxyTest(client, testConfig.addressEncoding, proxyTypes)
    })
  })
}
