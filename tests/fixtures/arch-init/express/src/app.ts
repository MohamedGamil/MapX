// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import express from 'express';
import { settings } from './config/settings';
import { requestId } from './middleware/requestId';
import { ordersRouter } from './routes/orders';

const app = express();
app.use(requestId);
app.use('/orders', ordersRouter);
app.listen(settings.port);
