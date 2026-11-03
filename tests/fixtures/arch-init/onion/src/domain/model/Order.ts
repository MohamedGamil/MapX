// Synthetic fixture for M5-17-R1 (mapx arch init --preset onion). Not a real application.
export class Order {
  constructor(readonly id: number, readonly total: number) {}
}

export interface OrderRepository {
  find(id: number): Order;
}
