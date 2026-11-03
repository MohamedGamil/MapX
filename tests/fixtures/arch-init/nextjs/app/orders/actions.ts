// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
// A server action colocated with its route (review of M5-17-R1): the Actions layer, which a client
// component may call.
'use server';
import { sumOrders, type Order } from '../../lib/orders';

export async function placeOrder(orders: Order[]): Promise<number> {
  return sumOrders(orders);
}
