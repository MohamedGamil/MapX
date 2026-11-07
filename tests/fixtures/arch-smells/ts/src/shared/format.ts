// Shared: one current helper and one deprecated helper.
export function label(id: string): string {
  return `#${id}`;
}

/** @deprecated use label() */
export function legacyLabel(id: string): string {
  return `order ${id}`;
}
