import { ref, watchEffect } from 'vue';

export interface Product {
  id: number;
  name: string;
  price: number;
}

export function useProduct(id: string | string[]) {
  const product = ref<Product | null>(null);

  watchEffect(async () => {
    const response = await fetch(`/api/products/${id}`);
    product.value = await response.json();
  });

  return { product };
}
