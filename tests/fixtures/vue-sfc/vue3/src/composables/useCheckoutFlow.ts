import { useRouter } from 'vue-router';

// A composable that navigates through useRouter() (M3-11); `visited` is a plain array whose push()
// is not navigation.
export function useCheckoutFlow() {
  const router = useRouter();
  const visited: string[] = [];

  function finish(orderId: number) {
    visited.push('/orders');
    router.push({ name: 'order-confirmation', query: { orderId: String(orderId) } });
  }

  return { finish, visited };
}
