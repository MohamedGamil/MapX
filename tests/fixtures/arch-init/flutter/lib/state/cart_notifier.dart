// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
import 'package:flutter/foundation.dart';

import '../models/order.dart';
import '../services/order_api.dart';

class CartNotifier extends ChangeNotifier {
  final List<Order> orders = [];

  int get count => orders.length;

  Future<void> load() async {
    orders.add(await OrderApi().fetchOrder());
    notifyListeners();
  }
}
