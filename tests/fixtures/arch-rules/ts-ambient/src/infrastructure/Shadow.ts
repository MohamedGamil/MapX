// None of these is the global: a parameter, a local, a catch variable and an import shadow it, and a
// string or a comment only names it (window, document.title, process.env.HOME).
import { document as page } from './Page';

export class Shadow {
  param(window: { name: string }): string {
    return window.name + 'process.env.HOME';
  }

  local(): string {
    const document = { title: 'local' };
    const process = { env: 'x' };
    return document.title + process.env;
  }

  caught(): string {
    try {
      return page.title;
    } catch (globalThis) {
      return String(globalThis);
    }
  }

  store(): string {
    const localStorage = new Map<string, string>();
    return localStorage.get('k') ?? `${page.title}`;
  }
}
