// Сколько времени боты стоят на месте в каждом режиме. npx tsx test/idle.ts
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/Game';
import { BRAWLERS } from '../../shared/brawlers';

for (const mapf of ['koeln.txt', 'showdown1.txt']) {
  const g = new Game(readFileSync(new URL('../../maps/' + mapf, import.meta.url), 'utf8'), { seed: 2 });
  for (let i = 0; i < 10; i++) g.addPlayer('b' + i, BRAWLERS[i % BRAWLERS.length].id, true);
  g.start();
  const idle: Record<string, number> = {}, total: Record<string, number> = {};
  while (!g.ended && g.time < 120) {
    const pos = g.players.map((p) => [p.x, p.y]);
    g.tick();
    g.takeEvents();
    g.players.forEach((p, i) => {
      if (!p.alive) return;
      const mode = (p.brain as unknown as { mode: string }).mode;
      total[mode] = (total[mode] ?? 0) + 1;
      if (Math.hypot(p.x - pos[i][0], p.y - pos[i][1]) < 0.001) {
        idle[mode] = (idle[mode] ?? 0) + 1;
        const br = p.brain as unknown as { path: number[]; moveX: number; moveY: number; unstuckUntil: number; dodgeUntil: number };
        if (process.env.DBG && mode === 'box' && g.tickNo % 90 === 0 && i < 3)
          console.log(`t=${g.time.toFixed(1)} bot${i} ${p.brawler.id} at ${p.x.toFixed(2)},${p.y.toFixed(2)} path=${br.path.length} move=${br.moveX.toFixed(2)},${br.moveY.toFixed(2)} ammo=${p.ammo.toFixed(2)} forced=${!!p.forced}`);
      }
    });
  }
  console.log(mapf, Object.keys(total).map((m) => `${m}: ${total[m]} тиков, стоит ${Math.round((100 * (idle[m] ?? 0)) / total[m])}%`).join(' | '));
}
