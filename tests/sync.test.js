'use strict';
/* Тесты синхронизации: fetch мокается, логика настоящая (src/logic.js). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../src/logic.js');
const factory = require('../sync.js');

function stateWith(tasks, t) {
  return { tasks, settings: { repo: 'r/x', token: 'TOK' }, updatedAt: t };
}

function demoTasks(t) {
  const tasks = L.blankTasks();
  L.createTask(tasks, 'Дело', t, { id: 'a' });
  return tasks;
}

function fileResp(sha, state) {
  return {
    status: 200, ok: true,
    json: async () => ({ sha, content: Buffer.from(JSON.stringify(state)).toString('base64') })
  };
}

function stubFetch(handler) {
  const calls = [];
  const fn = (url, opts) => { calls.push({ url, opts: opts || {} }); return handler(url, opts || {}, calls.length); };
  fn.calls = calls;
  return fn;
}

function decodePut(call) {
  const body = JSON.parse(call.opts.body);
  return { payload: body, state: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) };
}

describe('syncNow: базовые исходы', () => {
  it('без токена — no-token, сеть не трогаем', async () => {
    const fetch = stubFetch(() => { throw new Error('must not fetch'); });
    const api = factory(L, fetch);
    const s = stateWith(demoTasks(100), 100);
    s.settings.token = '';
    const res = await api.syncNow(s);
    assert.equal(res.status, 'no-token');
    assert.equal(fetch.calls.length, 0);
  });

  it('файла нет + локально пусто — in-sync без PUT', async () => {
    const fetch = stubFetch(async () => ({ status: 404, ok: false, json: async () => ({}) }));
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(L.blankTasks(), 100));
    assert.equal(res.status, 'in-sync');
    assert.equal(fetch.calls.length, 1);
  });

  it('файла нет + локально есть данные — pushed без sha', async () => {
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 201, ok: true, json: async () => ({}) };
      return { status: 404, ok: false, json: async () => ({}) };
    });
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'pushed');
    assert.equal(fetch.calls.length, 2);
    assert.ok(!JSON.parse(fetch.calls[1].opts.body).sha);
  });

  it('удалённый новее — pulled', async () => {
    const remote = { tasks: demoTasks(200), updatedAt: 200 };
    L.completeTask(remote.tasks, 'a', 200);
    const fetch = stubFetch(async () => fileResp('AAA', remote));
    const api = factory(L, fetch);
    const local = stateWith(demoTasks(100), 100);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'pulled');
    assert.equal(res.state.tasks[0].status, 'done');
    assert.equal(fetch.calls.length, 1);
  });

  it('локальный новее — pushed с sha', async () => {
    const remote = { tasks: demoTasks(100), updatedAt: 100 };
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 201, ok: true, json: async () => ({}) };
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch);
    const local = stateWith(demoTasks(200), 200);
    L.clarifyTask(local.tasks, 'a', { status: 'next' }, 200);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'pushed');
    assert.equal(JSON.parse(fetch.calls[1].opts.body).sha, 'AAA');
    const sent = decodePut(fetch.calls[1]).state;
    assert.equal(sent.tasks[0].status, 'next');
  });

  it('одинаковые — in-sync без PUT', async () => {
    const shared = { tasks: demoTasks(100), updatedAt: 100 };
    const fetch = stubFetch(async () => fileResp('AAA', shared));
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'in-sync');
    assert.equal(fetch.calls.length, 1);
  });

  it('правки с обеих сторон — merged', async () => {
    const base = demoTasks(100);
    L.createTask(base, 'Общая', 100, { id: 'shared' });
    const remoteTasks = L.normalizeTasks(base);
    L.clarifyTask(remoteTasks, 'shared', { status: 'waiting' }, 200);
    const remote = { tasks: remoteTasks, updatedAt: 200 };
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 201, ok: true, json: async () => ({}) };
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch);
    const localTasks = L.normalizeTasks(base);
    L.createTask(localTasks, 'Локальная', 150, { id: 'local' });
    const res = await api.syncNow(stateWith(localTasks, 150));
    assert.equal(res.status, 'merged');
    const ids = res.state.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, ['a', 'local', 'shared']);
  });
});

describe('syncNow: конфликты и ошибки', () => {
  it('409 — ретрай, затем успех', async () => {
    const remote = { tasks: demoTasks(100), updatedAt: 100 };
    let puts = 0;
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') {
        puts += 1;
        if (puts === 1) return { status: 409, ok: false, json: async () => ({ message: 'conflict' }) };
        return { status: 201, ok: true, json: async () => ({}) };
      }
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch, { sleep: async () => {}, jitterMs: 0 });
    const local = stateWith(demoTasks(200), 200);
    L.clarifyTask(local.tasks, 'a', { status: 'next' }, 200);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'pushed');
    assert.equal(puts, 2);
  });

  it('409 исчерпан — error', async () => {
    const remote = { tasks: demoTasks(100), updatedAt: 100 };
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 422, ok: false, json: async () => ({ message: 'conflict' }) };
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch, { sleep: async () => {}, jitterMs: 0, maxRetries: 2 });
    const local = stateWith(demoTasks(200), 200);
    L.clarifyTask(local.tasks, 'a', { status: 'next' }, 200);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'error');
    assert.ok(/github-put 422/.test(res.error));
  });

  it('не-409 ошибка PUT — сразу error', async () => {
    const remote = { tasks: demoTasks(100), updatedAt: 100 };
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 500, ok: false, json: async () => ({ message: 'boom' }) };
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch, { sleep: async () => {} });
    const local = stateWith(demoTasks(200), 200);
    L.clarifyTask(local.tasks, 'a', { status: 'next' }, 200);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'error');
    assert.ok(/github-put 500/.test(res.error));
  });

  it('ошибка GET — error без исключений', async () => {
    const fetch = stubFetch(async () => ({ status: 403, ok: false, json: async () => ({ message: 'denied' }) }));
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'error');
    assert.ok(/github-get 403/.test(res.error));
  });

  it('битый ответ без content — error', async () => {
    const fetch = stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ message: 'empty' }) }));
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'error');
    assert.ok(/github-get/.test(res.error));
  });

  it('таймаут fetch — error', async () => {
    const fetch = stubFetch(() => new Promise(() => {}));
    const api = factory(L, fetch, { timeoutMs: 20 });
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'error');
    assert.ok(/timeout/.test(res.error));
  });

  it('обрыв fetch — error', async () => {
    const fetch = stubFetch(() => Promise.reject(new Error('net down')));
    const api = factory(L, fetch);
    const res = await api.syncNow(stateWith(demoTasks(100), 100));
    assert.equal(res.status, 'error');
    assert.ok(/net down/.test(res.error));
  });

  it('409 с дефолтным сном — ретрай, затем успех', async () => {
    const remote = { tasks: demoTasks(100), updatedAt: 100 };
    let puts = 0;
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') {
        puts += 1;
        if (puts === 1) return { status: 409, ok: false, json: async () => ({ message: 'conflict' }) };
        return { status: 201, ok: true, json: async () => ({}) };
      }
      return fileResp('AAA', remote);
    });
    const api = factory(L, fetch, { baseMs: 10, capMs: 20, jitterMs: 0 });
    const local = stateWith(demoTasks(200), 200);
    L.clarifyTask(local.tasks, 'a', { status: 'next' }, 200);
    const res = await api.syncNow(local);
    assert.equal(res.status, 'pushed');
    assert.equal(puts, 2);
  });

  it('UMD: в браузере ставит window.EBSync', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
    const sandbox = { window: { EBLogic: L, fetch: async () => ({}) } };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    assert.ok(sandbox.window.EBSync);
    assert.equal(typeof sandbox.window.EBSync.syncNow, 'function');
  });

  it('fmtErr покрывает варианты', () => {
    const api = factory(L, stubFetch(async () => ({})));
    assert.equal(api.fmtErr(null), 'unknown');
    assert.equal(api.fmtErr(undefined), 'unknown');
    assert.ok(api.fmtErr(new Error('oops')).includes('oops'));
    assert.ok(api.fmtErr('строка').includes('строка'));
  });

  it('putRemote возвращает json', async () => {
    const fetch = stubFetch(async () => ({ status: 201, ok: true, json: async () => ({ ok: true }) }));
    const api = factory(L, fetch);
    const r = await api.putRemote('r/x', 'TOK', { updatedAt: 1, tasks: [] }, null);
    assert.equal(r.ok, true);
  });
});

describe('publishFile: журналы', () => {
  it('файла нет — создаёт, возвращает logged', async () => {
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 201, ok: true, json: async () => ({}) };
      return { status: 404, ok: false, json: async () => ({}) };
    });
    const api = factory(L, fetch);
    assert.equal(await api.publishFile('r/x', 'TOK', 'logs/a.json', { a: 1 }), 'logged');
  });

  it('файл есть — перезаписывает по sha', async () => {
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') {
        assert.equal(JSON.parse(opts.body).sha, 'OLD');
        return { status: 200, ok: true, json: async () => ({}) };
      }
      return { status: 200, ok: true, json: async () => ({ sha: 'OLD', content: 'x' }) };
    });
    const api = factory(L, fetch);
    assert.equal(await api.publishFile('r/x', 'TOK', 'logs/a.json', { a: 1 }), 'logged');
  });

  it('ошибка чтения — log-error', async () => {
    const fetch = stubFetch(async () => ({ status: 500, ok: false, json: async () => ({}) }));
    const api = factory(L, fetch);
    const r = await api.publishFile('r/x', 'TOK', 'logs/a.json', { a: 1 });
    assert.ok(r.startsWith('log-error:'));
  });

  it('ошибка записи — log-error', async () => {
    const fetch = stubFetch(async (url, opts) => {
      if (opts.method === 'PUT') return { status: 500, ok: false, json: async () => ({}) };
      return { status: 404, ok: false, json: async () => ({}) };
    });
    const api = factory(L, fetch);
    const r = await api.publishFile('r/x', 'TOK', 'logs/a.json', { a: 1 });
    assert.ok(r.startsWith('log-error:'));
  });
});
