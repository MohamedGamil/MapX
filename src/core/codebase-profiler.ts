import type { Store } from './store.js';
import type { CodebaseProfile, CodebaseArchetype, ArchPattern } from '../types.js';
import * as path from 'node:path';

export class CodebaseProfiler {
  constructor(private store: Store) {}

  /**
   * Profiles the repository based on stored files, extensions, paths, and active frameworks.
   */
  profile(repoName: string, activeFrameworks: string[] = []): CodebaseProfile {
    const files = this.store.getAllFiles(repoName);
    const filePaths = files.map(f => f.path as string);

    // 1. Language breakdown & file extensions
    const extCount: Record<string, number> = {};
    const langCount: Record<string, number> = {};
    for (const f of files) {
      const filePath = f.path as string;
      const ext = path.extname(filePath).toLowerCase();
      extCount[ext] = (extCount[ext] || 0) + 1;
      const lang = ((f.language as string) || 'unknown').toLowerCase();
      langCount[lang] = (langCount[lang] || 0) + 1;
    }

    const dominantLanguages = Object.entries(langCount)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);

    // 2. Directory structure signals
    let hasBin = false;
    let hasRoutes = false;
    let hasControllers = false;
    let hasComponents = false;
    let hasPages = false;
    let hasPackages = false;
    let hasMobile = false;
    let hasSrc = false;

    for (const p of filePaths) {
      const lower = p.toLowerCase();
      const parts = lower.split('/');

      if (parts.includes('bin') || parts.includes('commands') || lower.includes('cli.ts') || lower.includes('cli.js')) {
        hasBin = true;
      }
      if (parts.includes('routes') || parts.includes('route') || lower.includes('.route.')) {
        hasRoutes = true;
      }
      if (parts.includes('controllers') || parts.includes('controller') || lower.includes('.controller.')) {
        hasControllers = true;
      }
      if (parts.includes('components') || parts.includes('widgets') || parts.includes('views')) {
        hasComponents = true;
      }
      if (parts.includes('pages') || parts.includes('screens')) {
        hasPages = true;
      }
      if (parts.includes('packages') || parts.includes('apps')) {
        hasPackages = true;
      }
      if (parts.includes('android') || parts.includes('ios') || parts.includes('cordova') || parts.includes('capacitor')) {
        hasMobile = true;
      }
      if (parts.includes('src')) {
        hasSrc = true;
      }
    }

    // 3. Frontend / Backend checks
    const frontendExts = ['.vue', '.svelte', '.jsx', '.tsx', '.html', '.css', '.scss', '.sass', '.less'];
    let frontendFileCount = 0;
    for (const [ext, count] of Object.entries(extCount)) {
      if (frontendExts.includes(ext)) {
        frontendFileCount += count;
      }
    }

    const hasFrontend = frontendFileCount > 0 || hasComponents || hasPages;
    const hasBackend = hasRoutes || hasControllers || filePaths.some(p => {
      const base = path.basename(p).toLowerCase();
      return base === 'server.ts' || base === 'server.js' || base === 'app.ts' || base === 'app.js';
    });

    const isMonorepo = hasPackages && filePaths.some(p => p.includes('/package.json') && p.split('/').length > 2);

    // 4. Archetype Determination
    let archetype: CodebaseArchetype = 'mixed';
    let archetypeConfidence = 0.5;

    if (isMonorepo) {
      archetype = 'monorepo';
      archetypeConfidence = 0.85;
    } else if (hasMobile) {
      archetype = 'mobile-app';
      archetypeConfidence = 0.8;
    } else if (hasBin && !hasRoutes && !hasControllers && !hasFrontend) {
      archetype = 'cli-tool';
      archetypeConfidence = 0.9;
    } else if (hasBackend && !hasFrontend) {
      archetype = 'web-api';
      archetypeConfidence = 0.85;
    } else if (hasFrontend && !hasBackend && !hasRoutes && !hasControllers) {
      archetype = 'web-app';
      archetypeConfidence = 0.85;
    } else if (hasBackend && hasFrontend) {
      archetype = 'full-stack';
      archetypeConfidence = 0.8;
    } else if (hasSrc && !hasBin && !hasRoutes && !hasControllers && !hasComponents && !hasPages) {
      archetype = 'library';
      archetypeConfidence = 0.75;
    }

    // 5. Architecture pattern heuristic
    const detectedPatterns: ArchPattern[] = [];
    if (hasControllers && hasComponents) {
      detectedPatterns.push('mvc');
    }
    if (hasRoutes && hasControllers) {
      detectedPatterns.push('layered');
    }
    // Clean/Hexagonal hints: domain/usecase/repository structure
    const hasDomain = filePaths.some(p => p.toLowerCase().includes('/domain/'));
    const hasUsecase = filePaths.some(p => p.toLowerCase().includes('/usecases/') || p.toLowerCase().includes('/usecase/'));
    if (hasDomain && hasUsecase) {
      detectedPatterns.push('clean');
    }
    if (detectedPatterns.length === 0) {
      detectedPatterns.push('flat');
    }

    // Determine package component boundaries
    const componentBoundaries: string[] = [];
    if (isMonorepo) {
      const boundaries = new Set<string>();
      for (const p of filePaths) {
        const parts = p.split('/');
        if (parts.length > 2 && (parts[parts.length - 1] === 'package.json' || parts[parts.length - 1] === 'cargo.toml')) {
          boundaries.add(parts.slice(0, -1).join('/'));
        }
      }
      componentBoundaries.push(...boundaries);
    }

    return {
      archetype,
      archetypeConfidence,
      detectedFrameworks: activeFrameworks,
      detectedPatterns,
      dominantLanguages,
      hasBackend: hasBackend || archetype === 'web-api' || archetype === 'full-stack',
      hasFrontend: hasFrontend || archetype === 'web-app' || archetype === 'full-stack' || archetype === 'mobile-app',
      isMonorepo,
      componentBoundaries,
    };
  }
}
