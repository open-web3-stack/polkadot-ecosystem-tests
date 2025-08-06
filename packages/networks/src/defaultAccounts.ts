import { testingPairs } from '@acala-network/chopsticks-testing'

import type { Keyring } from '@polkadot/keyring'
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
