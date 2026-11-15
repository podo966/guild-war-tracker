// 로컬 검증: node:sqlite로 D1을 흉내 내서 워커 로직을 실행한다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const mod = await import(process.env.GWT_TARGET ?? '../src/index.js');
const worker = mod.default;
const { WAR_TIMEOUT_MS } = mod;

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  #norm() {
    // D1의 ?1 ?2 번호 파라미터 → node:sqlite도 지원하지만 인자 배열 처리를 맞춤
    return this.args.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  async first() { return sqlite.prepare(this.sql).get(...this.#norm()) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.#norm()) }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.#norm()); return { meta: { changes: Number(r.changes) } }; }
  async exec() { return this.sql.trim().toUpperCase().startsWith('SELECT') ? this.all() : this.run(); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(list) {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of list) out.push(await s.exec()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const env = { DB, API_KEY: 'secret' };

// Wynncraft API 흉내
globalThis.fetch = async (url) => {
  assert.match(String(url), /api\.wynncraft\.com\/v3\/player\/[0-9a-f-]{36}$/);
  return new Response(JSON.stringify({ username: 'Me', guild: { name: 'Test Guild', prefix: 'TG' } }), { status: 200 });
};

const U = '1ed075fc-5aa9-42e0-a29f-640326c1d80c';
const call = async (method, path, body, key = 'secret') => {
  const init = { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  const res = await worker.fetch(new Request('https://x.dev' + path, init), env, ctx);
  return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() };
};

const now = Date.now();
const min = 60_000;

// 인증
assert.equal((await call('POST', '/api/war/start', { id: 'a' }, 'wrong')).status, 401);
// 잘못된 입력
assert.equal((await call('POST', '/api/war/start', { id: 'a', uuid: 'x', name: 'Me', startedAt: now })).status, 400);

// 1) 전쟁 A 참여 → 승리
let r = await call('POST', '/api/war/start', { id: 'A', uuid: U, name: 'Me', territory: 'Detlas', startedAt: now - 100 * min });
assert.equal(r.status, 200); assert.equal(r.body.inserted, true);
await Promise.all(pending);
r = await call('POST', '/api/war/end', { id: 'A', uuid: U, result: 'win', endedAt: now - 95 * min });
assert.equal(r.body.updated, true);
// 같은 end 재전송은 무시
r = await call('POST', '/api/war/end', { id: 'A', uuid: U, result: 'loss', endedAt: now - 94 * min });
assert.equal(r.body.updated, false);
// start 재전송(중복)은 무시
r = await call('POST', '/api/war/start', { id: 'A', uuid: U, name: 'Me', territory: 'Detlas', startedAt: now - 100 * min });
assert.equal(r.body.inserted, false);

// 2) 전쟁 B 참여 → 패배
await call('POST', '/api/war/start', { id: 'B', uuid: U, name: 'Me', territory: 'Ragni', startedAt: now - 90 * min });
await call('POST', '/api/war/end', { id: 'B', uuid: U, result: 'loss', endedAt: now - 85 * min });

// 3) 전쟁 C 참여 후 결과 없이 전쟁 D 참여 → C 이탈
await call('POST', '/api/war/start', { id: 'C', uuid: U, name: 'Me', territory: 'Almuj', startedAt: now - 80 * min });
r = await call('POST', '/api/war/start', { id: 'D', uuid: U, name: 'Me', territory: 'Nemract', startedAt: now - 75 * min });
assert.equal(r.body.previousMarkedLeft, 1);
// C에 뒤늦게 결과가 와도 이탈 유지
r = await call('POST', '/api/war/end', { id: 'C', uuid: U, result: 'win', endedAt: now - 74 * min });
assert.equal(r.body.updated, false);

// 4) D는 결과 없이 30분 이상 경과 → 조회 시 이탈
// 5) 30분 넘어서 온 결과는 무시: E 시작 후 31분 뒤 승리
await call('POST', '/api/war/start', { id: 'E', uuid: U, name: 'Me', territory: 'Bremminglar', startedAt: now - 40 * min });
r = await call('POST', '/api/war/end', { id: 'E', uuid: U, result: 'win', endedAt: now - 40 * min + WAR_TIMEOUT_MS + min });
assert.equal(r.body.updated, false);

// 6) 늦게 도착한 과거 start (이미 더 나중 전쟁 존재) → 바로 이탈
await call('POST', '/api/war/start', { id: 'Z', uuid: U, name: 'Me', territory: 'Old', startedAt: now - 200 * min });

// 7) 진행 중 전쟁 F
await call('POST', '/api/war/start', { id: 'F', uuid: U, name: 'Me', territory: 'Cinfras', startedAt: now - 2 * min });

// 다른 플레이어 (길드 직접 지정)
const U2 = '2ed075fc5aa942e0a29f640326c1d80d';
await call('POST', '/api/war/start', { id: 'G', uuid: U2, name: 'Friend_1', territory: 'Detlas', startedAt: now - 10 * min, guild: 'Other Guild' });
await call('POST', '/api/war/end', { id: 'G', uuid: U2, result: 'win', endedAt: now - 5 * min });

await Promise.all(pending);

const wars = (await call('GET', '/api/wars')).body;
const byId = Object.fromEntries(wars.wars.map((w) => [w.id, w]));
console.table(wars.wars.map((w) => ({ id: w.id, name: w.player_name, guild: w.guild_name, terr: w.territory, result: w.result, ended: !!w.ended_at })));
assert.equal(byId.A.result, 'win');
assert.equal(byId.B.result, 'loss');
assert.equal(byId.C.result, 'left');
assert.equal(byId.D.result, 'left');
assert.equal(byId.E.result, 'left');
assert.equal(byId.Z.result, 'left');
assert.equal(byId.F.result, 'ongoing');
assert.equal(byId.A.guild_name, 'Test Guild');
assert.equal(byId.G.guild_name, 'Other Guild');
assert.equal(wars.total, 8);

const summary = (await call('GET', '/api/summary')).body.players;
console.table(summary);
const me = summary.find((p) => p.player_name === 'Me');
assert.deepEqual([me.total, me.wins, me.losses, me.lefts, me.ongoing], [7, 1, 1, 4, 1]);

// 필터
assert.equal((await call('GET', '/api/wars?result=left')).body.total, 4);
assert.equal((await call('GET', '/api/wars?player=friend')).body.total, 1);
assert.equal((await call('GET', '/api/wars?guild=TG')).body.total, 7);
assert.equal((await call('GET', '/api/wars?player=%25')).body.total, 0); // LIKE 이스케이프
assert.equal((await call('GET', '/api/summary?guild=Other')).body.players.length, 1);

// VIEW_KEY
env.VIEW_KEY = 'v';
assert.equal((await call('GET', '/api/wars')).status, 401);
const ok = await worker.fetch(new Request('https://x.dev/api/wars', { headers: { 'x-view-key': 'v' } }), env, ctx);
assert.equal(ok.status, 200);
delete env.VIEW_KEY;

// API_KEY 미등록 시 키 없이 기록 가능
delete env.API_KEY;
r = await worker.fetch(new Request('https://x.dev/api/war/start', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'H', uuid: U2, name: 'Friend_1', territory: 'Ragni', startedAt: Date.now() }) }), env, ctx);
assert.equal(r.status, 200);
env.API_KEY = 'secret';

// 페이지
const page = await call('GET', '/');
assert.equal(page.status, 200);
assert.match(page.body, /길드 전쟁/);

// 스케줄러
await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
await Promise.all(pending);

console.log('\n모든 테스트 통과');
