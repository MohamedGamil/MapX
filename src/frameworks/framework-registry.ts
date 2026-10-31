import { relative } from 'node:path';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../types.js';
import { findNestedManifestScopes, type ManifestCache } from './utils.js';
import { LaravelDetector } from './detectors/laravel.js';
import { DjangoDetector } from './detectors/django.js';
import { FlaskDetector } from './detectors/flask.js';
import { FastAPIDetector } from './detectors/fastapi.js';
import { ExpressDetector } from './detectors/express.js';
import { NestJSDetector } from './detectors/nestjs.js';
import { ReactRouterDetector } from './detectors/react-router.js';
import { TanstackRouterDetector } from './detectors/tanstack-router.js';
import { NextJSDetector } from './detectors/nextjs.js';
import { SvelteKitDetector } from './detectors/sveltekit.js';
import { VueRouterDetector } from './detectors/vue-router.js';
import { DrupalDetector } from './detectors/drupal.js';
import { RailsDetector } from './detectors/rails.js';
import { SpringDetector } from './detectors/spring.js';
import { GoDetector } from './detectors/go.js';
import { RustDetector } from './detectors/rust.js';
import { AspNetDetector } from './detectors/aspnet.js';
import { VaporDetector } from './detectors/vapor.js';
import { SymfonyDetector } from './detectors/symfony.js';
import { YiiDetector } from './detectors/yii.js';
import { WordPressDetector } from './detectors/wordpress.js';
import { FlutterDetector } from './detectors/flutter.js';

export class FrameworkRegistry {
  private static instance: FrameworkRegistry | null = null;
  private detectors: FrameworkDetector[] = [];

  private constructor() {
    this.register(new LaravelDetector());
    this.register(new DjangoDetector());
    this.register(new FlaskDetector());
    this.register(new FastAPIDetector());
    this.register(new ExpressDetector());
    this.register(new NestJSDetector());
    this.register(new ReactRouterDetector());
    this.register(new TanstackRouterDetector());
    this.register(new NextJSDetector());
    this.register(new SvelteKitDetector());
    this.register(new VueRouterDetector());
    this.register(new DrupalDetector());
    this.register(new RailsDetector());
    this.register(new SpringDetector());
    this.register(new GoDetector());
    this.register(new RustDetector());
    this.register(new AspNetDetector());
    this.register(new VaporDetector());
    this.register(new SymfonyDetector());
    this.register(new YiiDetector());
    this.register(new WordPressDetector());
    this.register(new FlutterDetector());
  }

  static getInstance(): FrameworkRegistry {
    if (!FrameworkRegistry.instance) {
      FrameworkRegistry.instance = new FrameworkRegistry();
    }
    return FrameworkRegistry.instance;
  }

  register(detector: FrameworkDetector): void {
    this.detectors.push(detector);
  }

  getDetectors(): FrameworkDetector[] {
    return this.detectors;
  }

  /**
   * Detectors active for the repo at `projectRoot`. `detect()` activates a detector for the whole
   * repo; failing that, a manifest below the repo root listing one of its `manifestDependencies`
   * activates it for that folder only, and `options.scopes` receives those folders
   * (workspace-relative, like `files`, which are relative to `options.workspaceRoot`). A detector
   * missing from `scopes` is active for the whole repo (M3-07). The manifest helpers `detect()`
   * uses read only the repo root's manifest, even when `files` holds nested ones (M3-07-R1).
   */
  async detectActiveFrameworks(
    projectRoot: string,
    files: string[],
    options: { workspaceRoot?: string; scopes?: Map<string, string[]> } = {},
  ): Promise<FrameworkDetector[]> {
    const active: FrameworkDetector[] = [];
    const workspaceRoot = options.workspaceRoot ?? projectRoot;
    const repoPrefix = relative(workspaceRoot, projectRoot).replace(/\\/g, '/');
    const manifests: ManifestCache = new Map();
    for (const detector of this.detectors) {
      try {
        const isDetected = await detector.detect(projectRoot, files);
        if (isDetected) {
          active.push(detector);
          continue;
        }
        const deps = detector.manifestDependencies;
        if (!deps) continue;
        const scopes = await findNestedManifestScopes(workspaceRoot, repoPrefix, files, deps.manifest, deps.names, manifests);
        if (scopes.length > 0) {
          active.push(detector);
          options.scopes?.set(detector.name, scopes);
        }
      } catch (err) {
        console.error(`Error detecting framework ${detector.name}:`, err);
      }
    }
    return active;
  }
}
