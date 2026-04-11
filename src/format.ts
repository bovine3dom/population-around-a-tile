export function human(number: number, precision = 2): string {
  return parseFloat(number.toPrecision(precision)).toLocaleString()
}
