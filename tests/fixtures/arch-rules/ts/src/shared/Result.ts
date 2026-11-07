import { Money } from '../domain/Money';

export class Result {
  run(): void {
    new Money().run();
  }
}
