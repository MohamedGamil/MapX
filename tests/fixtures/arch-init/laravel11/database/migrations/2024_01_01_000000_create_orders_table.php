<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->integer('total');
        });
    }
};
