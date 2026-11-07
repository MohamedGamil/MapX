<?php
// Synthetic fixture (M5-09): an inheritance cycle (invalid PHP, valid input): ancestry must terminate.
namespace App\Legacy;

class LoopA extends LoopB {}

class LoopB extends LoopA {}
