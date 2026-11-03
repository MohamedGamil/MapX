{{-- Synthetic fixture for M5-17. --}}
@php use App\Models\Order; @endphp
<ul>
@foreach ($orders as $order)
  <li>{{ $order->total }}</li>
@endforeach
</ul>
