// Synthetic fixture (M5-09): extends AbstractPersistable through BaseEntity; implements Payable through Billable.
package com.acme.domain;

import com.acme.support.BaseEntity;

public class Order extends BaseEntity implements Billable {
    private int total;

    public void pay() {}
}
