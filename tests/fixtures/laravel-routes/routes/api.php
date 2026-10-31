<?php

use App\Http\Controllers\CategoryController;
use App\Http\Controllers\GhostController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\NoticeController;
use App\Http\Controllers\PostController;
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
