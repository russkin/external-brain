/* store.js — локальное хранилище: IndexedDB с fallback на localStorage.
 * Ключ: 'external-brain-v1' -> { tasks, settings, updatedAt }.
 * Методология позаимствована из alex/purchases (store.js).
 */
'use strict';

(function () {
  var LS_KEY = 'external-brain-v1';
  var BACKUP_KEY = 'external-brain-backup-v1';
  var DB_NAME = 'external-brain';
  var STORE = 'state';

  /* Локальная копия состояния («state.json в браузере»): перед каждой
   * записью в основное хранилище предыдущее сохранённое состояние уходит
   * в localStorage под BACKUP_KEY — копия всегда «на шаг позади» и
   * переживает сбой синка/очистку задач. restoreBackup() помечает, что
   * следующая запись НЕ должна перетирать копию — иначе сам акт
   * восстановления затёр бы хорошую копию текущим состоянием. */
  var lastPersisted = null;
  var skipBackupOnce = false;

  function snap(s) {
    try { return JSON.parse(JSON.stringify(s)); } catch (e) { return null; }
  }
  function backupWrite(prev) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: Date.now(), state: prev }));
    } catch (e) {}
  }
  function backupRead() {
    try {
      var raw = localStorage.getItem(BACKUP_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && o.state && typeof o.state === 'object') ? o : null;
    } catch (e) { return null; }
  }

  function lsRead() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function lsWrite(state) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Самопроверка памяти: пишет и читает тестовый ключ. */
  function lsWorks() {
    try {
      var k = LS_KEY + '-probe';
      localStorage.setItem(k, '1');
      var ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('no-indexeddb'));
      try {
        var req = window.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore(STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('idb-open')); };
      } catch (e) {
        reject(e);
      }
    });
  }

  function idbGet(db) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(LS_KEY);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      } catch (e) {
        reject(e);
      }
    });
  }

  function idbSet(db, state) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        var rq = tx.objectStore(STORE).put(state, LS_KEY);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error); };
      } catch (e) {
        reject(e);
      }
    });
  }

  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = idbOpen().catch(function () { return null; });
    }
    return dbPromise;
  }

  function defaultState() {
    return {
      tasks: window.EBLogic.blankTasks(),
      settings: { repo: 'russkin/external-brain', token: '' },
      updatedAt: Date.now()
    };
  }

  function sanitize(state) {
    if (!state || typeof state !== 'object') return defaultState();
    if (!Array.isArray(state.tasks)) {
      state.tasks = window.EBLogic.blankTasks();
    } else {
      state.tasks = window.EBLogic.normalizeTasks(state.tasks);
    }
    if (!state.settings) state.settings = { repo: 'russkin/external-brain', token: '' };
    if (!state.settings.repo) state.settings.repo = 'russkin/external-brain';
    if (state.settings.token == null) state.settings.token = '';
    if (!state.updatedAt) state.updatedAt = Date.now();
    return state;
  }

  window.EBStore = {
    load: function () {
      function track(s) { lastPersisted = snap(s); return s; }
      return db().then(function (d) {
        if (!d) return track(sanitize(lsRead()));
        return idbGet(d).then(function (s) {
          return track(sanitize(s || lsRead()));
        }).catch(function () {
          return track(sanitize(lsRead()));
        });
      });
    },
    save: function (state) {
      if (skipBackupOnce) skipBackupOnce = false;
      else if (lastPersisted) backupWrite(lastPersisted);
      state.updatedAt = Date.now();
      var ok = lsWrite(state);
      if (ok) lastPersisted = snap(state);
      return db().then(function (d) {
        if (!d) return ok && lsWorks();
        return idbSet(d, state).then(function () {
          lastPersisted = snap(state);
          return true;
        }).catch(function () { return ok; });
      });
    },
    /* { savedAt, state } — копия для диагностики, или null. */
    backupInfo: function () { return backupRead(); },
    /* Копия состояния для восстановления + защита от перетирания
     * самой копии при последующем сохранении. null — копии нет. */
    restoreBackup: function () {
      var b = backupRead();
      if (!b) return null;
      skipBackupOnce = true;
      return b.state;
    }
  };
})();
