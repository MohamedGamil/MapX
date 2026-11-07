// Synthetic fixture for M5-24-R3: every kind of `to` the agent templates name for mapx_arch_allowed. Not a real application.
import express from 'express';
import { readFileSync } from 'node:fs';
import { Order } from '../domain/Order';

const app = express();
app.get('/', (_req, res) => {
  res.send(String(new Order(Number(readFileSync('/dev/null', 'utf8')) || 1).total()));
});
