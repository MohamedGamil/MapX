<?php

use Illuminate\Support\Facades\Route;
use Modules\Blog\Http\Controllers\BlogPostController;

// Mounted by Modules/Blog/app/Providers/RouteServiceProvider.php through module_path().
Route::get('blog/posts', [BlogPostController::class, 'index']);
