/**
 * Diagnostic: Is the block author's fee share (20%) leaking from totalIssuance on relay chains?
 *
 * Post-AHM, balance transfers are disabled on relay chains. The standard 80/20 fee split sends 80%
 * to treasury and 20% to the block author. If the author's share can't be deposited (transfers
 * disabled), that NegativeImbalance is dropped — permanently reducing totalIssuance.
 *
 *   A) Empty block (no tx)             → totalIssuance unchanged (baseline)
 *   B) system.remark (no-op, pays fee) → delta should == floor(fee / 5) if author share leaks
 *   C) balances.burn                   → delta should == burnAmount + floor(fee / 5)
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { testAccounts } from '@e2e-test/networks'
import { kusama } from '@e2e-test/networks/chains'
import { setupNetworks, standardFeeExtractor } from '@e2e-test/shared'

import { describe, expect, it } from 'vitest'

describe('Fee issuance leak diagnostic (Kusama relay)', () => {
  it('A) empty block does not change totalIssuance', async () => {
    const [client] = await setupNetworks(kusama)

    const issuanceBefore = (await client.api.query.balances.totalIssuance()).toBigInt()
    await client.dev.newBlock()
    const issuanceAfter = (await client.api.query.balances.totalIssuance()).toBigInt()

    const delta = issuanceBefore - issuanceAfter

    console.log('=== TEST A: Empty block ===')
    console.log(`  issuance before : ${issuanceBefore}`)
    console.log(`  issuance after  : ${issuanceAfter}`)
    console.log(`  delta (leaked)  : ${delta}`)

    expect(delta).toBe(0n)
  })

  it('B) system.remark leaks exactly the fee from totalIssuance', async () => {
    const [client] = await setupNetworks(kusama)

    const ed = client.api.consts.balances.existentialDeposit.toBigInt()
    const alice = testAccounts.keyring.createFromUri('//diag_alice')
    await client.dev.setStorage({
      System: {
        account: [[[alice.address], { providers: 1, data: { free: ed * 1000n } }]],
      },
    })

    const issuanceBefore = (await client.api.query.balances.totalIssuance()).toBigInt()

    // Submit a no-op transaction — system.remark with empty data
    const remarkTx = client.api.tx.system.remark('0x')
    await sendTransaction(remarkTx.signAsync(alice))
    await client.dev.newBlock()

    const issuanceAfter = (await client.api.query.balances.totalIssuance()).toBigInt()

    // Extract fee paid
    const events = await client.api.query.system.events()
    const feeInfos = standardFeeExtractor(events as any, client.api)
    expect(feeInfos.length).toBe(1)
    const feePaid = feeInfos[0].actualFee

    const issuanceDelta = issuanceBefore - issuanceAfter

    const authorShare = feePaid / 5n
    const leakRatio = Number(issuanceDelta) / Number(feePaid)

    console.log('=== TEST B: system.remark (no-op tx) ===')
    console.log(`  issuance before : ${issuanceBefore}`)
    console.log(`  issuance after  : ${issuanceAfter}`)
    console.log(`  issuance delta  : ${issuanceDelta}`)
    console.log(`  fee paid        : ${feePaid}`)
    console.log(`  fee / 5 (20%)   : ${authorShare}`)
    console.log(`  delta == fee/5? : ${issuanceDelta === authorShare}`)
    console.log(`  delta / fee     : ${leakRatio}`)

    expect(issuanceDelta).toBe(authorShare)
  })

  it('C) balances.burn: issuance drops by burnAmount + fee (fee is leaked)', async () => {
    const [client] = await setupNetworks(kusama)

    const ed = client.api.consts.balances.existentialDeposit.toBigInt()
    const alice = testAccounts.keyring.createFromUri('//diag_alice')
    await client.dev.setStorage({
      System: {
        account: [[[alice.address], { providers: 1, data: { free: ed * 1000n } }]],
      },
    })

    const issuanceBefore = (await client.api.query.balances.totalIssuance()).toBigInt()
    const burnAmount = ed * 100n

    const burnTx = client.api.tx.balances.burn(burnAmount, false)
    await sendTransaction(burnTx.signAsync(alice))
    await client.dev.newBlock()

    const issuanceAfter = (await client.api.query.balances.totalIssuance()).toBigInt()

    // Extract fee
    const events = await client.api.query.system.events()
    const feeInfos = standardFeeExtractor(events as any, client.api)
    expect(feeInfos.length).toBe(1)
    const feePaid = feeInfos[0].actualFee

    const issuanceDelta = issuanceBefore - issuanceAfter

    const authorShare = feePaid / 5n
    const excess = issuanceDelta - burnAmount

    console.log('=== TEST C: balances.burn ===')
    console.log(`  issuance before          : ${issuanceBefore}`)
    console.log(`  issuance after           : ${issuanceAfter}`)
    console.log(`  issuance delta           : ${issuanceDelta}`)
    console.log(`  burn amount              : ${burnAmount}`)
    console.log(`  fee paid                 : ${feePaid}`)
    console.log(`  fee / 5 (author share)   : ${authorShare}`)
    console.log(`  excess over burn         : ${excess}`)
    console.log(`  excess == author share?  : ${excess === authorShare}`)

    const expectedDelta = burnAmount + authorShare
    const rounding = issuanceDelta - expectedDelta
    console.log(`  rounding error (Perbill) : ${rounding}`)
    expect(rounding >= 0n && rounding <= 1n).toBe(true)
  })
})
