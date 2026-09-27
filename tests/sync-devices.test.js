'use strict';
/* Два устройства через фейковый GitHub с sha-семантикой: правки сходятся. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');
const factory = require('../sync.js');

function makeServer() {
  const srv = { sha: null, state: null, n: 0 };
  srv.fetch = (url, opts) => {
    opts = opts || {};
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (srv.sha && body.sha !== srv.sha) {
        return Promise.resolve({ status: 409, ok: false, json: async () => ({ message: 'conflict' }) });
      }
      srv.n += 1;
      srv.sha = 'sha' + srv.n;
      srv.state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return Promise.resolve({ status: 201, ok: true, json: async () => ({ content: { sha: srv.sha } }) });
    }
    if (!srv.sha) return Promise.resolve({ status: 404, ok: false, json: async () => ({}) });
    return Promise.resolve({
      status: 200, ok: true,
      json: async () => ({ sha: srv.sha, content: Buffer.from(JSON.stringify(srv.state)).toString('base64') })
    });
  };
  return srv;
}

function device(srv, now) {
  const api = factory(L, srv.fetch, { sleep: async () => {}, jitterMs: 0 });
  return { api, state: { tasks: L.blankTasks(), settings: { repo: 'r/x', token: 'TOK' }, updatedAt: now } };
}

describe('два устройства', () => {
  it('A пушит, B забирает', async () => {
    const srv = makeServer();
    const a = device(srv, 100);
    L.createTask(a.state.tasks, 'Дело A', 100, { id: 'a' });
    assert.equal((await a.api.syncNow(a.state)).status, 'pushed');
    const b = device(srv, 50);
    assert.equal((await b.api.syncNow(b.state)).status, 'pulled');
    assert.equal(b.state.tasks.length, 1);
    assert.equal(b.state.tasks[0].title, 'Дело A');
  });

  it('параллельные добавления не теряются', async () => {
    const srv = makeServer();
    const a = device(srv, 100);
    L.createTask(a.state.tasks, 'Дело A', 100, { id: 'a' });
    await a.api.syncNow(a.state);
    const b = device(srv, 100);
    await b.api.syncNow(b.state);
    L.createTask(a.state.tasks, 'Ещё A', 200, { id: 'a2' });
    a.state.updatedAt = 200;
    L.createTask(b.state.tasks, 'Дело B', 200, { id: 'b' });
    b.state.updatedAt = 200;
    const ra = await a.api.syncNow(a.state);
    assert.ok(ra.status === 'pushed' || ra.status === 'merged');
    const rb = await b.api.syncNow(b.state);
    assert.ok(rb.status === 'merged' || rb.status === 'pulled');
    await a.api.syncNow(a.state);
    const ids = a.state.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, ['a', 'a2', 'b']);
    assert.ok(L.tasksEqual(a.state.tasks, b.state.tasks));
  });

  it('поздняя правка одной задачи побеждает', async () => {
    const srv = makeServer();
    const a = device(srv, 100);
    L.createTask(a.state.tasks, 'Исходно', 100, { id: 't' });
    await a.api.syncNow(a.state);
    const b = device(srv, 100);
    await b.api.syncNow(b.state);
    L.clarifyTask(a.state.tasks, 't', { title: 'Ранняя', status: 'next' }, 200);
    a.state.updatedAt = 200;
    L.clarifyTask(b.state.tasks, 't', { title: 'Поздняя', status: 'waiting' }, 300);
    b.state.updatedAt = 300;
    await a.api.syncNow(a.state);
    await b.api.syncNow(b.state);
    await a.api.syncNow(a.state);
    const ga = L.getTask(a.state.tasks, 't');
    assert.equal(ga.title, 'Поздняя');
    assert.equal(ga.status, 'waiting');
    assert.ok(L.tasksEqual(a.state.tasks, b.state.tasks));
  });

  it('удаление расходится как tombstone', async () => {
    const srv = makeServer();
    const a = device(srv, 100);
    L.createTask(a.state.tasks, 'Лишняя', 100, { id: 't' });
    await a.api.syncNow(a.state);
    const b = device(srv, 100);
    await b.api.syncNow(b.state);
    L.removeTask(a.state.tasks, 't', 200);
    a.state.updatedAt = 200;
    await a.api.syncNow(a.state);
    const rb = await b.api.syncNow(b.state);
    assert.ok(rb.status === 'pulled' || rb.status === 'merged');
    assert.equal(L.getTask(b.state.tasks, 't').deleted, true);
    assert.equal(L.nextList(b.state.tasks).length, 0);
  });
});
