# Synthetic fixture for M5-17-R1 (mapx arch init --preset rails). Not a real application.
# A job in a custom app/ folder: only its ancestry (ApplicationJob, ActiveJob::Base) puts it in Jobs.
class RefundJob < ApplicationJob
  def perform(invoice)
    Invoice.find(invoice.id)
  end
end
