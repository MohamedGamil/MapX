# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class OrderMailer < ApplicationMailer
  helper OrdersHelper

  def receipt(order)
    @order = Order.lookup(order.id)
    mail(to: "buyer@example.com")
  end
end
