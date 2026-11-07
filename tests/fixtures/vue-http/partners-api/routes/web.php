<?php

use App\Http\Controllers\FeedController;

// M2-06-R4: no .env or setting names partners.example.com; this literal domain is the only
// evidence that the workspace serves it.
Route::domain('partners.example.com')->group(function () {
    Route::get('partners/v1/feed', [FeedController::class, 'index']);
});
