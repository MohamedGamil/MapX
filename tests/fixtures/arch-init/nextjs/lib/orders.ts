// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
import { OrderList } from '../components/OrderList'; // the violation: a library module reaches up into a component

export interface Order {
  total: number;
}

export async function fetchOrders(): Promise<Order[]> {
  return [{ total: 1 }];
}

export function sumOrders(orders: Order[]): number {
  return orders.reduce((n, o) => n + o.total, 0);
}

export const listComponent = OrderList;
