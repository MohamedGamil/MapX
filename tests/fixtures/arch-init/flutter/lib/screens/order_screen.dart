// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
import 'package:flutter/material.dart';

import '../state/cart_notifier.dart';
import '../widgets/order_tile.dart';

class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key});

  @override
  Widget build(BuildContext context) => OrderTile(cart: CartNotifier());
}
