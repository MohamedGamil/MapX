import express from 'express';
import { readFileSync } from 'node:fs';

export class Server {
  start() {
    readFileSync('server.json');
    return express();
  }
}
