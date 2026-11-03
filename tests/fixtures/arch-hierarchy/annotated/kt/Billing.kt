// Synthetic fixture for M5-17-R1 (review): Kotlin annotations on their own lines above the declaration.
package com.acme.billing

import org.springframework.stereotype.Service
import org.springframework.data.domain.Persistable

@Service
class Billing : BaseService()

@jakarta.persistence.Entity
data class Invoice(val number: Long) : Persistable<Long>
