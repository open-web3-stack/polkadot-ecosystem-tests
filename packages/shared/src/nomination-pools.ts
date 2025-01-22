import { encodeAddress } from '@polkadot/util-crypto'

import { Chain, defaultAccounts } from "@e2e-test/networks";
import { setupNetworks } from '@e2e-test/shared'
import { check, checkEvents, objectCmp } from './helpers/index.js'

import { assert, describe, test } from "vitest";
import { Option } from '@polkadot/types'
import { sendTransaction } from '@acala-network/chopsticks-testing';
import { PalletNominationPoolsBondedPoolInner } from '@polkadot/types/lookup';

/**
 * Compare the selected properties of two nomination pools.
 *
 * Fails if any of the properties to be compared is different.
 *
 * It can be desirable to compare a nomination pool in pre- and post-block-execution states of
 * different operations.
 * For example:
 * 1. before and after changing its commission information
 * 2. before and after changing its roles
 * 3. before and after adding a new member
 *
 * @param pool1
 * @param pool2
 * @param propertiesToBeSkipped List of properties to not be included in the referenda comparison
 */
function nominationPoolCmp(
  pool1: PalletNominationPoolsBondedPoolInner,
  pool2: PalletNominationPoolsBondedPoolInner,
  propertiesToBeSkipped: string[],
) {
  const properties = [
    'commission',
    'memberCounter',
    'points',
    'roles',
    'state',
  ]

  const msgFun = (p: string) =>
    `Nomination pools differed on property \`${p}\`
      Left: ${pool1[p]}
      Right: ${pool2[p]}`

  objectCmp(pool1, pool2, properties, propertiesToBeSkipped, msgFun)
}

async function nominationPoolTest(relayChain, addressEncoding: number) {
  const [relayClient] = await setupNetworks(relayChain)
 
  const preLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()

  // get the value for an account
  const minJoinBond = (await relayClient.api.query.nominationPools.minJoinBond()).toNumber()
  const minCreateBond = (await relayClient.api.query.nominationPools.minCreateBond()).toNumber()
  const existentialDep = relayClient.api.consts.balances.existentialDeposit.toNumber()

  const depositorMinBond = Math.max(minJoinBond, minCreateBond, existentialDep)

  // Attempt to create a pool with insufficient funds
  let createNomPoolTx = relayClient.api.tx.nominationPools.create(
    depositorMinBond - 1,
    defaultAccounts.alice.address,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address
  )

  let createNomPoolEvents = await sendTransaction(createNomPoolTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(createNomPoolEvents, 'system')
    .toMatchSnapshot('create nomination pool with insufficient funds events')


  /**
   * Create pool with sufficient funds
   */

  createNomPoolTx = relayClient.api.tx.nominationPools.create(
    depositorMinBond,
    defaultAccounts.alice.address,
    defaultAccounts.bob.address,
    defaultAccounts.charlie.address
  )

  createNomPoolEvents = await sendTransaction(createNomPoolTx.signAsync(defaultAccounts.alice))

  /// Check that prior to the block taking effect, the pool does not yet exist with the
  /// most recently available pool ID.
  let poolData: Option<PalletNominationPoolsBondedPoolInner> =
    await relayClient.api.query.nominationPools.bondedPools(preLastPoolId + 1)
  assert(poolData.isNone, 'Pool should not exist before block is applied')

  await relayClient.dev.newBlock()

  await checkEvents(createNomPoolEvents, 'staking', 'nominationPools')
    .toMatchSnapshot('create nomination pool events')

  /// Check status of created pool

  const postLastPoolId = (await relayClient.api.query.nominationPools.lastPoolId()).toNumber()
  assert(preLastPoolId + 1 === postLastPoolId, 'Pool ID should increment by 1')

  poolData = await relayClient.api.query.nominationPools.bondedPools(postLastPoolId)
  assert(poolData.isSome, 'Pool should exist after block is applied')

  const nominationPoolPostCreation = poolData.unwrap()
  await check(nominationPoolPostCreation.commission).toMatchObject({
    current: null,
    max: null,
    changeRate: null,
    throttleFrom: null,
    claimPermission: null
  })
  assert(nominationPoolPostCreation.memberCounter.eq(1), 'Pool should have 1 member')
  assert(nominationPoolPostCreation.points.eq(depositorMinBond), 'Pool should have `deposit_min_bond` points')
  await check(nominationPoolPostCreation.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.bob.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.charlie.address, addressEncoding),
  })
  assert(nominationPoolPostCreation.state.isOpen, 'Pool should be open after creation')

  /**
   * Set the pool's commission data
   */

  // This will be `Perbill` runtime-side, so 0.1%
  const commission = 10e5

  const setCommissionTx = relayClient.api.tx.nominationPools.setCommission(
    postLastPoolId,
    [commission, defaultAccounts.dave.address]
  )

  const setCommissionMaxTx = relayClient.api.tx.nominationPools.setCommissionMax(
    postLastPoolId,
    commission * 10
  )

  const setCommissionChangeRateTx = relayClient.api.tx.nominationPools.setCommissionChangeRate(
    postLastPoolId,
    {
      maxIncrease: 10e8,
      minDelay: 10
    }
  )

  const setCommissionClaimPermissionTx = relayClient.api.tx.nominationPools.setCommissionClaimPermission(
    postLastPoolId,
    "Permissionless"
  )

  const commissionTx = relayClient.api.tx.utility.batchAll([
    setCommissionTx,
    setCommissionMaxTx,
    setCommissionChangeRateTx,
    setCommissionClaimPermissionTx
  ])

  const commissionEvents = await sendTransaction(commissionTx.signAsync(defaultAccounts.alice))

  await relayClient.dev.newBlock()

  await checkEvents(commissionEvents, 'nominationPools')
    .toMatchSnapshot('commission alteration events')

  /// Check that all commission data were set correctly
  poolData = await relayClient.api.query.nominationPools.bondedPools(postLastPoolId)
  assert(poolData.isSome, 'Pool should still exist after commission is changed')

  const blockNumber = (await relayClient.api.rpc.chain.getHeader()).number.toNumber()

  const nominationPoolWithCommission = poolData.unwrap()

  nominationPoolCmp(nominationPoolPostCreation, nominationPoolWithCommission, ['commission'])

  const newCommissionData = {
    max: commission * 10,
    current: [
      commission,
      encodeAddress(defaultAccounts.dave.address, addressEncoding)
    ],
    changeRate: {
      maxIncrease: 10e8,
      minDelay: 10
    },
    throttleFrom: blockNumber,
    claimPermission: { permissionless: null },
  }

  await check(nominationPoolWithCommission.commission).toMatchObject(newCommissionData)

  /**
   * Have other accounts join the pool
   */

  const ferdie = defaultAccounts.keyring.addFromUri('//Ferdie')

  // Fund test accounts not already provisioned in the test chain spec.
  await relayClient.dev.setStorage({
    System: {
      account: [
        [[defaultAccounts.eve.address], { providers: 1, data: { free: 10000e10 } }],
        [[ferdie.address], { providers: 1, data: { free: 100000e10 } }],
      ],
    },
  })

  const joinPoolTx = relayClient.api.tx.nominationPools.join(minJoinBond, postLastPoolId)

  const joinPoolEvents = await sendTransaction(joinPoolTx.signAsync(defaultAccounts.eve))

  await relayClient.dev.newBlock()

  await checkEvents(joinPoolEvents, 'staking', 'nominationPools')
    .toMatchSnapshot('join nomination pool events')

  poolData = await relayClient.api.query.nominationPools.bondedPools(postLastPoolId)
  assert(poolData.isSome, 'Pool should still exist after new member joins')

  const nominationPoolWithMembers = poolData.unwrap()
  assert(nominationPoolWithMembers.memberCounter.eq(2), 'Pool should have 2 members')
  assert(
    nominationPoolWithMembers.points.eq(depositorMinBond + minJoinBond),
    'Pool should have `depositor_min_bond + min_join_bond` points'
  )

  nominationPoolCmp(nominationPoolWithCommission, nominationPoolWithMembers, ['memberCounter', 'points'])

}

export function nominationPoolsE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustom, TInitStoragesRelay>,
  testConfig: { testSuiteName: string, addressEncoding: number, }
) {

  describe(testConfig.testSuiteName, function () {
    test(
      'nomination pool lifecycle test',
      async () => {
        await nominationPoolTest(relayChain, testConfig.addressEncoding)
      })
  })
}
