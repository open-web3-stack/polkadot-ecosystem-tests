import { testingPairs } from '@acala-network/chopsticks-testing'

import { cryptoWaitReady } from '@polkadot/util-crypto'

export type DefaultAccounts = ReturnType<typeof testingPairs>

export const defaultAccounts = testingPairs()

export const defaultAccountsSr25199 = cryptoWaitReady().then(() => testingPairs('sr25519'))
