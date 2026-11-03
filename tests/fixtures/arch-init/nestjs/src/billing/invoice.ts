// Synthetic fixture for M5-17-R1 (mapx arch init --preset nestjs). Not a real application.
// No `.entity` suffix: only the @Entity decorator puts it in Entity.
import { Column, Entity } from 'typeorm';

@Entity()
export class Invoice {
  @Column()
  total = 0;
}
