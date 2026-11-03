// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import { Router } from 'express';
import { requestId } from '../middleware/requestId';
import { createOrder } from '../controllers/orderController';

export const ordersRouter = Router();
ordersRouter.post('/', requestId, createOrder);
