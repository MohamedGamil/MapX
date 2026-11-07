// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
'use client';
import { useTotal } from '../hooks/useTotal';
import { placeOrder } from '../app/orders/actions';
import type { Order } from '../lib/orders';

export function OrderList({ orders }: { orders: Order[] }) {
  const total = useTotal(orders);
  return <button onClick={() => placeOrder(orders)}>{total}</button>;
}
