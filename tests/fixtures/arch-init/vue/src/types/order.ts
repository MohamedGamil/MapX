// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
// Shared types every layer may use (review of M5-17-R1).
export interface OrderSummary {
  total: number;
}

export function emptyOrder(): OrderSummary {
  return { total: 0 };
}
