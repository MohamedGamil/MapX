// Repository: an abstraction of the store, with no dependency of its own. With it, Repository is
// half abstract and stable enough to sit near the main sequence (the abstractness-distance negative).
export interface OrderStore<T> {
  find(id: string): T;
  save(item: T): void;
}
