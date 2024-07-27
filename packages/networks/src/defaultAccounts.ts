import { testingPairs } from '@acala-network/chopsticks-testing'

export type DefaultAccounts = ReturnType<typeof testingPairs>

export const defaultAccounts = testingPairs()
