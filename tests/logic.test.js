'use strict';
/* Unit-тесты чистой логики (src/logic.js): живые, правка полей, слияние. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../src/logic.js');

function mk(tasks, title, now, opts) {
  return L.createTask(tasks, title, now, opts);
}

describe('создание и живые', () => {
  it('новое падает в живые (todo)', () => {
    const t = L.blankTasks();
    const task = mk(t, 'Купить хлеб', 1000, { id: 'a1' });
    assert.equal(task.status, 'todo');
    assert.equal(task.title, 'Купить хлеб');
    assert.equal(L.todoCount(t), 1);
  });
  it('пустой заголовок — null, массив не растёт', () => {
    const t = L.blankTasks();
    assert.equal(mk(t, '   ', 1000), null);
    assert.equal(mk(t, '', 1000), null);
    assert.equal(mk(t, null, 1000), null);
    assert.equal(t.length, 0);
    const e = L.createTask(t, '', 1000, { allowEmpty: true });
    assert.equal(e.title, '', 'allowEmpty создаёт пустую задачу');
    assert.equal(t.length, 1);
  });
  it('заголовок тримится, id генерируется, проекта больше нет', () => {
    const t = L.blankTasks();
    const a = mk(t, '  Дело  ', 1000, { project: '  Дом ' });
    assert.equal(a.title, 'Дело');
    assert.equal(a.project, undefined, 'поле project удалено из модели');
    assert.ok(a.id);
    const b = mk(t, 'Второе', 1001);
    assert.notEqual(a.id, b.id);
  });
  it('getTask находит и возвращает null для чужого', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'x' });
    assert.equal(L.getTask(t, 'x').title, 'Дело');
    assert.equal(L.getTask(t, 'nope'), null);
  });
  it('нарезка удалена: opts.slicesTotal игнорируется', () => {
    const t = L.blankTasks();
    const task = mk(t, 'Дело', 1000, { slicesTotal: 5000 });
    assert.equal(task.slicesTotal, undefined);
    assert.equal(task.slicesDone, undefined);
    assert.equal(L.setSlices, undefined);
    assert.equal(L.completeSlice, undefined);
  });
});

describe('правка полей (clarify)', () => {
  it('раскладывает по статусам', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    for (const s of ['todo', 'done']) {
      L.clarifyTask(t, 'a', { status: s }, 2000);
      assert.equal(L.getTask(t, 'a').status, s);
    }
  });
  it('невалидный статус игнорируется', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'someday' }, 2000);
    assert.equal(L.getTask(t, 'a').status, 'todo');
  });
  it('done ставит doneAt, уход из done сбрасывает', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'done' }, 2000);
    assert.equal(L.getTask(t, 'a').doneAt, 2000);
    L.clarifyTask(t, 'a', { status: 'todo' }, 3000);
    assert.equal(L.getTask(t, 'a').doneAt, 0);
  });
  it('переименование; поля project, frog и slicesTotal выпилены', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { project: 'Работа', frog: true, slicesTotal: 5, title: 'Важное' }, 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.project, undefined);
    assert.equal(g.frog, undefined);
    assert.equal(g.slicesTotal, undefined);
    assert.equal(g.title, 'Важное');
  });
  it('пустое переименование очищает заголовок', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { title: '  ' }, 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.title, '', 'clarifyTask принимает пустой заголовок');
  });
  it('чужая и удалённая задачи — null', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    assert.equal(L.clarifyTask(t, 'zzz', { status: 'todo' }, 2000), null);
    L.removeTask(t, 'a', 2000);
    assert.equal(L.clarifyTask(t, 'a', { status: 'todo' }, 3000), null);
  });
  it('estMin: ставится через patch, клампится 0..59999, метки обновляются', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { estMin: 90 }, 2000);
    assert.equal(L.getTask(t, 'a').estMin, 90);
    assert.equal(L.getTask(t, 'a').ts, 2000);
    L.clarifyTask(t, 'a', { estMin: -5 }, 3000);
    assert.equal(L.getTask(t, 'a').estMin, 0);
    L.clarifyTask(t, 'a', { estMin: 999999 }, 4000);
    assert.equal(L.getTask(t, 'a').estMin, 59999);
    assert.equal(L.getTask(t, 'a').ts, 4000);
  });
  it('sumKids: ставится через patch, по умолчанию авто-сумма', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    assert.equal(L.getTask(t, 'a').sumKids, true, 'новая задача суммирует');
    L.clarifyTask(t, 'a', { sumKids: false }, 2000);
    assert.equal(L.getTask(t, 'a').sumKids, false);
    assert.equal(L.getTask(t, 'a').ts, 2000);
    L.clarifyTask(t, 'a', { sumKids: true }, 3000);
    assert.equal(L.getTask(t, 'a').sumKids, true);
    L.clarifyTask(t, 'a', {}, 4000);
    assert.equal(L.getTask(t, 'a').sumKids, true, 'пустой patch флаг не трогает');
  });
});

describe('готово / вернуть / удалить', () => {
  it('complete и reopen', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.completeTask(t, 'a', 2000);
    assert.equal(L.getTask(t, 'a').status, 'done');
    assert.equal(L.doneList(t).length, 1);
    L.reopenTask(t, 'a', 3000);
    assert.equal(L.getTask(t, 'a').status, 'todo');
    assert.equal(L.getTask(t, 'a').doneAt, 0);
  });
  it('reopen не-done возвращает как есть', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    const r = L.reopenTask(t, 'a', 2000);
    assert.equal(r.status, 'todo');
  });
  it('удаление — tombstone, списки его не видят', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'todo' }, 1500);
    L.removeTask(t, 'a', 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.deleted, true);
    assert.equal(L.todoList(t).length, 0);
    assert.equal(L.todoCount(t), 0);
  });
  it('операции над чужими — null', () => {
    const t = L.blankTasks();
    assert.equal(L.completeTask(t, 'z', 1), null);
    assert.equal(L.reopenTask(t, 'z', 1), null);
    assert.equal(L.removeTask(t, 'z', 1), null);
  });
});

describe('выпиленное: фокус и нарезка', () => {
  it('нарезка выпилена: setSlices/completeSlice отсутствуют в API', () => {
    assert.equal(L.setSlices, undefined);
    assert.equal(L.completeSlice, undefined);
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    const n = L.normalizeTask({ id: 'x', title: 'С', slicesTotal: 5, slicesDone: 2 });
    assert.equal(n.slicesTotal, undefined);
    assert.equal(n.slicesDone, undefined);
  });
  it('поле frog выпилено: setFrog отсутствует в API (старые данные чистятся нормализацией)', () => {
    assert.equal(L.setFrog, undefined);
    assert.equal(typeof L.setFrog, 'undefined');
  });
  it('todo: frog не пишется и не влияет на порядок', () => {
    const t = L.blankTasks();
    mk(t, 'Обычное', 1000, { id: 'a' });
    mk(t, 'Второе', 2000, { id: 'b' });
    L.clarifyTask(t, 'a', { status: 'todo', frog: true }, 3000);
    L.clarifyTask(t, 'b', { status: 'todo' }, 3000);
    assert.equal(L.getTask(t, 'a').frog, undefined);
    const nx = L.todoList(t);
    assert.equal(nx[0].id, 'a');
    assert.equal(nx[1].id, 'b');
  });
  it('порядок живых — по времени создания', () => {
    const t = L.blankTasks();
    mk(t, 'Второе', 2000, { id: 'b' });
    mk(t, 'Первое', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'todo' }, 3000);
    L.clarifyTask(t, 'b', { status: 'todo' }, 3000);
    const nx = L.todoList(t);
    assert.equal(nx[0].id, 'a');
    assert.equal(nx[1].id, 'b');
  });
  it('UMD: в браузере ставит window.EBLogic', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/logic.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    assert.ok(sandbox.window.EBLogic);
    assert.equal(typeof sandbox.window.EBLogic.createTask, 'function');
  });
});

describe('списки и фокус', () => {
  it('списки по статусам, живые по времени', () => {
    const t = L.blankTasks();
    mk(t, 'Позже', 2000, { id: 'b' });
    mk(t, 'Раньше', 1000, { id: 'a' });
    const ib = L.todoList(t);
    assert.equal(ib[0].id, 'a');
    L.clarifyTask(t, 'a', { status: 'done' }, 3000);
    assert.equal(L.todoList(t).length, 1);
    assert.equal(L.doneList(t).length, 1);
    assert.equal(L.todoCount(t), 1);
    t.push({ id: 'z', title: '', status: 'todo', indent: 0, createdAt: 0, updatedAt: 3000, ts: 3000, deleted: false });
    assert.equal(L.todoCount(t), 1, 'задача без текста не считается живой');
  });
  it('done сортируется свежими первыми', () => {
    const t = L.blankTasks();
    mk(t, 'Старое', 1000, { id: 'a' });
    mk(t, 'Новое', 1000, { id: 'b' });
    L.completeTask(t, 'a', 2000);
    L.completeTask(t, 'b', 3000);
    assert.equal(L.doneList(t)[0].id, 'b');
  });
  it('waiting/someday/project/focusTask удалены из API', () => {
    assert.equal(L.waitingList, undefined);
    assert.equal(L.somedayList, undefined);
    assert.equal(L.focusTask, undefined);
    const n = L.normalizeTask({ id: 'x', title: 'Старая', status: 'waiting', project: 'Дом' });
    assert.equal(n.status, 'todo', 'старый waiting гасится в todo');
    assert.equal(n.project, undefined);
    assert.equal(L.normalizeTask({ id: 'i', title: 'С', status: 'inbox' }).status, 'todo', 'старый inbox маппится в todo');
    assert.equal(L.normalizeTask({ id: 'n', title: 'С', status: 'next' }).status, 'todo', 'старый next маппится в todo');
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'someday' }, 2000);
    assert.equal(L.getTask(t, 'a').status, 'todo', 'someday игнорируется');
  });
  it('stats считает всё', () => {
    const t = L.blankTasks();
    mk(t, 'I', 1000, { id: 'i' });
    mk(t, 'N', 1000, { id: 'n' });
    mk(t, 'D', 1000, { id: 'd' });
    L.clarifyTask(t, 'n', { status: 'todo' }, 2000);
    L.completeTask(t, 'd', 2000);
    t.push({ id: 'z', title: '', status: 'todo', indent: 0, createdAt: 5000, updatedAt: 1000, ts: 1000, deleted: false });
    const st = L.stats(t);
    assert.deepEqual(st, { todo: 2, done: 1 });
  });
  it('shareText: пусто и с данными', () => {
    assert.equal(L.shareText(L.blankTasks()), '');
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'f' });
    L.clarifyTask(t, 'f', { status: 'todo' }, 2000);
    const txt = L.shareText(t);
    assert.equal(txt, '- Дело');
  });
  it('shareText: как на экране — порядок, отступы, выполненные ниже', () => {
    const t = L.blankTasks();
    mk(t, 'Верх', 1000, { id: 'a' });
    mk(t, 'Внутрь', 2000, { id: 'b', indent: 1 });
    mk(t, 'Старая', 3000, { id: 'old' });
    mk(t, 'Новая', 4000, { id: 'new' });
    L.completeTask(t, 'old', 5000);
    L.completeTask(t, 'new', 9000);
    const lines = L.shareText(t).split('\n');
    assert.deepEqual(lines, [
      '- Верх',
      '  - Внутрь',
      '',
      'Выполнено:',
      '- Новая',
      '- Старая'
    ]);
  });
});

describe('поиск', () => {
  function seed() {
    const t = L.blankTasks();
    mk(t, 'Купить молоко', 1000, { id: 'a' });
    mk(t, 'Ёлка и ель', 2000, { id: 'b' });
    mk(t, 'МОЛОКО убежало', 3000, { id: 'c' });
    mk(t, '', 4000, { id: 'e', allowEmpty: true });
    return t;
  }
  it('пустой запрос — пусто', () => {
    assert.deepEqual(L.searchTasks(seed(), ''), []);
    assert.deepEqual(L.searchTasks(seed(), '   '), []);
  });
  it('регистр не важен, порядок — как на экране', () => {
    assert.deepEqual(L.searchTasks(seed(), 'молоко'), ['a', 'c']);
  });
  it('ё равно е', () => {
    assert.deepEqual(L.searchTasks(seed(), 'елка'), ['b']);
    assert.deepEqual(L.searchTasks(seed(), 'ЁЛКА'), ['b']);
  });
  it('пустые и удалённые не ищутся', () => {
    const t = seed();
    L.removeTask(t, 'a', 5000);
    assert.deepEqual(L.searchTasks(t, 'молоко'), ['c']);
  });
  it('не-массив и мусор — пусто', () => {
    assert.deepEqual(L.searchTasks(null, 'x'), []);
  });
});

describe('восстановление с tombstone', () => {
  function task(id, title, ts) {
    return { id: id, title: title, status: 'todo', indent: 0, createdAt: ts, updatedAt: ts, ts: ts, deleted: false };
  }
  it('пропавшие хоронятся со свежей меткой', () => {
    const cur = [task('a', 'A', 100), task('b', 'B', 200)];
    const out = L.restoreWithTombstones(cur, [task('a', 'A', 100)], 9000);
    assert.equal(out.length, 2);
    const tomb = out.filter((t) => t.id === 'b')[0];
    assert.equal(tomb.deleted, true);
    assert.equal(tomb.ts, 9000);
  });
  it('присутствующие едут как есть, удалённые не дублируются', () => {
    const cur = [task('a', 'A', 100), { id: 'z', title: '', status: 'todo', indent: 0, createdAt: 50, updatedAt: 50, ts: 50, deleted: true }];
    const out = L.restoreWithTombstones(cur, [task('a', 'A!', 300)], 9000);
    assert.equal(out.length, 2);
    assert.equal(out.filter((t) => t.id === 'a')[0].title, 'A!');
  });
  it('пустая копия хоронит всех живых', () => {
    const out = L.restoreWithTombstones([task('a', 'A', 100)], [], 9000);
    assert.equal(out.length, 1);
    assert.equal(out[0].deleted, true);
  });
});

describe('нормализация', () => {
  it('normalizeTask отбрасывает мусор', () => {
    assert.equal(L.normalizeTask(null), null);
    assert.equal(L.normalizeTask(42), null);
    assert.equal(L.normalizeTask({ title: 'без id' }), null);
  });
  it('битые поля приводятся к форме', () => {
    const n = L.normalizeTask({ id: 'a', title: 123, status: 'todo', slicesTotal: 'x', slicesDone: 99, frog: 1 });
    assert.equal(n.title, '123');
    assert.equal(n.status, 'todo');
    assert.equal(n.slicesTotal, undefined);
    assert.equal(n.slicesDone, undefined);
    assert.equal(n.frog, undefined);
  });
  it('estMin: мусор и потолки, новая задача без времени', () => {
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', estMin: '75' }).estMin, 75);
    assert.equal(L.normalizeTask({ id: 'a', title: 'x' }).estMin, 0);
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', estMin: 'abc' }).estMin, 0);
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', estMin: -3 }).estMin, 0);
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', estMin: 70000 }).estMin, 59999);
    assert.equal(L.normalizeTask({ id: 'a', title: 'x' }).sumKids, true, 'по умолчанию авто-сумма');
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', sumKids: false }).sumKids, false, 'отказ переживает нормализацию');
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', sumKids: 0 }).sumKids, true, 'только явный false отключает');
    assert.equal(L.normalizeTask({ id: 'a', title: 'x', sumKids: 1 }).sumKids, true);
    assert.equal(mk([], 'Дело', 1000).estMin, 0);
  });
  it('fmtDur: метка в углу строки', () => {
    assert.equal(L.fmtDur(0), '');
    assert.equal(L.fmtDur(undefined), '');
    assert.equal(L.fmtDur(-10), '');
    assert.equal(L.fmtDur(30), '30м');
    assert.equal(L.fmtDur(60), '1ч');
    assert.equal(L.fmtDur(90), '1ч 30м');
    assert.equal(L.fmtDur(600), '10ч');
    assert.equal(L.fmtDur(125), '2ч 5м');
  });
  it('done без doneAt берёт updatedAt, не-done обнуляет', () => {
    const d = L.normalizeTask({ id: 'a', title: 'T', status: 'done', updatedAt: 500 });
    assert.equal(d.doneAt, 500);
    const n = L.normalizeTask({ id: 'b', title: 'T', status: 'todo', doneAt: 500 });
    assert.equal(n.doneAt, 0);
  });
  it('normalizeTasks: не-массив, дубли, сортировка', () => {
    assert.deepEqual(L.normalizeTasks(null), []);
    assert.deepEqual(L.normalizeTasks({}), []);
    const out = L.normalizeTasks([
      { id: 'b', title: 'B', createdAt: 2000 },
      { id: 'a', title: 'A', createdAt: 1000 },
      { id: 'a', title: 'A2', createdAt: 1000 },
      { title: 'без id' }
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'a');
  });
});

describe('слияние LWW', () => {
  it('свежая ts побеждает, равные — локальная', () => {
    const l = { id: 'a', title: 'Лок', ts: 100 };
    const r = { id: 'a', title: 'Удал', ts: 200 };
    assert.equal(L.mergeTask(l, r).title, 'Удал');
    assert.equal(L.mergeTask(r, l).title, 'Удал');
    const e = { id: 'a', title: 'Лок', ts: 100 };
    const q = { id: 'a', title: 'Удал', ts: 100 };
    assert.equal(L.mergeTask(e, q).title, 'Лок');
    /* Регресс v64: cloneTask терял estMin — слияние стирало ВСЕ метки
     * времени (в т.ч. при равных ts), включая файл на сервере. */
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 1, estMin: 45 },
      { id: 'a', title: 'R', ts: 2 }).estMin, 0, 'победа remote без времени');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 2, estMin: 45 },
      { id: 'a', title: 'R', ts: 1 }).estMin, 45, 'победа local с временем');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 2, estMin: 45 },
      { id: 'a', title: 'R', ts: 2 }).estMin, 45, 'равные ts — локальное время не теряется');
    const me = L.mergeTasks(
      [{ id: 'x', title: 'X', ts: 1, createdAt: 1, updatedAt: 1, estMin: 30 }],
      [{ id: 'y', title: 'Y', ts: 1, createdAt: 2, updatedAt: 1, estMin: 15 }]);
    assert.equal(me[0].estMin, 30, 'mergeTasks сохранил время x');
    assert.equal(me[1].estMin, 15, 'mergeTasks сохранил время y');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 2, sumKids: false },
      { id: 'a', title: 'R', ts: 1 }).sumKids, false, 'слияние несёт отказ от суммы');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 1 },
      { id: 'a', title: 'R', ts: 2, sumKids: false }).sumKids, false, 'победа remote с отказом');
  });
  it('mergeTasks объединяет наборы', () => {
    const a = [{ id: 'x', title: 'X', status: 'todo', ts: 100, createdAt: 100, updatedAt: 100 }];
    const b = [{ id: 'y', title: 'Y', status: 'todo', ts: 100, createdAt: 200, updatedAt: 100 }];
    const m = L.mergeTasks(a, b);
    assert.equal(m.length, 2);
    assert.equal(m[0].id, 'x');
  });
  it('удаление побеждает только свежей меткой', () => {
    const live = [{ id: 'a', title: 'Жива', ts: 100, createdAt: 100, updatedAt: 100 }];
    const dead = [{ id: 'a', title: 'Жива', ts: 200, deleted: true, createdAt: 100, updatedAt: 200 }];
    assert.equal(L.mergeTasks(live, dead)[0].deleted, true);
    assert.equal(L.mergeTasks(dead, live)[0].deleted, true);
    const oldDead = [{ id: 'a', title: 'Жива', ts: 50, deleted: true, createdAt: 100, updatedAt: 50 }];
    assert.equal(L.mergeTasks(live, oldDead)[0].deleted, false);
  });
  it('tasksEqual и isTasksEmpty', () => {
    const a = [{ id: 'x', title: 'X', ts: 1, createdAt: 1, updatedAt: 1 }];
    const b = [{ id: 'x', title: 'X', ts: 1, createdAt: 1, updatedAt: 1 }];
    assert.equal(L.tasksEqual(a, b), true);
    assert.equal(L.tasksEqual(a, []), false);
    assert.equal(L.isTasksEmpty([]), true);
    assert.equal(L.isTasksEmpty([{ id: 'x', deleted: true, ts: 1 }]), true);
    assert.equal(L.isTasksEmpty(a), false);
    assert.equal(L.isTasksEmpty([{ id: 'e', title: '', ts: 1, createdAt: 1, updatedAt: 1 }]), false,
      'задача с пустым текстом — это данные, а не пустое состояние');
  });
  it('mergeDecision: пустое не затирает', () => {
    assert.equal(L.mergeDecision({ tasks: [], updatedAt: 100 }, { tasks: [{ id: 'a', title: 'T' }], updatedAt: 50 }), 'pull');
    assert.equal(L.mergeDecision({ tasks: [{ id: 'a', title: 'T' }], updatedAt: 50 }, { tasks: [], updatedAt: 100 }), 'push');
    assert.equal(L.mergeDecision({ tasks: [{ id: 'a', title: 'T' }], updatedAt: 200 }, { tasks: [{ id: 'b', title: 'U' }], updatedAt: 100 }), 'push');
    assert.equal(L.mergeDecision({ tasks: [{ id: 'a', title: 'T' }], updatedAt: 100 }, { tasks: [{ id: 'b', title: 'U' }], updatedAt: 200 }), 'pull');
    assert.equal(L.mergeDecision({ tasks: [{ id: 'a', title: 'T' }], updatedAt: 100 }, { tasks: [{ id: 'b', title: 'U' }], updatedAt: 100 }), 'in-sync');
  });
});

describe('отступ (группы)', () => {
  it('createTask берёт indent из opts, по умолчанию 0', () => {
    const t = L.blankTasks();
    const a = mk(t, 'Верх', 1000, { id: 'a' });
    const b = mk(t, 'Внутрь', 2000, { id: 'b', indent: 1 });
    assert.equal(a.indent, 0);
    assert.equal(b.indent, 1);
  });
  it('setIndent ставит уровень, клампит 0..8, ставит ts', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    assert.equal(L.setIndent(t, 'a', 1, 2000).indent, 1);
    assert.equal(L.setIndent(t, 'a', 99, 3000).indent, 8);
    assert.equal(L.setIndent(t, 'a', -5, 4000).indent, 0);
    assert.equal(L.getTask(t, 'a').ts, 4000);
    assert.equal(L.setIndent(t, 'nope', 1, 5000), null);
    L.removeTask(t, 'a', 6000);
    assert.equal(L.setIndent(t, 'a', 1, 7000), null);
  });
  it('clarify принимает patch.indent', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { indent: 2 }, 2000);
    assert.equal(L.getTask(t, 'a').indent, 2);
  });
  it('нормализация чинит мусор indent', () => {
    assert.equal(L.normalizeTask({ id: 'a', title: 'T', indent: 'x' }).indent, 0);
    assert.equal(L.normalizeTask({ id: 'a', title: 'T', indent: -2 }).indent, 0);
    assert.equal(L.normalizeTask({ id: 'a', title: 'T', indent: 99 }).indent, 8);
    assert.equal(L.normalizeTask({ id: 'a', title: 'T' }).indent, 0);
  });
  it('слияние везёт indent свежей версии', () => {
    const m = L.mergeTasks(
      [{ id: 'a', title: 'A', ts: 100, createdAt: 100, updatedAt: 100, indent: 0 }],
      [{ id: 'a', title: 'A', ts: 200, createdAt: 100, updatedAt: 200, indent: 1 }]
    );
    assert.equal(m[0].indent, 1);
    assert.equal(L.tasksEqual(
      [{ id: 'a', title: 'A', ts: 1, createdAt: 1, updatedAt: 1, indent: 0 }],
      [{ id: 'a', title: 'A', ts: 1, createdAt: 1, updatedAt: 1, indent: 1 }]
    ), false);
  });
  it('completeBranch выполняет ветку целиком, doneAt убывает', () => {
    const t = L.blankTasks();
    mk(t, 'P', 1000, { id: 'p' });
    mk(t, 'K1', 2000, { id: 'k1', indent: 1 });
    mk(t, 'K2', 3000, { id: 'k2', indent: 1 });
    mk(t, 'Q', 4000, { id: 'q' });
    const order = [L.getTask(t, 'p'), L.getTask(t, 'k1'), L.getTask(t, 'k2'), L.getTask(t, 'q')];
    assert.deepEqual(L.completeBranch(order, 'p', 9000), ['p', 'k1', 'k2']);
    assert.equal(L.getTask(t, 'q').status, 'todo');
    assert.ok(L.getTask(t, 'p').doneAt > L.getTask(t, 'k1').doneAt);
    assert.ok(L.getTask(t, 'k1').doneAt > L.getTask(t, 'k2').doneAt);
    assert.equal(L.completeBranch(order, 'nope', 9000).length, 0);
    assert.deepEqual(L.completeBranch(null, 'p', 9000), []);
  });
  it('reopenBranch возвращает ветку целиком: дети к родителю', () => {
    const t = L.blankTasks();
    mk(t, 'P', 1000, { id: 'p' });
    mk(t, 'K1', 2000, { id: 'k1', indent: 1 });
    mk(t, 'K2', 3000, { id: 'k2', indent: 2 });
    mk(t, 'Q', 4000, { id: 'q' });
    const order = [L.getTask(t, 'p'), L.getTask(t, 'k1'), L.getTask(t, 'k2'), L.getTask(t, 'q')];
    L.completeBranch(order, 'p', 9000);
    assert.deepEqual(L.reopenBranch(t, 'p', 9500), ['p', 'k1', 'k2']);
    assert.equal(L.getTask(t, 'p').status, 'todo');
    assert.equal(L.getTask(t, 'k1').status, 'todo');
    assert.equal(L.getTask(t, 'k2').status, 'todo');
    assert.equal(L.getTask(t, 'q').status, 'todo');
    assert.equal(L.getTask(t, 'p').doneAt, 0);
  });
  it('reopenBranch останавливается на соседе, живых пропускает', () => {
    const t = L.blankTasks();
    mk(t, 'A', 1000, { id: 'a' });
    mk(t, 'B', 2000, { id: 'b', indent: 1 });
    mk(t, 'C', 3000, { id: 'c' });
    L.getTask(t, 'a').status = 'done';
    L.getTask(t, 'b').status = 'done';
    L.getTask(t, 'c').status = 'done';
    assert.deepEqual(L.reopenBranch(t, 'b', 9999), ['b']);
    assert.equal(L.getTask(t, 'a').status, 'done');
    assert.equal(L.getTask(t, 'c').status, 'done');
    const u = L.blankTasks();
    mk(u, 'P', 1000, { id: 'p' });
    mk(u, 'K', 2000, { id: 'k', indent: 1 });
    L.getTask(u, 'p').status = 'done';
    assert.deepEqual(L.reopenBranch(u, 'p', 9999), ['p']);
    assert.equal(L.getTask(u, 'k').status, 'todo');
    assert.deepEqual(L.reopenBranch(u, 'nope', 1), []);
    assert.deepEqual(L.reopenBranch(null, 'p', 1), []);
  });
  it('shareText показывает отступ пробелами', () => {
    const t = L.blankTasks();
    mk(t, 'Верх', 1000, { id: 'a' });
    mk(t, 'Внутрь', 2000, { id: 'b', indent: 1 });
    const txt = L.shareText(t);
    assert.ok(txt.includes('\n  - Внутрь'), 'нет отступа у вложенной:\n' + txt);
  });
  it('hasKids видит вложенных', () => {
    const arr = [
      { id: 'p', title: 'P', indent: 0 },
      { id: 'a', title: 'A', indent: 1 },
      { id: 'q', title: 'Q', indent: 0 }
    ];
    assert.equal(L.hasKids(arr, 0), true);
    assert.equal(L.hasKids(arr, 1), false);
    assert.equal(L.hasKids(arr, 2), false);
    assert.equal(L.hasKids(arr, 9), false);
  });
  it('isDoneShown наследует done родителя, но не соседей', () => {
    const arr = [
      { id: 'p', title: 'P', status: 'done', indent: 0 },
      { id: 'a', title: 'A', status: 'todo', indent: 1 },
      { id: 'q', title: 'Q', status: 'todo', indent: 0 },
      { id: 'b', title: 'B', status: 'todo', indent: 1 }
    ];
    assert.equal(L.isDoneShown(arr, 0), true);
    assert.equal(L.isDoneShown(arr, 1), true);
    assert.equal(L.isDoneShown(arr, 2), false);
    assert.equal(L.isDoneShown(arr, 3), false);
  });
  it('isHiddenByCollapse прячет только свою ветку', () => {
    const arr = [
      { id: 'p', title: 'P', indent: 0 },
      { id: 'a', title: 'A', indent: 1 },
      { id: 'a1', title: 'A1', indent: 2 },
      { id: 'q', title: 'Q', indent: 0 }
    ];
    assert.equal(L.isHiddenByCollapse(arr, 1, { p: true }), true);
    assert.equal(L.isHiddenByCollapse(arr, 2, { p: true }), true);
    assert.equal(L.isHiddenByCollapse(arr, 3, { p: true }), false);
    assert.equal(L.isHiddenByCollapse(arr, 1, {}), false);
    assert.equal(L.isHiddenByCollapse(arr, 2, { a: true }), true);
    assert.equal(L.isHiddenByCollapse(arr, 1, { a: true }), false);
  });
});

describe('сжатие могил (purgeTombstones)', () => {
  function tomb(id, title, ts) {
    return { id: id, title: title, status: 'todo', estMin: 0, sumKids: true,
      indent: 0, createdAt: ts, updatedAt: ts, doneAt: 0, ts: ts, deleted: true };
  }
  it('все могилы сжимаются в маркеры, остальные целы', () => {
    const t = [
      { id: 'a', title: 'Жива', status: 'todo', ts: 100, createdAt: 100, updatedAt: 100 },
      { id: 'b', title: 'Готово', status: 'done', ts: 100, createdAt: 101, updatedAt: 100 },
      tomb('c', 'Мусор', 200),
      tomb('d', '', 200)
    ];
    assert.equal(L.purgeTombstones(t, 500), 2, 'сжаты все могилы, не только с текстом');
    assert.equal(t[0].title, 'Жива', 'живая тронута');
    assert.equal(t[1].status, 'done', 'выполненная тронута');
    assert.deepEqual(t[2], { id: 'c', deleted: true, ts: 500, updatedAt: 500, min: true });
    assert.deepEqual(t[3], { id: 'd', deleted: true, ts: 500, updatedAt: 500, min: true });
  });
  it('метка свежее (max) — забытое устройство не воскресит', () => {
    const t = [tomb('c', 'Мусор', 900)];
    L.purgeTombstones(t, 500);
    assert.equal(t[0].ts, 900, 'старая метка не занижается');
    const stale = [{ id: 'c', title: 'Мусор', status: 'todo', ts: 800, createdAt: 100, updatedAt: 800 }];
    const m = L.mergeTasks(stale, t);
    assert.equal(m[0].deleted, true, 'живая копия с забытого устройства воскресла');
  });
  it('маркер переживает нормализацию и слияние', () => {
    const t = [{ id: 'c', deleted: true, ts: 500, updatedAt: 500, min: true }];
    const n = L.normalizeTasks(t);
    assert.equal(n.length, 1);
    assert.equal(n[0].deleted, true);
    assert.equal(n[0].ts, 500);
    assert.equal(n[0].min, true, 'флаг сжатия потерян нормализацией');
    assert.equal('title' in n[0], false, 'нормализация раздула маркер полями');
    assert.equal(L.purgeTombstones(null), 0);
    assert.equal(L.purgeTombstones([]), 0);
  });
  it('сжатие не расползается обратно (v171)', () => {
    const t = [{ id: 'a', title: 'Жива', status: 'todo', ts: 100, createdAt: 100, updatedAt: 100 },
      { id: 'c', title: 'Мусор', status: 'todo', ts: 200, createdAt: 200, updatedAt: 200, deleted: true }];
    assert.equal(L.purgeTombstones(t, 500), 1);
    const before = JSON.stringify(L.getTask(t, 'c')).length;
    const afterLoad = L.normalizeTasks(JSON.parse(JSON.stringify(t)));
    const afterMerge = L.mergeTasks(afterLoad, []);
    const ml = L.getTask(afterLoad, 'c');
    const mc = L.getTask(afterMerge, 'c');
    assert.ok(JSON.stringify(ml).length <= before, 'загрузка раздула маркеры');
    assert.ok(JSON.stringify(mc).length <= before, 'слияние раздуло маркеры');
    assert.equal(mc.min, true);
    assert.equal('title' in mc, false);
  });
  it('флаг min: только у маркеров, обычным не пишется', () => {
    const n = L.normalizeTask({ id: 'a', title: 'Жива', status: 'todo' });
    assert.equal('min' in n, false, 'обычной задаче дописан лишний ключ');
    assert.equal(L.normalizeTask({ id: 'c', deleted: true, ts: 1, updatedAt: 1 }).min, undefined);
    const c = L.mergeTasks(
      [{ id: 'c', title: 'Мусор', status: 'todo', ts: 100, createdAt: 100, updatedAt: 100 }],
      [{ id: 'c', deleted: true, ts: 500, updatedAt: 500, min: true }]);
    assert.equal(c[0].min, true, 'флаг не пережил слияние');
  });
});

describe('срок токена (tokenExp)', () => {
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  function exp(days) {
    const d = new Date(NOW + days * DAY);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }
  it('normTokenExp: ДД.ММ.ГГГГ проходит, мусор — нет', () => {
    assert.equal(L.normTokenExp('01.11.2026'), '01.11.2026');
    assert.equal(L.normTokenExp(' 01.11.2026 '), '01.11.2026', 'пробелы тримятся');
    assert.equal(L.normTokenExp('2026-11-01'), '01.11.2026', 'старый формат приводится');
    assert.equal(L.normTokenExp(''), '');
    assert.equal(L.normTokenExp(null), '');
    assert.equal(L.normTokenExp(12345), '');
    assert.equal(L.normTokenExp('2026.11.01'), '');
    assert.equal(L.normTokenExp('01-11-2026'), '');
    assert.equal(L.normTokenExp('01.13.2026'), '', 'месяца 13 нет');
    assert.equal(L.normTokenExp('01.00.2026'), '', 'месяца 0 нет');
    assert.equal(L.normTokenExp('30.02.2026'), '', '30 февраля нет');
    assert.equal(L.normTokenExp('32.11.2026'), '', '32-го нет');
  });
  it('tokenDaysLeft: дни по UTC-полуночам, битое — 9999', () => {
    assert.equal(L.tokenDaysLeft(exp(10), NOW), 10);
    assert.equal(L.tokenDaysLeft(exp(0), NOW), 0);
    assert.equal(L.tokenDaysLeft(exp(-2), NOW), -2);
    assert.equal(L.tokenDaysLeft('', NOW), 9999);
    assert.equal(L.tokenDaysLeft('мусор', NOW), 9999);
  });
  it('tokenWarnLevel: тихо / за 7 / за 3 и после срока', () => {
    assert.equal(L.tokenWarnLevel(exp(8), NOW), 0);
    assert.equal(L.tokenWarnLevel(exp(7), NOW), 1, 'ровно 7 — мягкое');
    assert.equal(L.tokenWarnLevel(exp(4), NOW), 1);
    assert.equal(L.tokenWarnLevel(exp(3), NOW), 2, 'ровно 3 — настойчивое');
    assert.equal(L.tokenWarnLevel(exp(1), NOW), 2);
    assert.equal(L.tokenWarnLevel(exp(0), NOW), 2);
    assert.equal(L.tokenWarnLevel(exp(-5), NOW), 2, 'после срока — настойчивое');
    assert.equal(L.tokenWarnLevel('', NOW), 0);
    assert.equal(L.tokenWarnLevel('мусор', NOW), 0);
  });
});

describe('планирование ФАЗА 0: модель и изоляция (FR-95–FR-101)', () => {
  function localMs(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h || 0, mi || 0).getTime(); }
  function ids(arr) { return arr.map(function (x) { return x.id; }); }
  function mkPlan(tasks, title, date, now, id) {
    mk(tasks, title, now, { id: id });
    L.clarifyTask(tasks, id, { planDate: date }, now);
    return L.getTask(tasks, id);
  }
  it('normPlanDate: формат, мусор, 29.02, ISO', () => {
    assert.equal(L.normPlanDate('05.10.2026'), '05.10.2026');
    assert.equal(L.normPlanDate('  05.10.2026  '), '05.10.2026');
    assert.equal(L.normPlanDate(''), '');
    assert.equal(L.normPlanDate(null), '');
    assert.equal(L.normPlanDate(undefined), '');
    assert.equal(L.normPlanDate(12345), '');
    assert.equal(L.normPlanDate('мусор'), '');
    assert.equal(L.normPlanDate('5.10.2026'), '', 'без ведущих нулей — мусор');
    assert.equal(L.normPlanDate('05-10-2026'), '');
    assert.equal(L.normPlanDate('05.13.2026'), '', 'месяца 13 нет');
    assert.equal(L.normPlanDate('05.00.2026'), '', 'месяца 0 нет');
    assert.equal(L.normPlanDate('32.10.2026'), '', '32-го нет');
    assert.equal(L.normPlanDate('31.02.2026'), '', '31 февраля нет');
    assert.equal(L.normPlanDate('29.02.2024'), '29.02.2024', 'високосный держим');
    assert.equal(L.normPlanDate('29.02.2025'), '', '29.02 невисокосного — битое');
    assert.equal(L.normPlanDate('2026-10-05'), '05.10.2026', 'старый ISO приводим');
    assert.equal(L.normPlanDate('2026-13-01'), '');
    assert.equal(L.normPlanDate('2026-02-30'), '');
  });
  it('whitelist: normalizeTask держит planDate/planFired', () => {
    const n = L.normalizeTask({ id: 'x', title: 'П', planDate: '05.10.2026', planFired: 777 });
    assert.equal(n.planDate, '05.10.2026');
    assert.equal(n.planFired, 777);
    const g = L.normalizeTask({ id: 'x', title: 'П', planDate: 'мусор', planFired: -5 });
    assert.equal(g.planDate, '');
    assert.equal(g.planFired, 0);
    const d = L.normalizeTask({ id: 'x', title: 'П' });
    assert.equal(d.planDate, '');
    assert.equal(d.planFired, 0);
  });
  it('whitelist: cloneTask/merge держит поля при равных ts', () => {
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 2, planDate: '05.10.2026', planFired: 0 },
      { id: 'a', title: 'R', ts: 1 }).planDate, '05.10.2026', 'победа local с планом');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 1 },
      { id: 'a', title: 'R', ts: 2, planDate: '05.10.2026', planFired: 9 }).planFired, 9,
      'победа remote со сработавшим');
    assert.equal(L.mergeTask({ id: 'a', title: 'L', ts: 2, planDate: '05.10.2026' },
      { id: 'a', title: 'R', ts: 2 }).planDate, '05.10.2026',
      'равные ts — локальный план не теряется');
    assert.ok(L.isPlanned(L.normalizeTask({ id: 'x', title: 'П', planDate: '05.10.2026' })));
    assert.equal(L.isPlanned(L.normalizeTask({ id: 'x', title: 'П' })), false);
    assert.equal(L.isPlanned({ id: 'x', planDate: '05.10.2026', deleted: true }), false, 'могила — не план');
    assert.equal(L.isPlanned(null), false);
  });
  it('clarify: смена planDate сбрасывает planFired', () => {
    const t = L.blankTasks();
    mkPlan(t, 'План', '05.10.2026', 1000, 'p');
    L.getTask(t, 'p').planFired = 777;
    L.clarifyTask(t, 'p', { planDate: '06.10.2026' }, 2000);
    assert.equal(L.getTask(t, 'p').planDate, '06.10.2026');
    assert.equal(L.getTask(t, 'p').planFired, 0, 'смена даты сбросила флаг');
    L.getTask(t, 'p').planFired = 555;
    L.clarifyTask(t, 'p', { planDate: '06.10.2026' }, 3000);
    assert.equal(L.getTask(t, 'p').planFired, 555, 'та же дата — не смена');
    L.clarifyTask(t, 'p', { title: 'Новое' }, 4000);
    assert.equal(L.getTask(t, 'p').planFired, 555, 'чужой patch флаг не трогает');
    L.clarifyTask(t, 'p', { planDate: '' }, 5000);
    assert.equal(L.getTask(t, 'p').planFired, 0, 'очистка даты тоже сброс');
  });
  it('planDueTasks: порог 05:00 включительно (граница >=)', () => {
    const t = L.blankTasks();
    mkPlan(t, 'Сегодня', '16.10.2026', 1000, 'p');
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 16, 5, 0))), ['p'], 'ровно 05:00 — пора');
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 16, 6, 0))), ['p']);
    assert.deepEqual(L.planDueTasks(t, {}, localMs(2026, 10, 16, 4, 59)), [], 'до порога — ждёт');
  });
  it('planDueTasks: прошлое — пора, будущее — нет', () => {
    const t = L.blankTasks();
    mkPlan(t, 'Сегодня', '16.10.2026', 1000, 'p');
    mkPlan(t, 'Вчера', '15.10.2026', 1000, 'y');
    mkPlan(t, 'Завтра', '17.10.2026', 1000, 'f');
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 16, 12, 0))), ['p', 'y']);
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 20, 12, 0))), ['p', 'y', 'f'], 'догон: старые ждут');
  });
  it('planDueTasks: planFired≠0, битая дата, удалённые — skip', () => {
    const t = L.blankTasks();
    mkPlan(t, 'Ждёт', '15.10.2026', 1000, 'w');
    mkPlan(t, 'Был', '15.10.2026', 1000, 'f');
    L.getTask(t, 'f').planFired = 777;
    t.push({ id: 'b', title: 'Битая', status: 'todo', planDate: 'мусор', planFired: 0 });
    mkPlan(t, 'Снос', '15.10.2026', 1000, 'd');
    L.removeTask(t, 'd', 2000);
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 16, 12, 0))), ['w']);
  });
  it('planDueTasks: выполненный план не срабатывает (v213)', () => {
    const t = L.blankTasks();
    const p = mkPlan(t, 'Готов', '16.10.2026', 1000, 'p');
    L.completeTask(t, 'p', 2000);
    assert.equal(L.getTask(t, 'p').status, 'done');
    assert.deepEqual(L.planDueTasks(t, {}, localMs(2026, 10, 16, 12, 0)), [],
      'done-план не в очереди срабатывания');
    L.reopenTask(t, 'p', 3000);
    assert.deepEqual(ids(L.planDueTasks(t, {}, localMs(2026, 10, 16, 12, 0))), ['p'],
      '↩ Не выполнено — снова ждёт срока');
    assert.ok(p, 'mkPlan вернул задачу');
  });
  it('planDueTasks: свой planFireHour, битый → 5', () => {
    const t = L.blankTasks();
    mkPlan(t, 'Сегодня', '16.10.2026', 1000, 'p');
    assert.deepEqual(L.planDueTasks(t, { planFireHour: 9 }, localMs(2026, 10, 16, 8, 0)), []);
    assert.deepEqual(ids(L.planDueTasks(t, { planFireHour: 9 }, localMs(2026, 10, 16, 9, 0))), ['p']);
    assert.equal(L.normFireHour('мусор'), 5);
    assert.equal(L.normFireHour(99), 5);
    assert.equal(L.normFireHour(-1), 5);
    assert.equal(L.normFireHour(0), 0);
    assert.equal(L.normFireHour(23), 23);
    assert.deepEqual(ids(L.planDueTasks(t, { planFireHour: 'мусор' }, localMs(2026, 10, 16, 5, 0))), ['p']);
  });
  it('repeat: нормализация и getRepeat (v213)', () => {
    assert.equal(L.normRepeatEvery(5), 5);
    assert.equal(L.normRepeatEvery(0), 0, '0 — повтора нет');
    assert.equal(L.normRepeatEvery(150), 99, 'потолок 99');
    assert.equal(L.normRepeatEvery('x'), 0);
    assert.equal(L.normRepeatUnit('week'), 'week');
    assert.equal(L.normRepeatUnit('bogus'), '');
    assert.equal(L.normRepeatUnit(undefined), '');
    assert.equal(L.normRepeatOrdinal(9), 5, '5 = последняя');
    assert.equal(L.normRepeatOrdinal(0), 1);
    assert.equal(L.normRepeatWeekday(9), 0);
    assert.equal(L.normRepeatDay(40), 31);
    assert.equal(L.normRepeatObj({ every: 2, unit: 'week' }).every, 2);
    assert.equal(L.normRepeatObj({ every: 0, unit: 'week' }), null, 'без every — нет');
    assert.equal(L.normRepeatObj({ every: 2, unit: 'bogus' }), null, 'без unit — нет');
    assert.equal(L.normRepeatObj(null), null);
    assert.equal(L.getRepeat({}), null, 'без полей — null');
    assert.equal(L.getRepeat({ repeatEvery: 2, repeatUnit: 'week' }).unit, 'week');
  });
  it('repeat: nextPlanDate день/неделя — фиксированный сдвиг', () => {
    assert.equal(L.nextPlanDate('16.10.2026', { every: 5, unit: 'day' }, localMs(2026, 10, 16, 12, 0)), '21.10.2026');
    assert.equal(L.nextPlanDate('16.10.2026', { every: 2, unit: 'week' }, localMs(2026, 10, 16, 12, 0)), '30.10.2026');
    assert.equal(L.nextPlanDate('16.10.2026', { every: 1, unit: 'week' }, localMs(2026, 10, 16, 12, 0)), '23.10.2026');
    assert.equal(L.nextPlanDate('', { every: 1, unit: 'day' }, Date.now()), '', 'без даты — пусто');
    assert.equal(L.nextPlanDate('16.10.2026', null, Date.now()), '', 'без повтора — пусто');
  });
  it('repeat: месяц — якорный день без дрейфа 31-го', () => {
    const m31 = { every: 1, unit: 'month', day: 31 };
    assert.equal(L.nextPlanDate('31.01.2026', m31, localMs(2026, 1, 31, 12, 0)), '28.02.2026', 'февраль клампит');
    assert.equal(L.nextPlanDate('28.02.2026', m31, localMs(2026, 2, 28, 12, 0)), '31.03.2026', 'без дрейфа — якорь 31');
    assert.equal(L.nextPlanDate('31.03.2026', m31, localMs(2026, 3, 31, 12, 0)), '30.04.2026', 'апрель 30 дней');
    const m15 = { every: 2, unit: 'month', day: 15 };
    assert.equal(L.nextPlanDate('15.01.2026', m15, localMs(2026, 1, 15, 12, 0)), '15.03.2026', 'каждые 2 месяца');
  });
  it('repeat: год — 29.02 в невисокосный → 28, в високосный → 29', () => {
    const y = { every: 1, unit: 'year', day: 29 };
    assert.equal(L.nextPlanDate('29.02.2024', y, localMs(2024, 2, 29, 12, 0)), '28.02.2025', '2025 не високосный');
    assert.equal(L.nextPlanDate('28.02.2027', y, localMs(2027, 2, 28, 12, 0)), '29.02.2028', '2028 високосный → 29');
    const y2 = { every: 2, unit: 'year', day: 1 };
    assert.equal(L.nextPlanDate('01.01.2026', y2, localMs(2026, 1, 1, 12, 0)), '01.01.2028', 'каждые 2 года');
  });
  it('repeat: weekday — 3-я суббота / 1-я суббота месяца', () => {
    const w3 = { every: 1, unit: 'weekday', ordinal: 3, weekday: 6 };
    assert.equal(L.nextPlanDate('17.10.2026', w3, localMs(2026, 10, 17, 12, 0)), '21.11.2026');
    const w1 = { every: 1, unit: 'weekday', ordinal: 1, weekday: 6 };
    assert.equal(L.nextPlanDate('03.10.2026', w1, localMs(2026, 10, 3, 12, 0)), '07.11.2026');
    const wf = { every: 1, unit: 'weekday', ordinal: 5, weekday: 5 };
    assert.equal(L.nextPlanDate('30.10.2026', wf, localMs(2026, 10, 30, 12, 0)), '27.11.2026', 'последняя пятница ноя');
    assert.equal(L.weekdayOccurrence(2026, 10, 6, 3), 17, '3-я сбта 2026-10');
    assert.equal(L.weekdayOccurrence(2026, 10, 1, 1), 5, '1-й понедельник 2026-10');
  });
  it('repeat: nextPlanDate пропускает до будущего (Вариант А)', () => {
    const wk = { every: 1, unit: 'week' };
    // 25.09 + 1н → 02.10, 09.10, 16.10 (все <= 16.10) → 23.10
    assert.equal(L.nextPlanDate('25.09.2026', wk, localMs(2026, 10, 16, 12, 0)), '23.10.2026',
      'пропущенные за простой не плодят — ближайшая будущая');
  });
  it('repeat: snapToWeekdayPattern — подгибка даты к паттерну', () => {
    const w3 = { every: 1, unit: 'weekday', ordinal: 3, weekday: 6 };
    // 10.10.2026 (до 3-й сбты 17.10) → 17.10.2026
    assert.equal(L.snapToWeekdayPattern('10.10.2026', w3), '17.10.2026');
    // уже 3-я сбта → остаётся
    assert.equal(L.snapToWeekdayPattern('17.10.2026', w3), '17.10.2026');
    // после 3-й сбты → следующий месяц (21.11)
    assert.equal(L.snapToWeekdayPattern('25.10.2026', w3), '21.11.2026');
  });
  it('repeat: repeatLabel — склонения и согласование weekday', () => {
    assert.equal(L.repeatLabel({ every: 1, unit: 'day' }), 'каждый день');
    assert.equal(L.repeatLabel({ every: 2, unit: 'day' }), 'каждые 2 дня');
    assert.equal(L.repeatLabel({ every: 5, unit: 'day' }), 'каждые 5 дней');
    assert.equal(L.repeatLabel({ every: 11, unit: 'day' }), 'каждые 11 дней');
    assert.equal(L.repeatLabel({ every: 1, unit: 'week' }), 'каждую неделю');
    assert.equal(L.repeatLabel({ every: 2, unit: 'week' }), 'каждые 2 недели');
    assert.equal(L.repeatLabel({ every: 1, unit: 'month' }), 'каждый месяц');
    assert.equal(L.repeatLabel({ every: 3, unit: 'month' }), 'каждые 3 месяца');
    assert.equal(L.repeatLabel({ every: 1, unit: 'year' }), 'каждый год');
    assert.equal(L.repeatLabel({ every: 2, unit: 'year' }), 'каждые 2 года');
    assert.equal(L.repeatLabel({ every: 1, unit: 'weekday', ordinal: 3, weekday: 6 }), '3-я суббота месяца');
    assert.equal(L.repeatLabel({ every: 1, unit: 'weekday', ordinal: 1, weekday: 1 }), '1-й понедельник месяца', 'муж. род → «-й»');
    assert.equal(L.repeatLabel({ every: 1, unit: 'weekday', ordinal: 1, weekday: 0 }), '1-е воскресенье месяца', 'сред. род → «-е»');
    assert.equal(L.repeatLabel({ every: 1, unit: 'weekday', ordinal: 5, weekday: 5 }), 'последняя пятница месяца');
    assert.equal(L.repeatLabel({ every: 2, unit: 'weekday', ordinal: 3, weekday: 6 }), '3-я суббота месяца · раз в 2 мес.');
    assert.equal(L.repeatLabel(null), '');
  });
  it('repeat: applyRepeatToTask — якорь, weekday-подгибка, снятие', () => {
    const t = L.blankTasks();
    const p = mkPlan(t, 'П', '31.01.2026', 1000, 'p');
    L.applyRepeatToTask(p, { every: 1, unit: 'month' }, 2000);
    assert.equal(p.repeatUnit, 'month', 'unit записан');
    assert.equal(p.repeatDay, 31, 'якорный день из даты');
    L.applyRepeatToTask(p, { every: 1, unit: 'weekday', ordinal: 3, weekday: 6 }, 3000);
    assert.equal(p.repeatUnit, 'weekday');
    assert.equal(p.repeatOrdinal, 3, 'ordinal записан');
    // 31.01 — 5-я сбта; первая «3-я сбта» НЕ РАНЬШЕ неё — 21.02.2026
    assert.equal(p.planDate, '21.02.2026', 'дата подтянута вперёд к паттерну');
    L.applyRepeatToTask(p, null, 4000);
    assert.equal(p.repeatUnit, undefined, 'null снимает повтор');
    assert.equal(p.repeatDay, undefined, 'поля очищены');
  });
  it('repeat: applyRepeatToTask — сработавший с прошедшей датой подвигается', () => {
    const t = L.blankTasks();
    const p = mkPlan(t, 'П', '10.10.2026', 1000, 'p');
    p.planFired = 555; // уже сработал
    L.applyRepeatToTask(p, { every: 1, unit: 'week' }, localMs(2026, 10, 16, 12, 0));
    assert.equal(p.planDate, '17.10.2026', 'подвинул: 10.10+1н=17.10 > 16.10 (сегодня)');
    assert.equal(p.planFired, 0, 'перевооружён');
  });
  it('repeat: normalizeTask/cloneTask не теряют повтор', () => {
    const t = L.blankTasks();
    const p = mkPlan(t, 'П', '17.10.2026', 1000, 'p');
    L.applyRepeatToTask(p, { every: 2, unit: 'weekday', ordinal: 3, weekday: 6 }, 2000);
    const n = L.normalizeTask(p);
    assert.equal(n.repeatEvery, 2, 'normalize сохранил');
    assert.equal(n.repeatUnit, 'weekday');
    assert.equal(n.repeatOrdinal, 3);
    const c = L.cloneTask(p);
    assert.equal(c.repeatEvery, 2, 'clone сохранил');
    assert.equal(c.repeatWeekday, 6);
    const plain = L.normalizeTask({ id: 'x', title: 'Обычная', status: 'todo' });
    assert.equal(plain.repeatEvery, undefined, 'без повтора полей нет (файл не пухнет)');
    assert.equal(L.getRepeat(plain), null);
  });
  it('repeat: clarifyTask patch.repeat выставляет и снимает', () => {
    const t = L.blankTasks();
    mkPlan(t, 'П', '17.10.2026', 1000, 'p');
    L.clarifyTask(t, 'p', { repeat: { every: 3, unit: 'day' } }, 2000);
    let task = L.getTask(t, 'p');
    assert.equal(task.repeatEvery, 3);
    assert.equal(task.repeatUnit, 'day');
    L.clarifyTask(t, 'p', { repeat: { every: 2, unit: 'year' } }, 3000);
    task = L.getTask(t, 'p');
    assert.equal(task.repeatUnit, 'year', 'смена unit');
    assert.equal(task.repeatDay, 17, 'якорный день 17 из даты');
    L.clarifyTask(t, 'p', { repeat: null }, 4000);
    task = L.getTask(t, 'p');
    assert.equal(task.repeatUnit, undefined, 'null снимает');
  });
  it('planDueTasks: чистый (не мутирует), не-массив — пусто', () => {
    const t = L.blankTasks();
    mkPlan(t, 'Сегодня', '16.10.2026', 1000, 'p');
    const before = JSON.stringify(t);
    const out = L.planDueTasks(t, {}, localMs(2026, 10, 16, 12, 0));
    assert.equal(JSON.stringify(t), before, 'вход не тронут');
    assert.notEqual(out, t);
    assert.deepEqual(L.planDueTasks(null, {}, 1), []);
    assert.deepEqual(L.planDueTasks('мусор', {}, 1), []);
  });
  it('изоляция: stats/todoCount/shareText/searchTasks планов не видят', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    mkPlan(t, 'План дело', '16.10.2026', 2000, 'p');
    assert.deepEqual(L.stats(t), { todo: 1, done: 0 });
    assert.equal(L.todoCount(t), 1);
    assert.equal(L.shareText(t), '- Дело');
    assert.deepEqual(L.searchTasks(t, 'дело'), ['a']);
  });
});

describe('планирование ФАЗА 1: создание плана и метка даты (FR-95)', () => {
  it('createPlan: название и дата обязательны, иначе null', () => {
    const t = L.blankTasks();
    assert.equal(L.createPlan(t, '', '16.10.2026', 1000), null, 'пустой title — не создавать');
    assert.equal(L.createPlan(t, '   ', '16.10.2026', 1000), null);
    assert.equal(L.createPlan(t, 'План', '', 1000), null, 'без даты — не создавать');
    assert.equal(L.createPlan(t, 'План', 'мусор', 1000), null, 'битая дата — не создавать');
    assert.equal(L.createPlan(t, 'План', '32.10.2026', 1000), null);
    assert.equal(L.createPlan(t, 'План', '29.02.2025', 1000), null, '29.02 невисокосного — не создавать');
    assert.equal(t.length, 0, 'массив не растёт при отказе');
    assert.equal(L.createPlan(null, 'План', '16.10.2026', 1000), null, 'не-массив — null');
  });
  it('createPlan: плоская живая запись с датой, флаг ждёт', () => {
    const t = L.blankTasks();
    const p = L.createPlan(t, '  Позвонить  ', '16.10.2026', 1000, { id: 'p1' });
    assert.equal(p.id, 'p1');
    assert.equal(p.title, 'Позвонить');
    assert.equal(p.status, 'todo');
    assert.equal(p.planDate, '16.10.2026');
    assert.equal(p.planFired, 0, 'новый план — ждёт');
    assert.equal(p.indent, 0, 'план плоский');
    assert.equal(p.deleted, false);
    assert.ok(L.isPlanned(p));
    assert.equal(L.createPlan(t, 'Второй', '2026-10-17', 2000, { id: 'p2' }).planDate,
      '17.10.2026', 'ISO-дата приводится');
  });
  it('createPlan: whitelist держит план после normalize/merge', () => {
    const t = L.blankTasks();
    L.createPlan(t, 'План', '16.10.2026', 1000, { id: 'p' });
    const n = L.normalizeTasks(t);
    assert.equal(n.length, 1);
    assert.equal(n[0].planDate, '16.10.2026');
    const m = L.mergeTasks([], t);
    assert.equal(m.length, 1);
    assert.equal(m[0].planDate, '16.10.2026');
  });
  it('planChipText: дата, сработавшая с галочкой, не-план пусто', () => {
    assert.equal(L.planChipText({ planDate: '16.10.2026', planFired: 0 }), '16.10.2026');
    assert.equal(L.planChipText({ planDate: '16.10.2026', planFired: 777 }), '16.10.2026 ✓');
    assert.equal(L.planChipText({ planDate: '', planFired: 0 }), '', 'не план — метки нет');
    assert.equal(L.planChipText({ planDate: 'мусор', planFired: 0 }), '');
    assert.equal(L.planChipText({ planDate: '16.10.2026', deleted: true }), '', 'могила — не план');
    assert.equal(L.planChipText(null), '');
  });
});

describe('планирование ФАЗА 2: дочка — заголовок и отступ (FR-98)', () => {
  it('planChildTitle: суффикс «(ДД.ММ.ГГГГ)» из planDate', () => {
    assert.equal(L.planChildTitle('Купить масло', '16.10.2026'), 'Купить масло (16.10.2026)');
    assert.equal(L.planChildTitle('  Проверить  ', '01.01.2027'), 'Проверить (01.01.2027)');
  });
  it('planChildTitle: битые дата/название → пусто (дочки нет)', () => {
    assert.equal(L.planChildTitle('План', ''), '');
    assert.equal(L.planChildTitle('План', 'мусор'), '');
    assert.equal(L.planChildTitle('', '16.10.2026'), '');
    assert.equal(L.planChildTitle(null, '16.10.2026'), '');
    assert.equal(L.planChildTitle(undefined, undefined), '');
  });
  it('planChildTitle: название режется до 460 — дата под нож не идёт', () => {
    const long = 'х'.repeat(500);
    const child = L.planChildTitle(long, '16.10.2026');
    assert.equal(child, 'х'.repeat(460) + ' (16.10.2026)', 'суффикс цел, база 460');
    assert.ok(child.length <= 500, 'в лимит normTitle');
    assert.ok(child.endsWith('(16.10.2026)'), 'дата в конце');
  });
  it('planChildIndent: под целевой на 1, потолок 8, мусор → 1', () => {
    assert.equal(L.planChildIndent(0), 1);
    assert.equal(L.planChildIndent(7), 8);
    assert.equal(L.planChildIndent(8), 8, 'цель на потолке — дочка рядом с ней');
    assert.equal(L.planChildIndent(9), 8, 'данные чиним к потолку');
    assert.equal(L.planChildIndent(-3), 1);
    assert.equal(L.planChildIndent('мусор'), 1);
    assert.equal(L.planChildIndent(null), 1);
  });
  it('createPlan: заголовок режется до 460 ещё при создании', () => {
    const t = L.blankTasks();
    const p = L.createPlan(t, 'х'.repeat(600), '16.10.2026', 1000);
    assert.ok(p, 'план создан');
    assert.equal(p.title.length, 460, 'потолок 460 под будущий суффикс');
    assert.equal(L.planChildTitle(p.title, p.planDate).length, 460 + 13,
      'дочка влезает целиком');
  });
});
