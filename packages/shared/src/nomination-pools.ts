import { encodeAddress } from '@polkadot/util-crypto'

import { Chain, defaultAccounts } from "@e2e-test/networks";
import { setupNetworks } from '@e2e-test/shared'
import { check, checkEvents } from './helpers/index.js'

import { assert, describe, test } from "vitest";
import { Option } from '@polkadot/types'
import { sendTransaction } from '@acala-network/chopsticks-testing';
import { PalletNominationPoolsBondedPoolInner } from '@polkadot/types/lookup';
import { min } from 'lodash';
import { permission } from 'process';
import { b } from 'vitest/dist/chunks/suite.B2jumIFP.js';

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


  // Create pool with sufficient funds
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

  const nominationPool = poolData.unwrap()
  await check(nominationPool.commission).toMatchObject({
    current: null,
    max: null,
    changeRate: null,
    throttleFrom: null,
    claimPermission: null
  })
  assert(nominationPool.memberCounter.eq(1), 'Pool should have 1 member')
  await check(nominationPool.roles).toMatchObject({
    depositor: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    root: encodeAddress(defaultAccounts.alice.address, addressEncoding),
    nominator: encodeAddress(defaultAccounts.bob.address, addressEncoding),
    bouncer: encodeAddress(defaultAccounts.charlie.address, addressEncoding),
  })

  /// Set the pool commission

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

  await check(nominationPoolWithCommission.commission).toMatchObject({
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
  })
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
