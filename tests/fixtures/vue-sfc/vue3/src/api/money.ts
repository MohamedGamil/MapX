// Same-name trap (M3-04): a legacy helper named like the composable CartView imports from
// composables/useCurrency. useCurrency('EUR') in CartView resolves to the composable, never here.
export function useCurrency(code: string) {
  return { code, symbol: code === 'EUR' ? '€' : code };
}

export function format(cents: number) {
  return (cents / 100).toFixed(2);
}
