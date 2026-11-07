# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class PlaceOrder
  def initialize(order)
    @order = order
  end

  def call
    ChargeOrderJob.new.perform(@order)
  end
end
