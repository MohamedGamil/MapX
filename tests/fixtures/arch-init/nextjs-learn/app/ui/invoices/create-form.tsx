// Synthetic fixture for M5-17-R1 (review): the Next.js Learn layout, ui/ and lib/ inside app/. Not a real application.
'use client';
import { createInvoice } from '../../lib/actions';

export default function CreateForm() {
  return <form action={createInvoice} />;
}
