// Synthetic (M5-24-R1): ambient access, labelled in expected-externals.json.
export class Order {
  currency(): string {
    return process.env.CURRENCY ?? 'EUR';
  }
}
