// Navigation guards (M3-11): a guard redirects through the router module's import.
import router from '../router';

export function requireTicketId(to) {
  if (!to.params.id) {
    router.replace('/tickets');
  }
}

// A guard written for the router file: it redirects through next() (M3-11-R1).
export function requireAgent(to, from, next) {
  if (!to.meta.agent) next({ name: 'tickets' });
  else next();
}
