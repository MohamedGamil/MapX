# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
module OrdersHelper
  def format_total(order)
    format("%.2f", Order.lookup(order.id).total)
  end
end
