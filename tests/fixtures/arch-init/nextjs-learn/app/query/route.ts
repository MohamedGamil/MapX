// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
import { fetchInvoices } from '../lib/data';

export async function GET() {
  return Response.json(await fetchInvoices());
}
