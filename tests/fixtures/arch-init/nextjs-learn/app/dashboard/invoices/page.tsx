// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
import { fetchInvoices } from '../../lib/data';
import InvoicesTable from '../../ui/invoices/table';
import CreateForm from '../../ui/invoices/create-form';

export default async function Page() {
  const invoices = await fetchInvoices();
  return <><CreateForm /><InvoicesTable invoices={invoices} /></>;
}
