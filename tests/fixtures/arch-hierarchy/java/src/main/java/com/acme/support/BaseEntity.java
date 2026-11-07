// Synthetic fixture (M5-09): an intermediate base over a Spring Data class outside the workspace.
package com.acme.support;

import com.acme.http.Mailer;
import org.springframework.data.jpa.domain.AbstractPersistable;

public abstract class BaseEntity extends AbstractPersistable<Long> {
    public Mailer notifyOwner() {
        return new Mailer();
    }
}
