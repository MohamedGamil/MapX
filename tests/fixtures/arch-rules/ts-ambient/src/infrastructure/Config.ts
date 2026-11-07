import process from 'node:process';

export function port(): number {
  return Number(process.env.PORT);
}
