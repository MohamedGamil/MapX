# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
class CreateOrders < ActiveRecord::Migration[7.1]
  def change
    create_table :orders do |t|
      t.integer :total
    end
  end
end
