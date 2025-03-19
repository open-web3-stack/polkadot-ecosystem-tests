import { sendTransaction } from '@acala-network/chopsticks-testing'
import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'
import type { Vec } from '@polkadot/types'
import type { PalletProxyProxyDefinition } from '@polkadot/types/lookup'
import { encodeAddress } from '@polkadot/util-crypto'
import { assert, describe, test } from 'vitest'
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

  for (const [proxyType, proxyTypeIx] of Object.entries(proxyTypes)) {
    const addProxyTx = client.api.tx.proxy.addProxy(bob.address, proxyTypeIx, 0)
    const addProxyEvents = await sendTransaction(addProxyTx.signAsync(alice))

    await client.dev.newBlock()

    await checkEvents(addProxyEvents, 'proxy').toMatchSnapshot(
      `events when adding proxy with type ${proxyType} to Alice`,
    )

    // Check created proxies

    const proxyData = await client.api.query.proxy.proxies(alice.address)
    const proxies: Vec<PalletProxyProxyDefinition> = proxyData[0]
    assert(proxies.length === 1)

    const proxyDeposit = proxyData[1]
    const proxyDepositBase = client.api.consts.proxy.proxyDepositBase
    const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor
    const proxyDepositTotal = proxyDepositBase.add(proxyDepositFactor)
    assert(proxyDeposit.eq(proxyDepositTotal))

    const proxy = proxies[0]
    await check(proxy).toMatchObject({
      delegate: encodeAddress(bob.address, addressEncoding),
      proxyType: proxyType,
      delay: 0,
    })

    // Remove proxy
    const removeProxyTx = client.api.tx.proxy.removeProxy(bob.address, proxyTypeIx, 0)
    const removeProxyEvents = await sendTransaction(removeProxyTx.signAsync(alice))

    await client.dev.newBlock()

    await checkEvents(removeProxyEvents, 'proxy').toMatchSnapshot(
      `events when removing proxy with type ${proxyType} from Alice`,
    )
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
