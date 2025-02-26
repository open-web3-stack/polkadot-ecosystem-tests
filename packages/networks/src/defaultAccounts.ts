import { testingPairs } from '@acala-network/chopsticks-testing'

import { cryptoWaitReady } from '@polkadot/util-crypto'

export type DefaultAccounts = ReturnType<typeof testingPairs>

export const defaultAccounts = testingPairs()

/**
 * Sr25519 keyring pairs for use in tests.
 *
 * These are preferrable over Ed25519 because PJS offers Sr25519 development keypairs when used in conjunction with
 * `chopsticks`, which helps debugging tests when `pause()`ing.
 */
export const defaultAccountsSr25199 = await cryptoWaitReady().then(() => testingPairs('sr25519'))
