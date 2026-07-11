import { describe, it, expect } from 'vitest';
import { RoleClassifier } from '../src/core/role-classifier.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

function makeStore(
  symbols: Record<string, any[]> = {},
  fanIn = 0,
  fanOut = 0,
  imports: Array<{ target_file: string }> = []
): Store {
  return {
    getSymbolsForFile: (fp: string) => symbols[fp] ?? [],
    getEdgesForFile: () => [],
    getReverseEdges: () => [],
    raw: {
      // Differentiate fan-in vs fan-out by inspecting the SQL string
      prepare: (sql: string) => ({
        get: (_fp: string) => ({
          count: sql.includes('target_file') ? fanIn : fanOut,
        }),
        all: (_fp: string) => imports,
      }),
    },
  } as unknown as Store;
}

const fullStack: CodebaseProfile = {
  archetype: 'full-stack',
  archetypeConfidence: 0.8,
  detectedFrameworks: ['express'],
  detectedPatterns: ['mvc'],
  dominantLanguages: ['typescript'],
  hasBackend: true,
  hasFrontend: true,
  isMonorepo: false,
  componentBoundaries: [],
};

const backendOnly: CodebaseProfile = { ...fullStack, hasFrontend: false, archetype: 'web-api' };
const frontendOnly: CodebaseProfile = { ...fullStack, hasBackend: false, archetype: 'web-app' };
const cliProfile: CodebaseProfile = { ...fullStack, archetype: 'cli-tool', hasBackend: false, hasFrontend: false };
const libraryProfile: CodebaseProfile = { ...fullStack, archetype: 'library', hasBackend: false, hasFrontend: false };
const mobileProfile: CodebaseProfile = { ...fullStack, archetype: 'mobile-app', hasFrontend: true, hasBackend: false };

// ─────────────────────────────────────────────────────────────────
// Universal high-priority path signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — path signals', () => {
  it('classifies test files via path segment', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('tests/foo.test.ts', 'r', fullStack).role).toBe('test');
    expect(c.classify('src/__tests__/foo.ts', 'r', fullStack).role).toBe('test');
    expect(c.classify('src/foo.spec.ts', 'r', fullStack).role).toBe('test');
  });

  it('classifies docs via path', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('docs/guide.ts', 'r', fullStack).role).toBe('docs');
  });

  it('classifies config files', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('config/settings.ts', 'r', fullStack).role).toBe('config');
    expect(c.classify('src/app.config.ts', 'r', fullStack).role).toBe('config');
    expect(c.classify('src/.env.ts', 'r', fullStack).role).toBe('config');
  });

  it('classifies types/interfaces files', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/types/index.ts', 'r', fullStack).role).toBe('types');
    expect(c.classify('src/interfaces/IUser.ts', 'r', fullStack).role).toBe('types');
    expect(c.classify('src/typings/global.d.ts', 'r', fullStack).role).toBe('types');
    expect(c.classify('src/models.types.ts', 'r', fullStack).role).toBe('types');
  });

  it('classifies shared/utils folders', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/utils/string.ts', 'r', fullStack).role).toBe('shared');
    expect(c.classify('src/helpers/date.ts', 'r', fullStack).role).toBe('shared');
    expect(c.classify('src/common/base.ts', 'r', fullStack).role).toBe('shared');
  });

  it('classifies markdown always as docs', () => {
    const c = new RoleClassifier(makeStore());
    const result = c.classify('CONTRIBUTING.md', 'r', fullStack);
    expect(result.role).toBe('docs');
    expect(result.confidence).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────
// CLI / Library archetype signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — cli/library archetype path signals', () => {
  it('classifies cli folder as cli', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/cli/run.ts', 'r', cliProfile).role).toBe('cli');
    expect(c.classify('src/commands/deploy.ts', 'r', cliProfile).role).toBe('cli');
  });

  it('classifies main.ts as cli entry for cli archetype', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/main.ts', 'r', cliProfile).role).toBe('cli');
  });

  it('classifies parsers folder', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/parsers/ts.ts', 'r', cliProfile).role).toBe('parsers');
    expect(c.classify('src/my-parser.ts', 'r', libraryProfile).role).toBe('parsers');
  });

  it('classifies plugins/adapters folder', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/plugins/logger.ts', 'r', cliProfile).role).toBe('plugins');
    expect(c.classify('src/adapters/redis.ts', 'r', libraryProfile).role).toBe('plugins');
  });

  it('classifies core/domain/engine folder', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/core/engine.ts', 'r', cliProfile).role).toBe('core');
    expect(c.classify('src/domain/user.ts', 'r', libraryProfile).role).toBe('core');
  });
});

// ─────────────────────────────────────────────────────────────────
// Backend path signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — backend path signals', () => {
  it('classifies api/routes/controllers', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/routes/users.ts', 'r', backendOnly).role).toBe('api');
    expect(c.classify('src/controllers/UserController.ts', 'r', backendOnly).role).toBe('api');
    expect(c.classify('src/endpoints/healthz.ts', 'r', backendOnly).role).toBe('api');
    expect(c.classify('src/handlers/webhook.ts', 'r', backendOnly).role).toBe('api');
  });

  it('classifies middleware/guards/interceptors', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/middleware/auth.ts', 'r', backendOnly).role).toBe('middleware');
    expect(c.classify('src/guards/roles.ts', 'r', backendOnly).role).toBe('middleware');
    expect(c.classify('src/interceptors/log.ts', 'r', backendOnly).role).toBe('middleware');
  });

  it('classifies services/usecases/domain', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/services/mailer.ts', 'r', backendOnly).role).toBe('service');
    expect(c.classify('src/usecases/CreateUser.ts', 'r', backendOnly).role).toBe('service');
    expect(c.classify('src/logic/billing.ts', 'r', backendOnly).role).toBe('service');
  });

  it('classifies db/models/repositories/data', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/db/schema.ts', 'r', backendOnly).role).toBe('data');
    expect(c.classify('src/models/user.ts', 'r', backendOnly).role).toBe('data');
    expect(c.classify('src/repositories/UserRepo.ts', 'r', backendOnly).role).toBe('data');
    expect(c.classify('src/migrations/001.ts', 'r', backendOnly).role).toBe('data');
  });

  it('classifies auth/identity directory', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/auth/jwt.ts', 'r', backendOnly).role).toBe('auth');
    expect(c.classify('src/identity/provider.ts', 'r', backendOnly).role).toBe('auth');
  });

  it('classifies integration/clients/external/sdk', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/clients/stripe.ts', 'r', backendOnly).role).toBe('integration');
    expect(c.classify('src/external/sendgrid.ts', 'r', backendOnly).role).toBe('integration');
    expect(c.classify('src/sdk/twilio.ts', 'r', backendOnly).role).toBe('integration');
  });
});

// ─────────────────────────────────────────────────────────────────
// Frontend path signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — frontend path signals', () => {
  it('classifies pages/screens/views', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/pages/Home.tsx', 'r', frontendOnly).role).toBe('pages');
    expect(c.classify('src/screens/Profile.tsx', 'r', frontendOnly).role).toBe('pages');
    expect(c.classify('src/views/Dashboard.tsx', 'r', frontendOnly).role).toBe('pages');
  });

  it('classifies components/widgets/ui/layout', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/components/Button.tsx', 'r', frontendOnly).role).toBe('components');
    expect(c.classify('src/widgets/Card.tsx', 'r', frontendOnly).role).toBe('components');
    expect(c.classify('src/ui/Modal.tsx', 'r', frontendOnly).role).toBe('components');
  });

  it('classifies store/state/reducers/actions', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/store/index.ts', 'r', frontendOnly).role).toBe('state');
    expect(c.classify('src/reducers/auth.ts', 'r', frontendOnly).role).toBe('state');
    expect(c.classify('src/actions/user.ts', 'r', frontendOnly).role).toBe('state');
  });

  it('classifies hooks/composables', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/hooks/useAuth.ts', 'r', frontendOnly).role).toBe('hooks');
    expect(c.classify('src/composables/useForm.ts', 'r', frontendOnly).role).toBe('hooks');
  });

  it('classifies styles/theme/css files', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/styles/global.ts', 'r', frontendOnly).role).toBe('styles');
    expect(c.classify('src/theme/colors.ts', 'r', frontendOnly).role).toBe('styles');
    expect(c.classify('src/app.scss', 'r', frontendOnly).role).toBe('styles');
  });

  it('classifies assets/images/fonts/icons', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/assets/logo.ts', 'r', frontendOnly).role).toBe('assets');
    expect(c.classify('public/fonts/roboto.ts', 'r', frontendOnly).role).toBe('assets');
  });
});

// ─────────────────────────────────────────────────────────────────
// Flutter-specific path signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — Flutter path signals', () => {
  it('classifies blocs/cubits as state', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/blocs/auth_bloc.dart', 'r', mobileProfile).role).toBe('state');
    expect(c.classify('lib/cubits/counter_cubit.dart', 'r', mobileProfile).role).toBe('state');
  });

  it('classifies providers/notifiers as state', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/providers/auth_provider.dart', 'r', mobileProfile).role).toBe('state');
    expect(c.classify('lib/notifiers/theme.dart', 'r', mobileProfile).role).toBe('state');
  });

  it('classifies repositories/datasources as data', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/repositories/user_repo.dart', 'r', mobileProfile).role).toBe('data');
    expect(c.classify('lib/datasources/remote.dart', 'r', mobileProfile).role).toBe('data');
  });

  it('classifies models/entities as data for dart files', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/models/user.dart', 'r', mobileProfile).role).toBe('data');
    expect(c.classify('lib/entities/product.dart', 'r', mobileProfile).role).toBe('data');
  });

  it('classifies routes/router/navigation as api for dart files', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/routes/app_router.dart', 'r', mobileProfile).role).toBe('api');
    expect(c.classify('lib/navigation/navigator.dart', 'r', mobileProfile).role).toBe('api');
  });

  it('classifies main.dart as entry', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('lib/main.dart', 'r', mobileProfile).role).toBe('entry');
  });
});

// ─────────────────────────────────────────────────────────────────
// Default entry files
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — entry point defaults', () => {
  it('classifies index.ts/app.ts as entry', () => {
    const c = new RoleClassifier(makeStore());
    expect(c.classify('src/index.ts', 'r', fullStack).role).toBe('entry');
    expect(c.classify('src/app.ts', 'r', fullStack).role).toBe('entry');
  });
});

// ─────────────────────────────────────────────────────────────────
// Naming signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — naming signals', () => {
  it('classifies by Controller/Handler/Resolver suffix', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'UserController' }] });
    const c = new RoleClassifier(store);
    const r = c.classify('src/foo.ts', 'r', fullStack);
    expect(r.role).toBe('api');
  });

  it('classifies by Service/UseCase suffix', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'AuthService' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('service');
  });

  it('classifies by Repository/DAO/Model/Entity suffix', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'UserRepository' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('data');
  });

  it('classifies by Middleware/Guard/Interceptor suffix', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'AuthGuard' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('middleware');
  });

  it('classifies by Widget/Screen/Page suffix', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'LoginScreen' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('components');
  });

  it('classifies by Bloc/Cubit/Notifier suffix', () => {
    const store = makeStore({ 'src/foo.dart': [{ kind: 'class', name: 'AuthBloc' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.dart', 'r', fullStack).role).toBe('state');
  });

  it('classifies use* functions as hooks', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'function', name: 'useAuth' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('hooks');
  });

  it('classifies Dto/Type/Props suffixes as types', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'UserDto' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('types');
  });

  it('classifies Test/Spec suffix as test', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'UserSpec' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('test');
  });

  it('classifies Config/Options suffix as config', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'AppConfig' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('config');
  });

  it('classifies Util/Helper suffix as shared', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'StringUtil' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('shared');
  });

  it('classifies Parser suffix as parsers', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'CsvParser' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('parsers');
  });

  it('classifies Plugin/Adapter suffix as plugins', () => {
    const store = makeStore({ 'src/foo.ts': [{ kind: 'class', name: 'RedisAdapter' }] });
    const c = new RoleClassifier(store);
    expect(c.classify('src/foo.ts', 'r', fullStack).role).toBe('plugins');
  });

  it('returns null signal when no symbols', () => {
    const store = makeStore({});
    const c = new RoleClassifier(store);
    // A file with no symbols and a path with no signal → role falls to 'other'
    const r = c.classify('src/mysterious.ts', 'r', fullStack);
    expect(r).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Framework signal
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — framework signal', () => {
  it('classifies as api when file is a route handler', () => {
    const c = new RoleClassifier(makeStore());
    const routes = [{ handlerFile: 'src/routes/users.ts' }];
    const r = c.classify('src/routes/users.ts', 'r', backendOnly, routes, []);
    expect(r.role).toBe('api');
  });

  it('classifies as middleware when file is a hook handler', () => {
    const c = new RoleClassifier(makeStore());
    const hooks = [{ handlerFile: 'src/middleware/auth.ts' }];
    // Make it so path signal doesn't dominate
    const r = c.classify('src/middleware/auth.ts', 'r', backendOnly, [], hooks);
    expect(r.role).toBe('middleware');
  });
});

// ─────────────────────────────────────────────────────────────────
// Override logic
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — overrides', () => {
  it('respects glob overrides with highest priority', () => {
    const config = { settings: { architecture: { overrides: { 'src/special/**': 'service' } } } };
    const c = new RoleClassifier(makeStore(), config);
    const r = c.classify('src/special/thing.ts', 'r', fullStack);
    expect(r.role).toBe('service');
    expect(r.confidence).toBe(1.0);
  });

  it('respects customRoles list with a string path', () => {
    const config = {
      settings: {
        architecture: {
          customRoles: [{ name: 'infra', paths: 'src/infra/**' }],
        },
      },
    };
    const c = new RoleClassifier(makeStore(), config);
    const r = c.classify('src/infra/db.ts', 'r', fullStack);
    expect(r.role).toBe('infra');
    expect(r.confidence).toBe(1.0);
  });

  it('respects customRoles list with array paths', () => {
    const config = {
      settings: {
        architecture: {
          customRoles: [{ name: 'ops', paths: ['deploy/**', 'infra/**'] }],
        },
      },
    };
    const c = new RoleClassifier(makeStore(), config);
    expect(c.classify('infra/terraform.ts', 'r', fullStack).role).toBe('ops');
    expect(c.classify('deploy/pipeline.ts', 'r', fullStack).role).toBe('ops');
  });
});


describe('RoleClassifier', () => {
  const mockStore = {
    getSymbolsForFile: () => [],
    getEdgesForFile: () => [],
    getReverseEdges: () => [],
    raw: {
      prepare: () => ({ get: () => ({ count: 0 }) })
    }
  } as unknown as Store;

  const mockProfile: CodebaseProfile = {
    archetype: 'full-stack',
    archetypeConfidence: 0.8,
    detectedFrameworks: ['express', 'react'],
    detectedPatterns: ['mvc'],
    dominantLanguages: ['typescript'],
    hasBackend: true,
    hasFrontend: true,
    isMonorepo: false,
    componentBoundaries: []
  };

  it('classifies UI components correctly based on path', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/components/Header.tsx', 'test-repo', mockProfile);

    expect(result.role).toBe('components');
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('classifies API route files correctly based on path and naming', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/routes/userRoute.ts', 'test-repo', mockProfile);

    expect(result.role).toBe('api');
  });

  it('respects user config overrides', () => {
    const mockConfig = {
      settings: {
        architecture: {
          overrides: {
            'src/custom-folder/**': 'service'
          }
        }
      }
    };
    const classifier = new RoleClassifier(mockStore, mockConfig);
    const result = classifier.classify('src/custom-folder/my-file.ts', 'test-repo', mockProfile);

    expect(result.role).toBe('service');
    expect(result.confidence).toBe(1.0);
    expect(result.signals[0].reason).toContain('Explicitly overridden');
  });

  it('classifies test files correctly', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/components/Header.test.tsx', 'test-repo', mockProfile);

    expect(result.role).toBe('test');
  });

  it('classifies core tool logic for tool archetypes', () => {
    const cliProfile: CodebaseProfile = {
      ...mockProfile,
      archetype: 'cli-tool',
      hasBackend: false,
      hasFrontend: false
    };
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/core/engine.ts', 'test-repo', cliProfile);

    expect(result.role).toBe('core');
  });

  it('classifies markdown files as docs', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('docs/README.md', 'test-repo', mockProfile);

    expect(result.role).toBe('docs');
    expect(result.confidence).toBe(1.0);
    expect(result.signals[0].reason).toContain('Markdown files are always classified');
  });
});

// ─────────────────────────────────────────────────────────────────
// Topology signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — topology signals', () => {
  it('classifies zero-fan-in + non-zero-fan-out as api (backend profile)', () => {
    // fanIn=0, fanOut=5 → zero fan-in, non-zero fan-out → 'api' for backend
    const store = makeStore({}, 0, 5);
    const c = new RoleClassifier(store);
    // Use a path that has no other strong path signal
    const result = c.classify('src/mysterious.ts', 'r', backendOnly);
    const topSig = result.signals.find(s => s.source === 'topology');
    expect(topSig).toBeDefined();
    expect(topSig?.role).toBe('api');
  });

  it('classifies zero-fan-in + non-zero-fan-out as entry (non-backend profile)', () => {
    const store = makeStore({}, 0, 5);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', frontendOnly);
    const topSig = result.signals.find(s => s.source === 'topology');
    expect(topSig).toBeDefined();
    expect(topSig?.role).toBe('entry');
  });

  it('classifies high-fan-in + zero-fan-out as shared (.ts file)', () => {
    const store = makeStore({}, 15, 0);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const topSig = result.signals.find(s => s.source === 'topology');
    expect(topSig).toBeDefined();
    expect(topSig?.role).toBe('shared');
  });

  it('classifies high-fan-in + zero-fan-out .d.ts file as types (path signal dominates)', () => {
    // path.extname('foo.d.ts') === '.ts', so topology signal returns 'shared',
    // but the path signal fires first with 'types' for .d.ts basename and wins.
    const store = makeStore({}, 15, 0);
    const c = new RoleClassifier(store);
    const result = c.classify('src/something.d.ts', 'r', fullStack);
    // Path signal for .d.ts → 'types' (confidence 0.95, weight 0.30) beats topology 'shared'
    expect(result.role).toBe('types');
  });

  it('returns no topology signal when both fan-in and fan-out are moderate', () => {
    const store = makeStore({}, 3, 3);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const topSig = result.signals.find(s => s.source === 'topology');
    expect(topSig).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Imports signals
// ─────────────────────────────────────────────────────────────────

describe('RoleClassifier — imports signals', () => {
  it('classifies as api when importing express/nestjs', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/express/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig?.role).toBe('api');
  });

  it('classifies as data when importing sequelize/typeorm', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/sequelize/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig?.role).toBe('data');
  });

  it('classifies as components when importing react/vue', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/react/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig?.role).toBe('components');
  });

  it('classifies as state when importing redux/zustand', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/redux/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig?.role).toBe('state');
  });

  it('classifies as test when importing vitest/jest', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/vitest/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig?.role).toBe('test');
  });

  it('returns no imports signal when imports do not match any known library', () => {
    const store = makeStore({}, 0, 0, [
      { target_file: 'node_modules/lodash/index.js' },
    ]);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig).toBeUndefined();
  });

  it('returns no imports signal when imports list is empty', () => {
    const store = makeStore({}, 0, 0, []);
    const c = new RoleClassifier(store);
    const result = c.classify('src/mysterious.ts', 'r', fullStack);
    const impSig = result.signals.find(s => s.source === 'imports');
    expect(impSig).toBeUndefined();
  });
});
