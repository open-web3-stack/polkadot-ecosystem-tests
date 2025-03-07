import { testingPairs } from '@acala-network/chopsticks-testing'
import type { KeyringInstance, KeyringPair } from '@polkadot/keyring/types'

import { cryptoWaitReady } from '@polkadot/util-crypto'

export type DefaultAccounts = ReturnType<typeof testingPairs>

export const defaultAccounts: {
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
  keyring: any
  keyringEth: KeyringInstance
} = testingPairs()

/**
 * Sr25519 keyring pairs for use in tests.
 *
 * These are preferrable over Ed25519 because PJS offers Sr25519 development keypairs when used in conjunction with
 * `chopsticks`, which helps debugging tests when `pause()`ing.
 */
export const defaultAccountsSr25519: {
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
  keyring: any
  keyringEth: KeyringInstance
} = await cryptoWaitReady().then(() => testingPairs('sr25519'))
