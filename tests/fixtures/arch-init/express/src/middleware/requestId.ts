// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import type { NextFunction, Request, Response } from 'express';
import { settings } from '../config/settings';

export function requestId(req: Request, res: Response, next: NextFunction) {
  res.locals.currency = settings.currency;
  next();
}
