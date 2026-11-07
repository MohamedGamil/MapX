// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
import { useMemo } from 'react';
import { sumOrders, type Order } from '../lib/orders';

export function useTotal(orders: Order[]): number {
  return useMemo(() => sumOrders(orders), [orders]);
}
