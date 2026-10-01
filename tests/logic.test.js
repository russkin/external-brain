'use strict';
/* Unit-тесты чистой логики (src/logic.js): инбокс, прояснение, лягушки, слоны, слияние. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../src/logic.js');

function mk(tasks, title, now, opts) {
  return L.createTask(tasks, title, now, opts);
}

describe('создание и инбокс', () => {
  it('новое падает в инбокс', () => {
    const t = L.blankTasks();
    const task = mk(t, 'Купить хлеб', 1000, { id: 'a1' });
    assert.equal(task.status, 'inbox');
    assert.equal(task.title, 'Купить хлеб');
    assert.equal(L.inboxCount(t), 1);
  });
  it('пустой заголовок — null, массив не растёт', () => {
    const t = L.blankTasks();
    assert.equal(mk(t, '   ', 1000), null);
    assert.equal(mk(t, '', 1000), null);
    assert.equal(mk(t, null, 1000), null);
    assert.equal(t.length, 0);
  });
  it('заголовок тримится, проект тримится, id генерируется', () => {
    const t = L.blankTasks();
    const a = mk(t, '  Дело  ', 1000, { project: '  Дом ' });
    assert.equal(a.title, 'Дело');
    assert.equal(a.project, 'Дом');
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
  it('slicesTotal ограничивается сверху', () => {
    const t = L.blankTasks();
    const task = mk(t, 'Слон', 1000, { slicesTotal: 5000 });
    assert.equal(task.slicesTotal, 1000);
  });
});

describe('прояснение (clarify)', () => {
  it('раскладывает инбокс по статусам', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    for (const s of ['next', 'waiting', 'someday', 'done']) {
      L.clarifyTask(t, 'a', { status: s }, 2000);
      assert.equal(L.getTask(t, 'a').status, s);
    }
  });
  it('невалидный статус игнорируется', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'todo' }, 2000);
    assert.equal(L.getTask(t, 'a').status, 'inbox');
  });
  it('done ставит doneAt, уход из done сбрасывает', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'done' }, 2000);
    assert.equal(L.getTask(t, 'a').doneAt, 2000);
    L.clarifyTask(t, 'a', { status: 'next' }, 3000);
    assert.equal(L.getTask(t, 'a').doneAt, 0);
  });
  it('проект, лягушка, нарезка, переименование', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { project: 'Работа', frog: true, slicesTotal: 5, title: 'Важное' }, 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.project, 'Работа');
    assert.equal(g.frog, true);
    assert.equal(g.slicesTotal, 5);
    assert.equal(g.title, 'Важное');
  });
  it('пустое переименование игнорируется, нарезка урезает съеденное', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.setSlices(t, 'a', 5, 1500);
    L.completeSlice(t, 'a', 1600);
    L.completeSlice(t, 'a', 1700);
    L.clarifyTask(t, 'a', { title: '  ', slicesTotal: 1 }, 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.title, 'Дело');
    assert.equal(g.slicesDone, 1);
  });
  it('чужая и удалённая задачи — null', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    assert.equal(L.clarifyTask(t, 'zzz', { status: 'next' }, 2000), null);
    L.removeTask(t, 'a', 2000);
    assert.equal(L.clarifyTask(t, 'a', { status: 'next' }, 3000), null);
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
    assert.equal(L.getTask(t, 'a').status, 'next');
    assert.equal(L.getTask(t, 'a').doneAt, 0);
  });
  it('reopen не-done возвращает как есть', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    const r = L.reopenTask(t, 'a', 2000);
    assert.equal(r.status, 'inbox');
  });
  it('удаление — tombstone, списки его не видят', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'next' }, 1500);
    L.removeTask(t, 'a', 2000);
    const g = L.getTask(t, 'a');
    assert.equal(g.deleted, true);
    assert.equal(L.nextList(t).length, 0);
    assert.equal(L.inboxCount(t), 0);
  });
  it('операции над чужими — null', () => {
    const t = L.blankTasks();
    assert.equal(L.completeTask(t, 'z', 1), null);
    assert.equal(L.reopenTask(t, 'z', 1), null);
    assert.equal(L.removeTask(t, 'z', 1), null);
    assert.equal(L.setFrog(t, 'z', true, 1), null);
    assert.equal(L.setSlices(t, 'z', 3, 1), null);
    assert.equal(L.completeSlice(t, 'z', 1), null);
  });
});

describe('лягушки и слоны', () => {
  it('setFrog вкл/выкл', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    L.setFrog(t, 'a', true, 2000);
    assert.equal(L.getTask(t, 'a').frog, true);
    L.setFrog(t, 'a', false, 3000);
    assert.equal(L.getTask(t, 'a').frog, false);
  });
  it('next: лягушки первые', () => {
    const t = L.blankTasks();
    mk(t, 'Обычное', 1000, { id: 'a' });
    mk(t, 'Лягушка', 2000, { id: 'b' });
    L.clarifyTask(t, 'a', { status: 'next' }, 3000);
    L.clarifyTask(t, 'b', { status: 'next', frog: true }, 3000);
    const nx = L.nextList(t);
    assert.equal(nx[0].id, 'b');
    assert.equal(nx[1].id, 'a');
  });
  it('без лягушек — по времени создания', () => {
    const t = L.blankTasks();
    mk(t, 'Второе', 2000, { id: 'b' });
    mk(t, 'Первое', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'next' }, 3000);
    L.clarifyTask(t, 'b', { status: 'next' }, 3000);
    const nx = L.nextList(t);
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
  it('бифштексы: +1, автозавершение при последнем', () => {
    const t = L.blankTasks();
    mk(t, 'Слон', 1000, { id: 'a' });
    L.clarifyTask(t, 'a', { status: 'next', slicesTotal: 2 }, 1500);
    L.completeSlice(t, 'a', 2000);
    assert.equal(L.getTask(t, 'a').slicesDone, 1);
    assert.equal(L.getTask(t, 'a').status, 'next');
    L.completeSlice(t, 'a', 3000);
    assert.equal(L.getTask(t, 'a').status, 'done');
    assert.equal(L.getTask(t, 'a').doneAt, 3000);
  });
  it('без нарезки completeSlice ничего не меняет', () => {
    const t = L.blankTasks();
    mk(t, 'Дело', 1000, { id: 'a' });
    const r = L.completeSlice(t, 'a', 2000);
    assert.equal(r.slicesDone, 0);
    assert.equal(r.status, 'inbox');
  });
  it('setSlices урезает и ограничивает', () => {
    const t = L.blankTasks();
    mk(t, 'Слон', 1000, { id: 'a' });
    L.setSlices(t, 'a', 3, 1500);
    L.completeSlice(t, 'a', 1600);
    L.completeSlice(t, 'a', 1700);
    L.setSlices(t, 'a', 1, 1800);
    assert.equal(L.getTask(t, 'a').slicesDone, 1);
    L.setSlices(t, 'a', 9999, 1900);
    assert.equal(L.getTask(t, 'a').slicesTotal, 1000);
  });
});

describe('списки и фокус', () => {
  it('списки по статусам, инбокс по времени', () => {
    const t = L.blankTasks();
    mk(t, 'Позже', 2000, { id: 'b' });
    mk(t, 'Раньше', 1000, { id: 'a' });
    const ib = L.inboxList(t);
    assert.equal(ib[0].id, 'a');
    L.clarifyTask(t, 'a', { status: 'waiting' }, 3000);
    assert.equal(L.waitingList(t).length, 1);
    L.clarifyTask(t, 'b', { status: 'someday' }, 3000);
    assert.equal(L.somedayList(t).length, 1);
    assert.equal(L.inboxCount(t), 0);
  });
  it('done сортируется свежими первыми', () => {
    const t = L.blankTasks();
    mk(t, 'Старое', 1000, { id: 'a' });
    mk(t, 'Новое', 1000, { id: 'b' });
    L.completeTask(t, 'a', 2000);
    L.completeTask(t, 'b', 3000);
    assert.equal(L.doneList(t)[0].id, 'b');
  });
  it('фокус: лягушка > следующее > инбокс > null', () => {
    const t = L.blankTasks();
    assert.equal(L.focusTask(t), null);
    mk(t, 'Мысль', 1000, { id: 'i' });
    assert.equal(L.focusTask(t).id, 'i');
    mk(t, 'Действие', 2000, { id: 'n' });
    L.clarifyTask(t, 'n', { status: 'next' }, 3000);
    assert.equal(L.focusTask(t).id, 'n');
    mk(t, 'Лягушка', 2500, { id: 'f' });
    L.clarifyTask(t, 'f', { status: 'next', frog: true }, 3000);
    assert.equal(L.focusTask(t).id, 'f');
  });
  it('stats считает всё', () => {
    const t = L.blankTasks();
    mk(t, 'I', 1000, { id: 'i' });
    mk(t, 'N', 1000, { id: 'n' });
    mk(t, 'W', 1000, { id: 'w' });
    mk(t, 'S', 1000, { id: 's' });
    mk(t, 'D', 1000, { id: 'd' });
    L.clarifyTask(t, 'n', { status: 'next', frog: true }, 2000);
    L.clarifyTask(t, 'w', { status: 'waiting' }, 2000);
    L.clarifyTask(t, 's', { status: 'someday' }, 2000);
    L.completeTask(t, 'd', 2000);
    const st = L.stats(t);
    assert.deepEqual(st, { inbox: 1, next: 1, waiting: 1, someday: 1, done: 1, hasFrog: true });
  });
  it('shareText: пусто и с данными', () => {
    assert.equal(L.shareText(L.blankTasks()), '');
    const t = L.blankTasks();
    mk(t, 'Лягушка', 1000, { id: 'f', project: 'Дом', frog: true });
    L.clarifyTask(t, 'f', { status: 'next', slicesTotal: 3 }, 2000);
    const txt = L.shareText(t);
    assert.ok(txt.includes('Лягушка'));
    assert.ok(txt.includes('[Дом]'));
    assert.ok(txt.includes('(0/3)'));
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
    assert.equal(n.status, 'inbox');
    assert.equal(n.slicesTotal, 0);
    assert.equal(n.slicesDone, 0);
    assert.equal(n.frog, true);
  });
  it('done без doneAt берёт updatedAt, не-done обнуляет', () => {
    const d = L.normalizeTask({ id: 'a', title: 'T', status: 'done', updatedAt: 500 });
    assert.equal(d.doneAt, 500);
    const n = L.normalizeTask({ id: 'b', title: 'T', status: 'next', doneAt: 500 });
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
  });
  it('mergeTasks объединяет наборы', () => {
    const a = [{ id: 'x', title: 'X', status: 'inbox', ts: 100, createdAt: 100, updatedAt: 100 }];
    const b = [{ id: 'y', title: 'Y', status: 'next', ts: 100, createdAt: 200, updatedAt: 100 }];
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
    assert.equal(L.getTask(t, 'q').status, 'inbox');
    assert.ok(L.getTask(t, 'p').doneAt > L.getTask(t, 'k1').doneAt);
    assert.ok(L.getTask(t, 'k1').doneAt > L.getTask(t, 'k2').doneAt);
    assert.equal(L.completeBranch(order, 'nope', 9000).length, 0);
    assert.deepEqual(L.completeBranch(null, 'p', 9000), []);
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
      { id: 'a', title: 'A', status: 'inbox', indent: 1 },
      { id: 'q', title: 'Q', status: 'inbox', indent: 0 },
      { id: 'b', title: 'B', status: 'inbox', indent: 1 }
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
