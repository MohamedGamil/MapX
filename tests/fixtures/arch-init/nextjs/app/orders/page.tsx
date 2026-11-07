// Synthetic fixture for M5-17-R1 (mapx arch init --preset nextjs). Not a real application.
import { OrderList } from '../../components/OrderList';
import { fetchOrders } from '../../lib/orders';

export default async function OrdersPage() {
  const orders = await fetchOrders();
  return <OrderList orders={orders} />;
}
