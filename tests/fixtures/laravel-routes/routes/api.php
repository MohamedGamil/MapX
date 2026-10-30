<?php

use App\Http\Controllers\CategoryController;
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
