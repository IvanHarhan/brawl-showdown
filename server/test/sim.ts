// Быстрая проверка: 10 ботов играют до победителя. npx tsx test/sim.ts [прогонов]
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/Game';
import { BRAWLERS } from '../../shared/brawlers';

const text = readFileSync(new URL('../../maps/showdown1.txt', import.meta.url), 'utf8');
for (let run = 0; run < Number(process.argv[2] ?? 3); run++) {
  const g = new Game(text, { seed: run + 1 });
  for (let i = 0; i < 10; i++) g.addPlayer('b' + i, BRAWLERS[(i + run) % BRAWLERS.length].id, true);
  g.start();
  const t0 = Date.now();
  const boxes0 = g.boxHp.size;
  let cansPicked = 0, gasHits = 0, supers = 0;
  const deaths: string[] = [];
  while (!g.ended && g.time < 400) {
    g.tick();
    for (const e of g.takeEvents()) {
      if (e[0] === 'can') cansPicked++;
      if (e[0] === 'die') deaths.push(g.time.toFixed(0));
      if (e[0] === 'gas') gasHits++;
      if (e[0] === 'super') supers++;
    }
  }
  const res = g.results();
  console.log(`run ${run}: t=${g.time.toFixed(1)}s cpu=${Date.now() - t0}ms boxes ${boxes0}->${g.boxHp.size} cans=${cansPicked} gas=${gasHits} supers=${supers} deaths@ ${deaths.join(',')}`);
  console.log('  ' + res.map((r) => `${r.place}:${r.brawler}(k${r.kills})`).join(' '));
}
