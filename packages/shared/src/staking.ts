import { type Chain, defaultAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'
import { checkEvents } from './helpers/index.js'

import { sendTransaction } from '@acala-network/chopsticks-testing'
import { assert, describe, test } from 'vitest'

/**
 * Test that it is not possible to validate before bonding funds.
 */
async function validateNoBondedFundsFailureTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)

  // 10e6 is 1% commission
  const validateTx = client.api.tx.staking.validate({ commission: 10e6, blocked: false })
  const validateEvents = await sendTransaction(validateTx.signAsync(defaultAccounts.alice))

  client.dev.newBlock()

  await checkEvents(validateEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'events when attempting to validate with no bonded funds',
  )

  /// Check event - the above extrinsic should have raised a `NotController` error.

  const events = await client.api.query.system.events()

  const [ev] = events.filter((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  assert(client.api.events.system.ExtrinsicFailed.is(ev.event))
  const dispatchError = ev.event.data.dispatchError

  assert(dispatchError.isModule)
  assert(client.api.errors.staking.NotController.is(dispatchError.asModule))
}

export function stakingE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: { testSuiteName: string; addressEncoding: number }) {
  describe(testConfig.testSuiteName, () => {
    test('trying to become a validator with no bonded funds fails', async () => {
      await validateNoBondedFundsFailureTest(chain)
    })
  })
}
