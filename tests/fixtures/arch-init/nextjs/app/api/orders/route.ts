// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
import { fetchOrders } from '../../../lib/orders';

export async function GET() {
  return Response.json(await fetchOrders());
}
