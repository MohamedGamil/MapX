# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class ChargeOrderJob < ApplicationJob
  def perform(order)
    OrderMailer.receipt(order).deliver_later
  end
end
