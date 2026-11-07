// Synthetic fixture for M5-24-R3 (review): a workspace symbol named like the express package. A bare
// `express` still names the package, which the manifest lists.
export function express(): string {
  return 'not the package';
}
