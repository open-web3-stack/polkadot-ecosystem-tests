import { testingPairs } from '@acala-network/chopsticks-testing'

export type DefaultAccount = ReturnType<typeof testingPairs>

export const defaultAccount = testingPairs()
