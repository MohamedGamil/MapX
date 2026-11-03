// Synthetic fixture for M5-17 (mapx arch init --preset feature-sliced). Not a real application.
import type { Product } from '../entities/Product';
import { request } from '../shared/api';

export function addToCart(product: Product): string {
  return request(`/cart/${product.url}`);
}
