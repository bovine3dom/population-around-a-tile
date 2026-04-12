// let things sample without having to care about
// the shape of the data underneath
export interface Sampler {
  totalRows: number
  get: (index: number, field: string) => number
}
