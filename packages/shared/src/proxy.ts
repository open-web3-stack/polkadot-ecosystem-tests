import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Vec } from '@polkadot/types'
import type { PalletProxyProxyDefinition } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'
import { assert, describe, expect, test } from 'vitest'
import { check, checkEvents } from './helpers/index.js'
/**
 * Test to the process of adding a proxy to an account.
 *
 * 1. creates proxies of every type for an account
 *     - both with 0 delay, and with e.g. 5 blocks of delay
 * 2. checks that the proxies exist
 * 3. removes every previously created proxy
 * @param client
 */
export async function addProxyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, addressEncoding: number, proxyTypes: Record<string, number>) {
  const alice = defaultAccountsSr25519.alice
  const bob = defaultAccountsSr25519.bob
  const charlie = defaultAccountsSr25519.charlie

  const batchAll: SubmittableExtrinsic<'promise', ISubmittableResult>[] = []

  for (const proxyTypeIx of Object.values(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(bob.address, proxyTypeIx, 0)
    batchAll.push(addProxyTx)
  }

  const batchAllTx = client.api.tx.utility.batchAll(batchAll)
  const addProxyEvents = await sendTransaction(batchAllTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(addProxyEvents, 'proxy').toMatchSnapshot(
    'events when adding proxy (with/without delay) accounts to Alice',
  )

  // Check created proxies

  const proxyData = await client.api.query.proxy.proxies(alice.address)
  const proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
  const proxyDeposit = proxyData[1]

  expect(proxies.length).toBe(Object.keys(proxyTypes).length)
  const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
  const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
  const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor.muln(proxies.length))
  assert(proxyDeposit.eq(proxyDepositTotal))

  // Check proxies
  for (const proxy of proxies) {
    await check(proxy)
      .redact({ redactKeys: /proxyType/ })
      .toMatchObject({
        delegate: encodeAddress(bob.address, addressEncoding),
        delay: 0,
      })
  }
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
