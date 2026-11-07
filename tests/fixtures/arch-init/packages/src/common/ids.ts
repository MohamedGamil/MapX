// Synthetic fixture for the review of M5-24.
import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}
