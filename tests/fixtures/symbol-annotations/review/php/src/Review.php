<?php
// Synthetic fixture (M5-10 review): aliased and global attributes.
namespace App\Review;

use Foo\Bar as Baz;

#[Baz]
class Aliased {}

#[\Entity]
class GlobalEntity {}
