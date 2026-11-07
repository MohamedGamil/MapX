// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
import 'package:flutter/material.dart';

import 'screens/order_screen.dart';

void main() => runApp(const ShopApp());

class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: OrderScreen());
}
