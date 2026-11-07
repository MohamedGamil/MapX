// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
import type { Invoice } from './definitions';

export async function fetchInvoices(): Promise<Invoice[]> {
  return [{ id: '1', amount: 10 }];
}
