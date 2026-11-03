// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.billing;

import com.example.shop.billing.InvoiceRepository;
import org.springframework.stereotype.Service;

// In no folder the preset names: only @Service puts it in Service.
@Service
public class Billing {
    private final InvoiceRepository invoices;

    public Billing(InvoiceRepository invoices) {
        this.invoices = invoices;
    }

    public long invoiceCount() {
        return invoices.count();
    }
}
