/* store.js — локальное хранилище: IndexedDB с fallback на localStorage.
 * Ключ: 'external-brain-v1' -> { tasks, settings, updatedAt }.
 * Методология позаимствована из alex/purchases (store.js).
 */
'use strict';

(function () {
  var LS_KEY = 'external-brain-v1';
  var DB_NAME = 'external-brain';
  var STORE = 'state';

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
      return db().then(function (d) {
        if (!d) return sanitize(lsRead());
        return idbGet(d).then(function (s) {
          return sanitize(s || lsRead());
        }).catch(function () {
          return sanitize(lsRead());
        });
      });
    },
    save: function (state) {
      state.updatedAt = Date.now();
      var ok = lsWrite(state);
      return db().then(function (d) {
        if (!d) return ok && lsWorks();
        return idbSet(d, state).then(function () { return true; }).catch(function () { return ok; });
      });
    }
  };
})();
