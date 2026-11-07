// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
import type { Invoice } from '../../lib/definitions';

export default function InvoicesTable({ invoices }: { invoices: Invoice[] }) {
  return <ul>{invoices.map((i) => <li key={i.id}>{i.amount}</li>)}</ul>;
}
