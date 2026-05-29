import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { RouteBinding, HookBinding } from '../types.js';

export class RouteRegistry {
  private routes: RouteBinding[] = [];
  private hooks: HookBinding[] = [];

  getRoutes(): RouteBinding[] {
    return this.routes;
  }

  getHooks(): HookBinding[] {
    return this.hooks;
  }

  addRoute(route: RouteBinding): void {
    const exists = this.routes.some(r =>
      r.method === route.method &&
      r.path === route.path &&
      r.handlerSymbol === route.handlerSymbol &&
      r.handlerFile === route.handlerFile
    );
    if (!exists) {
      this.routes.push(route);
    }
  }

  addHook(hook: HookBinding): void {
    this.hooks.push(hook);
  }

  clear(): void {
    this.routes = [];
    this.hooks = [];
  }

  clearRepo(repoName: string, filePaths?: Set<string>): void {
    this.routes = this.routes.filter(r => {
      if (r.metadata && r.metadata.repo === repoName) return false;
      if (filePaths) {
        if (filePaths.has(r.handlerFile)) return false;
        if (r.metadata && r.metadata.sourceFile && filePaths.has(r.metadata.sourceFile)) return false;
      }
      return true;
    });
    this.hooks = this.hooks.filter(h => {
      if (h.metadata && h.metadata.repo === repoName) return false;
      if (filePaths) {
        if (filePaths.has(h.handlerFile)) return false;
        if (h.metadata && h.metadata.sourceFile && filePaths.has(h.metadata.sourceFile)) return false;
      }
      return true;
    });
  }

  async load(workspaceRoot: string): Promise<void> {
    const routesPath = join(workspaceRoot, '.mapx', 'routes.json');
    if (existsSync(routesPath)) {
      try {
        const content = await readFile(routesPath, 'utf-8');
        this.routes = JSON.parse(content);
      } catch {
        this.routes = [];
      }
    }

    const hooksPath = join(workspaceRoot, '.mapx', 'hooks.json');
    if (existsSync(hooksPath)) {
      try {
        const content = await readFile(hooksPath, 'utf-8');
        this.hooks = JSON.parse(content);
      } catch {
        this.hooks = [];
      }
    }
  }

  async save(workspaceRoot: string): Promise<void> {
    const routesPath = join(workspaceRoot, '.mapx', 'routes.json');
    const hooksPath = join(workspaceRoot, '.mapx', 'hooks.json');

    try {
      await writeFile(routesPath, JSON.stringify(this.routes, null, 2), 'utf-8');
      await writeFile(hooksPath, JSON.stringify(this.hooks, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save route/hook registry:', err);
    }
  }

  queryRoutes(filters: { framework?: string; method?: string; path?: string }): RouteBinding[] {
    return this.routes.filter(r => {
      if (filters.framework && r.framework.toLowerCase() !== filters.framework.toLowerCase()) {
        return false;
      }
      if (filters.method && r.method.toUpperCase() !== filters.method.toUpperCase()) {
        return false;
      }
      if (filters.path && !r.path.toLowerCase().includes(filters.path.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  queryHooks(filters: { framework?: string; hookType?: string; hookName?: string }): HookBinding[] {
    return this.hooks.filter(h => {
      if (filters.framework && h.framework.toLowerCase() !== filters.framework.toLowerCase()) {
        return false;
      }
      if (filters.hookType && h.hookType.toLowerCase() !== filters.hookType.toLowerCase()) {
        return false;
      }
      if (filters.hookName && !h.hookName.toLowerCase().includes(filters.hookName.toLowerCase())) {
        return false;
      }
      return true;
    });
  }
}
