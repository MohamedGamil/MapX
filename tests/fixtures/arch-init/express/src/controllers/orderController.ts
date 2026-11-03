// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import type { Request, Response } from 'express';
import { placeOrder } from '../services/orderService';

export function createOrder(req: Request, res: Response) {
  res.json(placeOrder(Number(req.body.total)));
}
