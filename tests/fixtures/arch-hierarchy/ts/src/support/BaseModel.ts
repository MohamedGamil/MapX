// Synthetic fixture (M5-09): an abstract intermediate base over a model outside the workspace.
import { Model } from 'sequelize';
import { Mailer } from '../http/Mailer';

export abstract class BaseModel extends Model {
  notify(): Mailer {
    return new Mailer();
  }
}
