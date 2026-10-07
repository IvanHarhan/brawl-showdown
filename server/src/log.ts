// Логи в консоль (видны в Render → Logs) и в память — их отдаёт GET /logs.
const MAX = 1000;
const lines: string[] = [];

export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString().slice(11, 19)} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

export function recentLogs(n = 300) { return lines.slice(-n).join('\n'); }

/** Живые комнаты для GET /stats. */
export const liveRooms = new Set<{ stats(): unknown }>();
