<?php

use App\Http\Controllers\CategoryController;
use App\Http\Controllers\GhostController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\NoticeController;
use App\Http\Controllers\PostController;
use App\Http\Controllers\ShowProfile;
use App\Http\Controllers\StatusController;
use App\Http\Controllers\TagController;
use Illuminate\Support\Facades\Route;

Route::group(['namespace' => 'App\Http\Controllers\Legacy'], function () {
    Route::get('legacy/items', ['as' => 'legacy.items', 'uses' => 'ItemController@index']);
    Route::post('legacy/items', ['type' => 'write', 'uses' => 'ItemController@store', 'middleware' => 'throttle']);
    Route::get('legacy/items/{id}', 'ItemController@show');
});

Route::get('posts', [PostController::class, 'index']);
Route::match(['get', 'post'], 'posts/search', [PostController::class, 'search']);

Route::controller(TagController::class)->group(function () {
    Route::get('tags', 'index');
    Route::get('tags/{tag}', 'show');
});

Route::resource('blog-categories', CategoryController::class);
Route::apiResource('statuses', StatusController::class);

$base = 'notices';
Route::get($base.'/latest', [NoticeController::class, 'latest']);

Route::get('health', function () {
    return ['ok' => true];
});

Route::group(['prefix' => 'v1', 'middleware' => 'auth:sanctum'], function () {
    require __DIR__.'/api/users.php';
});

Route::get('dup', [PostController::class, 'oldDup']);
require __DIR__.'/api/late.php';

if (config('features.beta')) {
    require __DIR__.'/api/beta.php';
}

// M1-03-R1: strings and comments that look like code.
Route::group(['prefix' => '{locale}'], function () {
    Route::get('dashboard', [HomeController::class, 'dashboard']);
});
Route::get('after-locale', [HomeController::class, 'afterLocale']);

Route::group(['middleware' => 'require-2fa'], function () {
    Route::get('secure', [HomeController::class, 'secure']);
});

$modules = glob(__DIR__.'/modules/*.php');
Route::get('after-glob', [HomeController::class, 'afterGlob']);

$docs = 'https://example.com/docs'; Route::get('after-url', [HomeController::class, 'afterUrl']);

Route::get('csv', [HomeController::class, 'csv'])->where('format', 'csv;tsv}');

# Route::get('hash-commented', [GhostController::class, 'show']);
// Route::get('slash-commented', [GhostController::class, 'show']);
/* Route::get('block-commented', [GhostController::class, 'show']); */
$example = "Route::get('in-string', [GhostController::class, 'show']);";
$help = <<<TXT
    Route::get('in-heredoc', [GhostController::class, 'show']);
    TXT;

// M1-03-R1: groups without a brace body.
Route::group(['prefix' => 'v2', 'middleware' => 'auth'], fn () => require __DIR__.'/api/reports.php');
Route::get('after-arrow', [HomeController::class, 'afterArrow']);

Route::prefix('inline')->group(fn () => Route::get('ping', [HomeController::class, 'ping']));
Route::get('after-inline', [HomeController::class, 'afterInline']);

Route::group(['prefix' => 'archive'], base_path('routes/api/archive.php'));

// M1-07-R3: the legacy form with a list of files mounts each of them.
Route::group(['prefix' => 'kit'], [__DIR__.'/api/kit/tools.php', __DIR__.'/api/kit/parts.php']);

// M1-07-R3 review: a closure in the list is a group body, and a literal spread is flattened.
Route::prefix('mix')->group([function () {
    Route::get('inline', [HomeController::class, 'mixInline']);
}, __DIR__.'/api/kit/mixed.php', ...[__DIR__.'/api/kit/spread.php']]);
Route::get('after-legacy', [HomeController::class, 'afterLegacy']);

// M1-03-R1 / M1-06 AC2: interpolated URIs and variable prefixes.
$section = 'stats';
Route::get("$section/daily", [HomeController::class, 'daily']);
Route::get("{$section}/weekly", [HomeController::class, 'weekly']);
Route::prefix($section)->group(function () {
    Route::get('monthly', [HomeController::class, 'monthly']);
});
Route::group(['prefix' => $section], function () {
    Route::get('yearly', [HomeController::class, 'yearly']);
});

// M1-07-R1: mounts built from glob loops and DIRECTORY_SEPARATOR, and a brace-less conditional.
foreach (glob(__DIR__.'/api/modules/*.php') as $moduleFile) {
    require $moduleFile;
}
Route::prefix('extra')->group(function () {
    foreach (glob(__DIR__ . '/api/extra/*.php') as $file) require_once $file;
});
require __DIR__ . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'separator.php';
if (env('LEGACY_EXPORTS')) require __DIR__.'/api/exports.php';
Route::get('after-exports', [HomeController::class, 'afterExports']);

// M1-05-R1: resource options arrays, nested and plural registration, action arrays without `uses`.
Route::resource('photos', PhotoController::class, ['only' => ['index', 'show'], 'parameters' => ['photos' => 'picture']]);
Route::apiResource('videos', VideoController::class, ['except' => ['update', 'destroy']]);
Route::apiResource('albums.tracks', TrackController::class)->only(['index', 'show']);
Route::resource('albums.reviews', ReviewController::class)->shallow()->only(['index', 'show']);
Route::resources(['tickets' => TicketController::class, 'badges' => 'BadgeController'], ['only' => ['index']]);
Route::apiResources(['coupons' => CouponController::class], ['only' => ['show']]);
Route::get('guarded', ['middleware' => 'auth', [HomeController::class, 'guarded']]);
Route::get('named-closure', ['as' => 'named', function () {
    return ['ok' => true];
}]);

// M1-05-R2: singletons and route-level prefix keys (the route prefix goes before the group prefix).
Route::singleton('profile', ProfileController::class)->except('edit');
Route::apiSingleton('teams.logo', LogoController::class)->creatable();
Route::get('status', ['prefix' => 'v3', 'uses' => 'HomeController@status']);
Route::prefix('lead')->get('chained', [HomeController::class, 'chained']);

// M1-05-R3: implicit binding fields, in the URI and in a group prefix, are reported as {param}.
Route::get('articles/{article:slug}', [HomeController::class, 'article']);
Route::prefix('authors/{author:uuid}')->group(function () {
    Route::get('books/{book:isbn?}', [HomeController::class, 'book']);
});

// M1-03-R2: require_once loads a file once and a require cycle stops; '/' under a prefix is the
// prefix itself; single-action controllers; double-quoted Route::match verbs; a resource whose
// name can't be evaluated (under its own prefix: its {dynamic} segments match any text, and the
// vue-http fixture pairs its calls with this app).
Route::prefix('once-a')->group(function () { require_once __DIR__.'/api/once.php'; });
Route::prefix('once-b')->group(function () { require_once __DIR__.'/api/once.php'; });
require __DIR__.'/api/cycle-a.php';
Route::prefix('home')->group(fn () => Route::get('/', [HomeController::class, 'homeOld']));
Route::get('home', [HomeController::class, 'homeNew']);
Route::get('invokable', ShowProfile::class);
Route::match(["get", "post"], 'feeds', [HomeController::class, 'feeds']);
Route::prefix('gallery')->group(function () {
    Route::resource(config('app.gallery'), GalleryController::class)->only(['index', 'show']);
});
