// Synthetic fixture for M5-17 (mapx arch init --preset feature-sliced). Not a real application.
import { request } from '../shared/api';
import { addToCart } from '../features/AddToCart';

export class Product {
  readonly url = request('/products/1');
  // The violation: an entity reaches up into a feature.
  buy() {
    return addToCart(this);
  }
}
