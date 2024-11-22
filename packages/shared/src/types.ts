export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export enum Network {
  Polkadot = 'Polkadot',
  Kusama = 'Kusama',
}