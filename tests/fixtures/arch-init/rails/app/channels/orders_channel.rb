# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class OrdersChannel < ActionCable::Channel::Base
  def subscribed
    stream_for Order.lookup(params[:id])
  end
end
