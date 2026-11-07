export async function listOrders() {
  return fetch('/api/orders');
}
