# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
# A model in a custom app/ folder: only its ancestry (ApplicationRecord, ActiveRecord::Base) puts it in Models.
class Invoice < ApplicationRecord
  belongs_to :order
end
