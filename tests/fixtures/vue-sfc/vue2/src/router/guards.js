// Navigation guards (M3-11): a guard redirects through the router module's import.
import router from '../router';

export function requireTicketId(to) {
  if (!to.params.id) {
    router.replace('/tickets');
  }
}
