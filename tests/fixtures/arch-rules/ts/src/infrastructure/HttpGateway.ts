// Synthetic (M5-19): references to packages outside the workspace, labelled in expected-externals.json.
import { Pool, Client as PgClient } from 'pg';
import * as fs from 'node:fs';
import express from 'express';
import 'reflect-metadata';
import type { Logger } from '@acme/logging/core';
import { Component } from 'react';
const yaml = require('js-yaml');

export class HttpGateway extends Component {
  constructor(private readonly logger: Logger) {
    super({});
  }

  run(logger: Logger): void {
    new Pool();
    PgClient.connect();
    fs.readFileSync('orders.sql');
    express();
    yaml.load('a: 1');
  }
}
