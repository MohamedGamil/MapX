import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Import detectors
import { NestJSDetector } from '../src/frameworks/detectors/nestjs.js';
import { ExpressDetector } from '../src/frameworks/detectors/express.js';
import { NextJSDetector } from '../src/frameworks/detectors/nextjs.js';
import { ReactRouterDetector } from '../src/frameworks/detectors/react-router.js';
import { SvelteKitDetector } from '../src/frameworks/detectors/sveltekit.js';
import { TanstackRouterDetector } from '../src/frameworks/detectors/tanstack-router.js';
import { VueRouterDetector } from '../src/frameworks/detectors/vue-router.js';
import { LaravelDetector } from '../src/frameworks/detectors/laravel.js';
import { SymfonyDetector } from '../src/frameworks/detectors/symfony.js';
import { YiiDetector } from '../src/frameworks/detectors/yii.js';
import { SpringDetector } from '../src/frameworks/detectors/spring.js';
import { RailsDetector } from '../src/frameworks/detectors/rails.js';
import { GoDetector } from '../src/frameworks/detectors/go.js';
import { RustDetector } from '../src/frameworks/detectors/rust.js';
import { VaporDetector } from '../src/frameworks/detectors/vapor.js';
import { WordPressDetector } from '../src/frameworks/detectors/wordpress.js';

describe('Framework Detectors - Monorepo Support', () => {
  let tmp: string;

  const createTmpRepo = async () => {
    tmp = join(tmpdir(), `framework-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    await mkdir(tmp, { recursive: true });
  };

  const cleanupTmpRepo = async () => {
    await rm(tmp, { recursive: true, force: true });
  };

  describe('NestJSDetector', () => {
    const detector = new NestJSDetector();

    it('detects NestJS at root', async () => {
      await createTmpRepo();
      try {
        await writeFile(
          join(tmp, 'package.json'),
          JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } })
        );
        const result = await detector.detect(tmp, ['package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });

    it('detects NestJS inside nested app (monorepo)', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/backend'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/backend/package.json'),
          JSON.stringify({ devDependencies: { '@nestjs/common': '^10.0.0' } })
        );
        const result = await detector.detect(tmp, ['apps/backend/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('ExpressDetector', () => {
    const detector = new ExpressDetector();

    it('detects Express inside nested app (monorepo)', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/api'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/api/package.json'),
          JSON.stringify({ dependencies: { express: '^4.18.0' } })
        );
        const result = await detector.detect(tmp, ['apps/api/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('NextJSDetector', () => {
    const detector = new NextJSDetector();

    it('detects Next.js in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/web'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/web/package.json'),
          JSON.stringify({ dependencies: { next: '^14.0.0' } })
        );
        const result = await detector.detect(tmp, ['apps/web/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('ReactRouterDetector', () => {
    const detector = new ReactRouterDetector();

    it('detects React Router in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/dashboard'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/dashboard/package.json'),
          JSON.stringify({ dependencies: { 'react-router-dom': '^6.20.0' } })
        );
        const result = await detector.detect(tmp, ['apps/dashboard/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('SvelteKitDetector', () => {
    const detector = new SvelteKitDetector();

    it('detects SvelteKit via svelte.config.js in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/blog'), { recursive: true });
        await writeFile(join(tmp, 'apps/blog/svelte.config.js'), 'export default {};');
        const result = await detector.detect(tmp, ['apps/blog/svelte.config.js']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });

    it('detects SvelteKit via dependencies in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/blog'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/blog/package.json'),
          JSON.stringify({ dependencies: { svelte: '^4.0.0' } })
        );
        const result = await detector.detect(tmp, ['apps/blog/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('TanstackRouterDetector', () => {
    const detector = new TanstackRouterDetector();

    it('detects Tanstack Router in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/admin'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/admin/package.json'),
          JSON.stringify({ dependencies: { '@tanstack/react-router': '^1.0.0' } })
        );
        const result = await detector.detect(tmp, ['apps/admin/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('VueRouterDetector', () => {
    const detector = new VueRouterDetector();

    it('detects Vue Router in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/app'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/app/package.json'),
          JSON.stringify({ dependencies: { 'vue-router': '^4.0.0' } })
        );
        const result = await detector.detect(tmp, ['apps/app/package.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('LaravelDetector', () => {
    const detector = new LaravelDetector();

    it('detects Laravel via artisan in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/php-backend/artisan']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });

    it('detects Laravel via composer.json in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/php-backend'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/php-backend/composer.json'),
          JSON.stringify({ require: { 'laravel/framework': '^10.0' } })
        );
        const result = await detector.detect(tmp, ['apps/php-backend/composer.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('SymfonyDetector', () => {
    const detector = new SymfonyDetector();

    it('detects Symfony via lockfile in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/symfony-app/symfony.lock']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });

    it('detects Symfony via composer.json in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/symfony-app'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/symfony-app/composer.json'),
          JSON.stringify({ require: { 'symfony/framework-bundle': '^6.0' } })
        );
        const result = await detector.detect(tmp, ['apps/symfony-app/composer.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('YiiDetector', () => {
    const detector = new YiiDetector();

    it('detects Yii via composer.json in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/yii-app'), { recursive: true });
        await writeFile(
          join(tmp, 'apps/yii-app/composer.json'),
          JSON.stringify({ require: { 'yiisoft/yii2': '^2.0' } })
        );
        const result = await detector.detect(tmp, ['apps/yii-app/composer.json']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('SpringDetector', () => {
    const detector = new SpringDetector();

    it('detects Spring via pom.xml in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/java-api/pom.xml']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });

    it('detects Spring via build.gradle in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/java-api/build.gradle']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('RailsDetector', () => {
    const detector = new RailsDetector();

    it('detects Rails via Gemfile in monorepo', async () => {
      await createTmpRepo();
      try {
        await mkdir(join(tmp, 'apps/ruby-api'), { recursive: true });
        await writeFile(join(tmp, 'apps/ruby-api/Gemfile'), "gem 'rails'\n");
        const result = await detector.detect(tmp, ['apps/ruby-api/Gemfile']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('GoDetector', () => {
    const detector = new GoDetector();

    it('detects Go via go.mod in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/go-api/go.mod']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('RustDetector', () => {
    const detector = new RustDetector();

    it('detects Rust via Cargo.toml in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/rust-api/Cargo.toml']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('VaporDetector', () => {
    const detector = new VaporDetector();

    it('detects Vapor via Package.swift in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/swift-api/Package.swift']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });

  describe('WordPressDetector', () => {
    const detector = new WordPressDetector();

    it('detects WordPress via wp-config.php in monorepo', async () => {
      await createTmpRepo();
      try {
        const result = await detector.detect(tmp, ['apps/wp-site/wp-config.php']);
        expect(result).toBe(true);
      } finally {
        await cleanupTmpRepo();
      }
    });
  });
});
