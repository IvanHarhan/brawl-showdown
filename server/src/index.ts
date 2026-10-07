import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { ShowdownRoom } from './rooms/ShowdownRoom';
import { CLIENT_DIST, MAP_PATH } from './paths';

const port = Number(process.env.PORT ?? 2567);
const started = Date.now();

const server = new Server({
  transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3 }),
  greet: false,
  express: (app) => {
    app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });
    app.get('/health', (_req, res) => {
      res.json({ ok: true, uptime: Math.round((Date.now() - started) / 1000), map: MAP_PATH.split(/[\\/]/).pop() });
    });
    // Для start-local.ps1: сервер сам раздаёт собранный клиент, если он есть.
    if (CLIENT_DIST && process.env.SERVE_CLIENT !== '0') app.use(express.static(CLIENT_DIST));
  },
});

server.define('showdown', ShowdownRoom);

if (process.env.SIM_LATENCY) server.simulateLatency(Number(process.env.SIM_LATENCY));

server.listen(port).then(() => console.log(`brawl server on :${port}`));
