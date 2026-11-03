# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class OrdersController < ApplicationController
  include OrdersHelper

  def self.open_for?(_request)
    true
  end

  def create
    order = Order.lookup(params[:id])
    PlaceOrder.new(order).call
    render json: { total: format_total(order) }
  end
end
