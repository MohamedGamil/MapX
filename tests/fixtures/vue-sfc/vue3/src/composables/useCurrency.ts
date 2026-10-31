export function useCurrency(code: string) {
  const formatter = new Intl.NumberFormat('en', { style: 'currency', currency: code });

  function format(cents: number) {
    return formatter.format(cents / 100);
  }

  return { format };
}
