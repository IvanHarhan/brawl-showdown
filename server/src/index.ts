import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { ShowdownRoom } from './rooms/ShowdownRoom';
import { CLIENT_DIST, MAP_PATH } from './paths';
import { log, recentLogs, liveRooms } from './log';

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
    app.get('/stats', (_req, res) => {
      res.json({ uptime: Math.round((Date.now() - started) / 1000), rooms: [...liveRooms].map((r) => r.stats()) });
    });
    app.get('/logs', (req, res) => {
      res.type('text/plain; charset=utf-8').send(recentLogs(Math.min(1000, Number(req.query.n) || 300)));
    });
    // Для start-local.ps1: сервер сам раздаёт собранный клиент, если он есть.
    if (CLIENT_DIST && process.env.SERVE_CLIENT !== '0') app.use(express.static(CLIENT_DIST));
  },
});

server.define('showdown', ShowdownRoom);

if (process.env.SIM_LATENCY) server.simulateLatency(Number(process.env.SIM_LATENCY));

server.listen(port).then(() => log(`сервер запущен на :${port}`));
