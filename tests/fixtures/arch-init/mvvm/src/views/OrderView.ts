// Synthetic fixture for M5-17-R1 (mapx arch init --preset mvvm). Not a real application.
import { OrderViewModel } from '../viewmodels/OrderViewModel';
import { OrderService } from '../services/OrderService'; // the violation: the view calls the service past its view model

export function orderView(vm = new OrderViewModel()): string {
  vm.refresh();
  return String(vm.order?.total ?? new OrderService().load().total);
}
