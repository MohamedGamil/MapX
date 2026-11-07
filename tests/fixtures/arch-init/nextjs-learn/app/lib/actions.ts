// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
'use server';
import { fetchInvoices } from './data';

export async function createInvoice(): Promise<number> {
  return (await fetchInvoices()).length;
}
