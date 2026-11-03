<?php
// Synthetic fixture (M5-09): extends Eloquent\Model through BaseModel; implements Payable through Billable.
namespace App\Domain;

use App\Support\BaseModel;

class Order extends BaseModel implements Billable
{
    public $total;

    public function pay() {}
}
