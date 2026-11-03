// Synthetic fixture for the review of M5-24 (mapx arch init on a project with npm packages). Not a real application.
import express from 'express';
import { PlaceOrder } from '../business/PlaceOrder';

export class OrderController {
  routes() {
    const app = express();
    app.post('/orders', () => new PlaceOrder().run());
    return app;
  }
}
