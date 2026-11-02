<?php

namespace App\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    public function map(): void
    {
        $this->mapAdminRoutes();
        // $this->mapLegacyRoutes();
        // Route::prefix('old')->middleware('web')->group(base_path('routes/old.php'));
        $this->mapProviderRoutes();
        $this->mapAssignedRoutes();
        $this->mapListedRoutes();
    }

    protected function mapAdminRoutes(): void
    {
        Route::prefix('admin')->middleware('web')->group(base_path('routes/admin.php'));
    }

    // Nothing calls this any more: the call in map() is commented out.
    protected function mapLegacyRoutes(): void
    {
        Route::prefix('legacy')->middleware('web')->group(base_path('routes/legacy.php'));
    }

    // M1-07-R2: the mount forms other providers use, inside the RouteServiceProvider.
    protected function mapProviderRoutes(): void
    {
        foreach (glob(base_path('routes/rsp/mail/*.php')) as $file) {
            Route::middleware('web')->prefix('mail')->group($file);
        }
        foreach (glob(base_path('routes/rsp/plain/*.php')) as $file) require $file;
        require base_path('routes/rsp/required.php');
        $this->loadRoutesFrom(base_path('routes/rsp/loaded.php'));
        $routes = base_path('routes/rsp/variable.php');
        Route::prefix('var')->group($routes);
        Route::prefix(config('app.api_prefix'))->middleware('api')->group(base_path('routes/rsp/config.php'));
        Route::prefix("ops/{$this->version}")->domain('ops.example.com')->name('ops.')->middleware('web')->group(base_path('routes/rsp/ops.php'));
        Route::prefix("audit/$this->version")->group(base_path('routes/rsp/audit.php'));
    }

    // Declared after its use: a class property is visible to every method.
    protected $version = 'v3';

    protected $edition = 'e1';

    // M1-03-R2: compound and property assignments, a partly dynamic prefix and name prefix.
    protected function mapAssignedRoutes(): void
    {
        $area = 'area';
        $area .= '/v1';
        Route::prefix($area)->group(base_path('routes/rsp/area.php'));
        $tier ??= 'gold';
        Route::prefix($tier)->group(base_path('routes/rsp/tier.php'));
        $this->edition = 'e2';
        Route::prefix($this->edition)->group(base_path('routes/rsp/edition.php'));
        Route::prefix("zone{$this->zone()}")->name("zone.{$this->zone()}.")->group(base_path('routes/rsp/zone.php'));
    }

    // M1-07-R3: a list of files under one group (Router::group wraps its routes in an array), and
    // prefixes bound by a foreach or reassigned under a condition.
    protected function mapListedRoutes(): void
    {
        Route::prefix('bundle')->middleware('web')->group([
            base_path('routes/rsp/bundle/first.php'),
            base_path('routes/rsp/bundle/second.php'),
        ]);
        // Laravel mounts channel.php under beta and under nightly. MapX does not expand a loop over
        // a literal array yet, so it reports one {dynamic} prefix (label L150, a placeholder until
        // it does); never the pre-loop 'stable'.
        $channel = 'stable';
        foreach (['beta', 'nightly'] as $channel) {
            Route::prefix($channel)->group(base_path('routes/rsp/channel.php'));
        }
        $desk = 'help';
        if ($this->app->environment('local')) {
            $desk = 'support';
        }
        Route::prefix($desk)->group(base_path('routes/rsp/desk.php'));
        // Review 2026-11-02: the next pass sees the assignment after the mount.
        $lane = 'slow';
        while ($this->moreLanes()) {
            Route::prefix($lane)->group(base_path('routes/rsp/lane.php'));
            $lane = 'fast';
        }
    }
}
