import { describe, it, expect } from 'vitest';
import { FlutterDetector } from '../src/frameworks/detectors/flutter.js';
import type { ScanContext } from '../src/types.js';
import { tmpdir } from 'node:os';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────
// Context mock
// ─────────────────────────────────────────────────────────────────

function makeCtx(symbolMap: Record<string, string> = {}): ScanContext {
  return {
    resolveSymbolToFile: (sym: string) => symbolMap[sym] ?? null,
  } as unknown as ScanContext;
}

// ─────────────────────────────────────────────────────────────────
// detect()
// ─────────────────────────────────────────────────────────────────

describe('FlutterDetector.detect()', () => {
  const d = new FlutterDetector();

  // Use an unknown non-existent path so existsSync returns false and
  // we exercise the file-list fallback branch without any mocking.
  const noFs = '/nonexistent-flutter-project-xyzzy-12345';

  it('returns true when files list contains lib/main.dart', async () => {
    const result = await d.detect(noFs, ['lib/main.dart']);
    expect(result).toBe(true);
  });

  it('returns true when files list contains a /lib/main.dart path', async () => {
    const result = await d.detect(noFs, ['some/nested/lib/main.dart']);
    expect(result).toBe(true);
  });

  it('returns false when no flutter indicators in file list', async () => {
    const result = await d.detect(noFs, ['lib/screens/home.dart', 'lib/app.dart']);
    expect(result).toBe(false);
  });

  it('returns false when file list is empty', async () => {
    const result = await d.detect(noFs, []);
    expect(result).toBe(false);
  });

  it('returns true when pubspec.yaml contains sdk: flutter', async () => {
    const tmp = join(tmpdir(), `flutter-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'pubspec.yaml'), 'name: my_app\nflutter:\n  sdk: flutter\n');
    try {
      const result = await d.detect(tmp, []);
      expect(result).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns false when pubspec.yaml does not mention sdk: flutter', async () => {
    const tmp = join(tmpdir(), `flutter-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'pubspec.yaml'), 'name: my_dart_lib\nversion: 1.0.0\n');
    try {
      const result = await d.detect(tmp, []);
      expect(result).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// extractRoutes()
// ─────────────────────────────────────────────────────────────────

describe('FlutterDetector.extractRoutes()', () => {
  const d = new FlutterDetector();
  const ctx = makeCtx();
  const filePath = 'lib/app.dart';

  it('extracts Navigator.pushNamed route', async () => {
    // Content must contain the word 'dart' to pass the early guard
    const content = `// lib/app.dart
void navigate(BuildContext context) {
  Navigator.pushNamed(context, '/home');
}
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const home = routes.find(r => r.path === '/home');
    expect(home).toBeDefined();
    expect(home?.metadata?.routeType).toBe('navigator-named');
    expect(home?.method).toBe('NAVIGATE');
  });

  it('extracts multiple Navigator.pushNamed calls', async () => {
    const content = `// lib/app.dart
void nav(BuildContext context) {
  Navigator.pushNamed(context, '/home');
  Navigator.pushNamed(context, '/profile');
}
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.some(r => r.path === '/home')).toBe(true);
    expect(routes.some(r => r.path === '/profile')).toBe(true);
  });

  it('extracts MaterialApp routes map', async () => {
    const content = `// lib/app.dart
final app = MaterialApp(
  routes: {
    '/home': (context) => HomeScreen(),
    '/settings': (context) => SettingsScreen(),
  },
);
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const home = routes.find(r => r.path === '/home');
    const settings = routes.find(r => r.path === '/settings');
    expect(home).toBeDefined();
    expect(home?.handlerSymbol).toBe('HomeScreen');
    expect(settings).toBeDefined();
  });

  it('resolves widget handler to its source file via ctx', async () => {
    const ctxWithMap = makeCtx({ HomeWidget: 'lib/screens/home.dart' });
    const content = `// lib/app.dart
final app = MaterialApp(
  routes: {
    '/home': (ctx) => HomeWidget(),
  },
);
`;
    const routes = await d.extractRoutes(filePath, content, ctxWithMap);
    const home = routes.find(r => r.path === '/home');
    expect(home?.handlerFile).toBe('lib/screens/home.dart');
  });

  it('extracts GoRouter routes', async () => {
    const content = `// lib/router.dart
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/profile',
      builder: (context, state) => ProfilePage(),
    ),
  ],
);
`;
    const routes = await d.extractRoutes('lib/router.dart', content, ctx);
    const profile = routes.find(r => r.path === '/profile');
    expect(profile).toBeDefined();
    expect(profile?.metadata?.routeType).toBe('go-router');
  });

  it('extracts auto_route @RoutePage annotations', async () => {
    // Must include 'dart' somewhere in content to pass the early guard
    const content = `// auto_route.dart
@RoutePage()
class HomeScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Scaffold();
}

@RoutePage()
class ProfileScreen extends StatelessWidget {}
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    const home = routes.find(r => r.handlerSymbol === 'HomeScreen');
    expect(home).toBeDefined();
    expect(home?.metadata?.routeType).toBe('auto-route');
    // The path should be kebab-cased from the class name (minus Page/Screen/View suffix)
    expect(home?.path).toBe('/home');

    const profile = routes.find(r => r.handlerSymbol === 'ProfileScreen');
    expect(profile).toBeDefined();
    expect(profile?.path).toBe('/profile');
  });

  it('returns empty array when filePath is not a .dart file', async () => {
    const content = `Navigator.pushNamed(context, '/home');`;
    const routes = await d.extractRoutes('lib/app.js', content, ctx);
    expect(routes).toHaveLength(0);
  });

  it('extracts routes from .dart file even without "dart" in content', async () => {
    const content = `
void navigate(BuildContext context) {
  Navigator.pushNamed(context, '/settings');
}
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.some(r => r.path === '/settings')).toBe(true);
  });

  it('infers hyphenated paths for multi-word auto_route classes', async () => {
    const content = `
@RoutePage()
class UserProfileSettingsScreen extends StatelessWidget {}
`;
    const routes = await d.extractRoutes(filePath, content, ctx);
    const route = routes.find(r => r.handlerSymbol === 'UserProfileSettingsScreen');
    expect(route).toBeDefined();
    expect(route?.path).toBe('/user-profile-settings');
  });
});

// ─────────────────────────────────────────────────────────────────
// extractHooks()
// ─────────────────────────────────────────────────────────────────

describe('FlutterDetector.extractHooks()', () => {
  const d = new FlutterDetector();
  const ctx = makeCtx();
  // Content must contain '.dart' for hooks to be extracted (FlutterDetector guard)
  const fileHeader = '// my_widget.dart\n';

  it('extracts lifecycle methods from StatefulWidget', async () => {
    const content = fileHeader + `
class MyWidgetState extends State<MyWidget> {
  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container();
  }
}
`;
    const hooks = await d.extractHooks('lib/my_widget.dart', content, ctx);
    const names = hooks.map(h => h.hookName);
    expect(names).toContain('initState');
    expect(names).toContain('dispose');
    expect(names).toContain('build');
  });

  it('attaches the enclosing public class name to handlerSymbol', async () => {
    // FlutterDetector looks for class names matching [A-Z][a-zA-Z0-9_]*
    const content = fileHeader + `
class AuthScreen extends StatefulWidget {
  @override
  void initState() { super.initState(); }
}
`;
    const hooks = await d.extractHooks('lib/auth.dart', content, ctx);
    const init = hooks.find(h => h.hookName === 'initState');
    expect(init?.handlerSymbol).toContain('AuthScreen');
  });

  it('extracts BLoC patterns (BlocBuilder)', async () => {
    const content = fileHeader + `
Widget build(BuildContext context) {
  return BlocBuilder<AuthBloc, AuthState>(
    builder: (ctx, state) => Text(state.name),
  );
}
`;
    const hooks = await d.extractHooks('lib/bloc_view.dart', content, ctx);
    const names = hooks.map(h => h.hookName);
    expect(names).toContain('BlocBuilder');
  });

  it('extracts BlocListener pattern', async () => {
    const content = fileHeader + `
Widget build(BuildContext context) {
  return BlocListener<AuthBloc, AuthState>(listener: (ctx, state) {});
}
`;
    const hooks = await d.extractHooks('lib/bloc_listener.dart', content, ctx);
    expect(hooks.some(h => h.hookName === 'BlocListener')).toBe(true);
  });

  it('extracts Riverpod patterns (ref.watch, ref.read, ConsumerWidget)', async () => {
    const content = fileHeader + `
class MyWidget extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final repo = ref.read(repoProvider);
    return Text(auth.name);
  }
}
`;
    const hooks = await d.extractHooks('lib/riverpod_view.dart', content, ctx);
    const names = hooks.map(h => h.hookName);
    expect(names).toContain('ref.watch');
    expect(names).toContain('ConsumerWidget');
  });

  it('extracts Provider patterns (context.watch, context.read)', async () => {
    const content = fileHeader + `
final user = context.watch<UserModel>();
final repo = context.read<UserRepository>();
`;
    const hooks = await d.extractHooks('lib/provider_widget.dart', content, ctx);
    const names = hooks.map(h => h.hookName);
    expect(names).toContain('context.watch');
    expect(names).toContain('context.read');
  });

  it('extracts GetX patterns (Obx)', async () => {
    const content = fileHeader + `
Widget build(BuildContext context) {
  return Obx(() => Text(controller.name.value));
}
`;
    const hooks = await d.extractHooks('lib/getx_view.dart', content, ctx);
    expect(hooks.some(h => h.hookName === 'Obx')).toBe(true);
  });

  it('extracts MultiBlocProvider pattern', async () => {
    const content = fileHeader + `
Widget build(BuildContext context) {
  return MultiBlocProvider(providers: [], child: MyApp());
}
`;
    const hooks = await d.extractHooks('lib/app.dart', content, ctx);
    expect(hooks.some(h => h.hookName === 'MultiBlocProvider')).toBe(true);
  });

  it('returns empty array when filePath is not a .dart file', async () => {
    const content = fileHeader + 'BlocBuilder<AuthBloc, AuthState>();';
    const hooks = await d.extractHooks('lib/foo.js', content, ctx);
    expect(hooks).toHaveLength(0);
  });

  it('extracts hooks from .dart file even without ".dart" in content', async () => {
    const content = `
class MyState extends State<MyWidget> {
  @override
  void initState() { super.initState(); }
}
`;
    const hooks = await d.extractHooks('lib/my_widget.dart', content, ctx);
    expect(hooks.some(h => h.hookName === 'initState')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Static metadata
// ─────────────────────────────────────────────────────────────────

describe('FlutterDetector static metadata', () => {
  it('has correct name and language', () => {
    const d = new FlutterDetector();
    expect(d.name).toBe('flutter');
    expect(d.language).toBe('dart');
    expect(d.filePattern.test('lib/main.dart')).toBe(true);
    expect(d.filePattern.test('src/app.ts')).toBe(false);
  });
});
