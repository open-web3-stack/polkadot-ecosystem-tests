import { testingPairs } from '@acala-network/chopsticks-testing'

import { Keyring } from '@polkadot/keyring'
import type { KeyringInstance, KeyringPair } from '@polkadot/keyring/types'
import { cryptoWaitReady } from '@polkadot/util-crypto'

/**
 * Type of object containing dev accounts that are used in tests.
 *
 * The keyrings are used to create fresh accounts: in some networks (e.g. testnets), dev accounts may have
 * already been used, and can thus alter the result of testing.
 */
export type DefaultAccounts = {
  alice: KeyringPair
  bob: KeyringPair
  charlie: KeyringPair
  dave: KeyringPair
  eve: KeyringPair
  alith: KeyringPair
  baltathar: KeyringPair
  charleth: KeyringPair
  dorothy: KeyringPair
  ethan: KeyringPair
  keyring: Keyring
  keyringEth: KeyringInstance
}

export const defaultAccounts: DefaultAccounts = testingPairs() as DefaultAccounts

/**
 * Sr25519 keyring pairs for use in tests.
 *
 * These are preferrable over Ed25519 because PJS offers Sr25519 development keypairs when used in conjunction with
 * `chopsticks`, which helps debugging tests when `pause()`ing.
 */
export const defaultAccountsSr25519: DefaultAccounts = (await cryptoWaitReady().then(() =>
  testingPairs('sr25519'),
)) as DefaultAccounts

/**
 * Type of object containing test accounts without eth keypairs.
 */
export type TestAccounts = {
  alice: KeyringPair
  bob: KeyringPair
  charlie: KeyringPair
  dave: KeyringPair
  eve: KeyringPair
  ferdie: KeyringPair
  keyring: Keyring
}

/**
 * Fresh test accounts with seeds different from those used by PJS.
 *
 * These accounts use fresh seeds to avoid conflicts with existing dev accounts
 * that may have been used in testnets.
 */
export const testAccounts: TestAccounts = await cryptoWaitReady().then(() => {
  const keyring = new Keyring({ type: 'sr25519' })

  return {
    alice: keyring.addFromUri('//fresh_alice'),
    bob: keyring.addFromUri('//fresh_bob'),
    charlie: keyring.addFromUri('//fresh_charlie'),
    dave: keyring.addFromUri('//fresh_dave'),
    eve: keyring.addFromUri('//fresh_eve'),
    ferdie: keyring.addFromUri('//fresh_ferdie'),
    keyring,
  }
})
