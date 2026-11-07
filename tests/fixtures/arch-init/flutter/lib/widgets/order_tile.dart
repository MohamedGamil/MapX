// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
import 'package:flutter/material.dart';

import '../models/order.dart';
import '../state/cart_notifier.dart';
import '../services/order_api.dart';

class OrderTile extends StatelessWidget {
  const OrderTile({super.key, required this.cart});

  final CartNotifier cart;

  // The violation: a widget calls the API itself instead of going through its state.
  Future<Order> reload() => OrderApi().fetchOrder();

  @override
  Widget build(BuildContext context) => Text('${cart.count}');
}
