// Synthetic fixture for M5-17-R1 (mapx arch init --preset flutter). Not a real application.
// In no folder the preset names: only its base, ChangeNotifier, puts it in State.
import 'package:flutter/foundation.dart';

import '../models/order.dart';

class InvoiceNotifier extends ChangeNotifier {
  Order? last;
}
