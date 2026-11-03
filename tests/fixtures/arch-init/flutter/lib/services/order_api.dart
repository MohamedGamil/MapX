// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
import '../models/order.dart';

class OrderApi {
  Future<Order> fetchOrder() async => Order(1, 10);
}
