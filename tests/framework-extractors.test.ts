import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScanContext } from '../src/types.js';

// Import all detectors
import { ExpressDetector } from '../src/frameworks/detectors/express.js';
import { NestJSDetector } from '../src/frameworks/detectors/nestjs.js';
import { NextJSDetector } from '../src/frameworks/detectors/nextjs.js';
import { ReactRouterDetector } from '../src/frameworks/detectors/react-router.js';
import { SvelteKitDetector } from '../src/frameworks/detectors/sveltekit.js';
import { TanstackRouterDetector } from '../src/frameworks/detectors/tanstack-router.js';
import { VueRouterDetector } from '../src/frameworks/detectors/vue-router.js';
import { LaravelDetector } from '../src/frameworks/detectors/laravel.js';
import { SymfonyDetector } from '../src/frameworks/detectors/symfony.js';
import { YiiDetector } from '../src/frameworks/detectors/yii.js';
import { DjangoDetector } from '../src/frameworks/detectors/django.js';
import { FlaskDetector } from '../src/frameworks/detectors/flask.js';
import { FastAPIDetector } from '../src/frameworks/detectors/fastapi.js';
import { SpringDetector } from '../src/frameworks/detectors/spring.js';
import { RailsDetector } from '../src/frameworks/detectors/rails.js';
import { GoDetector } from '../src/frameworks/detectors/go.js';
import { RustDetector } from '../src/frameworks/detectors/rust.js';
import { VaporDetector } from '../src/frameworks/detectors/vapor.js';
import { WordPressDetector } from '../src/frameworks/detectors/wordpress.js';
import { DrupalDetector } from '../src/frameworks/detectors/drupal.js';
import { AspNetDetector } from '../src/frameworks/detectors/aspnet.js';
import { FlutterDetector } from '../src/frameworks/detectors/flutter.js';

function makeCtx(workspaceRoot: string, symbolMap: Record<string, string> = {}): ScanContext {
  return {
    workspaceRoot,
    repoName: 'test-repo',
    resolveSymbolToFile: (sym: string) => symbolMap[sym] ?? null,
  } as unknown as ScanContext;
}

describe('Framework Route & Hook Extraction', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `framework-extractor-tests-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('ExpressDetector - extracts routes correctly', async () => {
    const d = new ExpressDetector();
    const content = `
      const express = require('express');
      const app = express();
      app.get('/users', (req, res) => {});
      app.post('/login', loginHandler);
    `;
    const routes = await d.extractRoutes('app.js', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(2);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
    expect(routes[1].path).toBe('/login');
    expect(routes[1].method).toBe('POST');
  });

  it('NestJSDetector - extracts routes and hooks correctly', async () => {
    const d = new NestJSDetector();
    const content = `
      @Controller('users')
      class UserController {
          @Get(':id')
          getUser() {}
      }
    `;
    const routes = await d.extractRoutes('user.controller.ts', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users/:id');
    expect(routes[0].method).toBe('GET');

    const hooksContent = `
      @UseGuards(AuthGuard)
      class UserController implements OnModuleInit {
          onModuleInit() {}
      }
    `;
    const hooks = await d.extractHooks('user.controller.ts', hooksContent, makeCtx(tmpDir));
    expect(hooks.some(h => h.hookName === 'OnModuleInit')).toBe(true);
    expect(hooks.some(h => h.hookName === 'UseGuards:AuthGuard')).toBe(true);
  });

  it('NextJSDetector - extracts app router endpoints correctly', async () => {
    const d = new NextJSDetector();
    const content = `
      export async function GET() {}
      export async function POST() {}
    `;
    const routes = await d.extractRoutes('app/api/users/route.ts', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(2);
    expect(routes.some(r => r.method === 'GET' && r.path === '/api/users')).toBe(true);
    expect(routes.some(r => r.method === 'POST' && r.path === '/api/users')).toBe(true);
  });

  it('ReactRouterDetector - extracts JSX paths correctly', async () => {
    const d = new ReactRouterDetector();
    const content = `
      <Route path="/about" element={<About />} />
    `;
    const routes = await d.extractRoutes('app.tsx', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/about');
    expect(routes[0].handlerSymbol).toBe('About');
  });

  it('SvelteKitDetector - extracts +server.ts API routes', async () => {
    const d = new SvelteKitDetector();
    const content = `
      export const GET = () => {};
    `;
    const routes = await d.extractRoutes('src/routes/api/users/+server.ts', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/api/users');
    expect(routes[0].method).toBe('GET');
  });

  it('TanstackRouterDetector - extracts code-based routes', async () => {
    const d = new TanstackRouterDetector();
    const content = `
      new Route({ path: '/users', component: UserList })
    `;
    const routes = await d.extractRoutes('routes/users.tsx', content, makeCtx(tmpDir));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some(r => r.path === '/users')).toBe(true);
  });

  it('VueRouterDetector - extracts Vue routes array elements', async () => {
    const d = new VueRouterDetector();
    const content = `
      const routes = [
        { path: '/home', component: Home }
      ]
    `;
    const routes = await d.extractRoutes('router.ts', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/home');
  });

  it('LaravelDetector - extracts php routing definitions', async () => {
    const d = new LaravelDetector();
    const content = `
      <?php
      Route::get('/users', 'UserController@index');
      Route::post('/login', [UserController::class, 'login']);
    `;
    const routes = await d.extractRoutes('routes/web.php', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(2);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
    expect(routes[1].path).toBe('/login');
    expect(routes[1].method).toBe('POST');
  });

  it('SymfonyDetector - extracts routes from yml configuration and attributes', async () => {
    const d = new SymfonyDetector();
    const yamlContent = `
app_users:
    path: /users
    controller: App\\Controller\\UserController::list
    methods: [GET]
    `;
    const routesYaml = await d.extractRoutes('config/routes.yaml', yamlContent, makeCtx(tmpDir));
    expect(routesYaml).toHaveLength(1);
    expect(routesYaml[0].path).toBe('/users');
    expect(routesYaml[0].method).toBe('GET');

    const phpContent = `
      class UserController {
          #[Route('/info', name: 'user_info')]
          public function info() {}
      }
    `;
    const routesPhp = await d.extractRoutes('src/Controller/UserController.php', phpContent, makeCtx(tmpDir));
    expect(routesPhp).toHaveLength(1);
    expect(routesPhp[0].path).toBe('/info');
  });

  it('YiiDetector - extracts Yii2 URL rules', async () => {
    const d = new YiiDetector();
    const content = `
      'GET users' => 'user/index',
    `;
    const routes = await d.extractRoutes('config/web.php', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('DjangoDetector - extracts urls path registrations', async () => {
    const d = new DjangoDetector();
    const content = `
      path('users/', views.index, name='users-list'),
    `;
    const routes = await d.extractRoutes('urls.py', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
  });

  it('FlaskDetector - extracts route decorators', async () => {
    const d = new FlaskDetector();
    const content = `
      @app.route('/hello', methods=['GET', 'POST'])
      def hello():
          pass
    `;
    const routes = await d.extractRoutes('app.py', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(2);
    expect(routes.some(r => r.method === 'GET' && r.path === '/hello')).toBe(true);
    expect(routes.some(r => r.method === 'POST' && r.path === '/hello')).toBe(true);
  });

  it('FastAPIDetector - extracts fastapi endpoint decorators', async () => {
    const d = new FastAPIDetector();
    const content = `
      @app.get('/users')
      async def get_users():
          pass
    `;
    const routes = await d.extractRoutes('main.py', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('SpringDetector - extracts request and get mappings', async () => {
    const d = new SpringDetector();
    const content = `
      @RestController
      @RequestMapping("/api")
      public class MyController {
          @GetMapping("/users")
          public List<User> getUsers() {}
      }
    `;
    const routes = await d.extractRoutes('MyController.java', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/api/users');
    expect(routes[0].method).toBe('GET');
  });

  it('RailsDetector - extracts resources and single ruby route rules', async () => {
    const d = new RailsDetector();
    const content = `
      get '/users', to: 'users#index'
    `;
    const routes = await d.extractRoutes('routes.rb', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('GoDetector - extracts routes from Gin/Chi router calls', async () => {
    const d = new GoDetector();
    const content = `
      router.GET("/users", handler)
    `;
    const routes = await d.extractRoutes('main.go', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('RustDetector - extracts Axum route configurations', async () => {
    const d = new RustDetector();
    const content = `
      .route("/users", get(get_users))
    `;
    const routes = await d.extractRoutes('main.rs', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('VaporDetector - extracts Swift route patterns', async () => {
    const d = new VaporDetector();
    const content = `
      import Vapor
      app.get("users", use: handler)
    `;
    const routes = await d.extractRoutes('routes.swift', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users');
    expect(routes[0].method).toBe('GET');
  });

  it('WordPressDetector - extracts REST routes and actions', async () => {
    const d = new WordPressDetector();
    const content = `
      register_rest_route('my-ns/v1', '/users', array('methods' => 'GET', 'callback' => 'my_fn'))
    `;
    const routes = await d.extractRoutes('plugin.php', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/wp-json/my-ns/v1/users');
    expect(routes[0].method).toBe('GET');

    const hookContent = `
      add_action('init', 'my_init_fn');
    `;
    const hooks = await d.extractHooks('plugin.php', hookContent, makeCtx(tmpDir));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hookName).toBe('init');
  });

  it('DrupalDetector - extracts yaml route patterns and module hooks', async () => {
    const d = new DrupalDetector();
    const content = `
mymodule.info:
  path: '/info'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\MyController::info'
    `;
    const routes = await d.extractRoutes('mymodule.routing.yml', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/info');

    const hookContent = `
      function mymodule_form_alter(&$form) {}
    `;
    const hooks = await d.extractHooks('mymodule.module', hookContent, makeCtx(tmpDir));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hookName).toBe('form_alter');
  });

  it('AspNetDetector - extracts controller attribute routes', async () => {
    const d = new AspNetDetector();
    const content = `
      [Route("api/[controller]")]
      public class UsersController : ControllerBase {
          [HttpGet]
          public IActionResult GetAll() {}
      }
    `;
    const routes = await d.extractRoutes('UsersController.cs', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/api/users');
    expect(routes[0].method).toBe('GET');
  });

  it('FlutterDetector - extracts GoRouter route definitions', async () => {
    const d = new FlutterDetector();
    const content = `
      GoRoute(
        path: '/login',
        builder: (context, state) => LoginScreen(),
      )
    `;
    const routes = await d.extractRoutes('lib/router.dart', content, makeCtx(tmpDir));
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/login');
  });
});
