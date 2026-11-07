<?php
// Synthetic fixture (M5-09 review): two top-level types, so the file's own import of Mailer is the
// file's; Two also inherits Base's import of it.
namespace App\Domain;

use App\Http\Mailer;
use App\Support\Base;

class Two extends Base {}

class TwoLine {}
