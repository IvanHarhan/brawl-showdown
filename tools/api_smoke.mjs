// Проверка API аккаунтов: node tools/api_smoke.mjs [url]
const B = (process.argv[2] ?? 'http://localhost:2570') + '/api';
const sfx = Math.random().toString(36).slice(2, 6);
async function call(path, body, tok) {
  const r = await fetch(B + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}
const ok = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

const a = await call('/register', { name: 'Ваня' + sfx, pin: '1234' });
const b = await call('/register', { name: 'Гамас' + sfx, pin: '5555' });
ok(a.status === 200 && b.status === 200, 'регистрация двух аккаунтов');
ok((await call('/register', { name: 'ваня' + sfx, pin: '1111' })).status === 409, 'ник занят (без учёта регистра)');
ok((await call('/register', { name: 'x' + sfx, pin: '12' })).status === 400, 'короткий PIN отклонён');
ok((await call('/login', { name: 'Ваня' + sfx, pin: '0000' })).status === 401, 'неверный PIN');
ok((await call('/login', { name: 'ВАНЯ' + sfx, pin: '1234' })).status === 200, 'вход');
await call('/friends/add', { name: 'Гамас' + sfx }, a.json.token);
let me = await call('/me', null, b.json.token);
ok(me.json.requests?.[0]?.name === 'Ваня' + sfx, 'заявка в друзья дошла');
await call('/friends/answer', { id: a.json.profile.id, accept: true }, b.json.token);
me = await call('/me', null, a.json.token);
ok(me.json.friends?.[0]?.name === 'Гамас' + sfx && me.json.friends[0].online, 'друзья, видно онлайн');
await call('/invite', { id: b.json.profile.id, code: 'ABCD' }, a.json.token);
me = await call('/me', null, b.json.token);
ok(me.json.invites?.[0]?.code === 'ABCD', 'приглашение в комнату');
ok((await call('/me')).status === 401, 'без токена — 401');
