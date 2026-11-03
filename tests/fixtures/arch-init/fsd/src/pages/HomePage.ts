// Synthetic fixture for M5-17 (mapx arch init --preset feature-sliced). Not a real application.
import { header } from '../widgets/Header';
import { Product } from '../entities/Product';

export const homePage = { header, product: new Product() };
