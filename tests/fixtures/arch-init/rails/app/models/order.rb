# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class Order < ApplicationRecord
  after_commit :charge, on: :create

  def self.lookup(id)
    find(id)
  end

  def charge
    ChargeOrderJob.new.perform(self)
    OrderMailer.receipt(self)
  end

  # The violation: a model reaches up into a service.
  def place!
    PlaceOrder.new(self).call
  end
end
