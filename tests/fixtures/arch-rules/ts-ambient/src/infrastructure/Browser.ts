export class Browser {
  theme(): string {
    return window.localStorage.getItem('theme') ?? document.title;
  }

  host(): string {
    const origin = globalThis.location?.host ?? '';
    return localStorage.getItem('origin') ?? origin;
  }
}
