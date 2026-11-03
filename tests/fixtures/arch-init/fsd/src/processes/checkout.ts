// Synthetic fixture for M5-17 (mapx arch init --preset feature-sliced). Not a real application.
import { homePage } from '../pages/HomePage';
import { addToCart } from '../features/AddToCart';

export const checkout = { start: homePage, add: addToCart };
