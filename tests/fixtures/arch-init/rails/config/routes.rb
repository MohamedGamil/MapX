# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
# Each layer calls a method the app defines (review of M5-17-R1), so emptying any rule fails the check.
Rails.application.routes.draw do
  constraints(->(req) { OrdersController.open_for?(req) }) do
    resources :orders, only: [:create]
  end
end
