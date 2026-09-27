/* sync.js — необязательная синхронизация через GitHub Contents API.
 * Файл состояния: data/state.json в ветке main: { updatedAt, tasks }.
 * Алгоритм: скачать общий файл, позадачно объединить с локальным
 * (mergeTasks: для каждой задачи побеждает свежая метка ts),
 * опубликовать объединённый результат. Токен хранится только
 * в настройках на устройстве, в репозиторий не попадает.
 * Методология (кэш/таймауты/ретраи) позаимствована из alex/purchases.
 *
 * Зависимости (L, fetchImpl) инжектятся для тестируемости в Node;
 * в браузере берутся window.EBLogic / window.fetch.
 */
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory;
  } else {
    var fetchImpl = (root.fetch) ? root.fetch.bind(root) : null;
    root.EBSync = factory(root.EBLogic, fetchImpl);
  }
}(typeof window !== 'undefined' ? window : {}, function (L, fetchImpl, opts) {
  opts = opts || {};
  var MAX_RETRIES = (opts.maxRetries != null) ? opts.maxRetries : 5;
  var BACKOFF_BASE = (opts.baseMs != null) ? opts.baseMs : 800;
  var BACKOFF_CAP = (opts.capMs != null) ? opts.capMs : 8000;
  var BACKOFF_JITTER = (opts.jitterMs != null) ? opts.jitterMs : 300;
  var FETCH_TIMEOUT = (opts.timeoutMs != null) ? opts.timeoutMs : 20000;
  var sleepFn = opts.sleep || sleep;

  /* Запрос с таймаутом: на рваной мобильной сети fetch может висеть минутами.
   * Старые WebView без AbortController — поэтому гонка через Promise.race. */
  function timedFetch(url, fopts) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timeout'));
      }, FETCH_TIMEOUT);
      fetchImpl(url, fopts).then(function (r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function apiBase(repo) {
    return 'https://api.github.com/repos/' + repo + '/contents/data/state.json';
  }

  function headers(token) {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token
    };
  }

  function getRemote(repo, token) {
    /* cache: no-store — API GitHub кэшируется браузером до минуты,
     * без этого устройство видит старое и рапортует in-sync. */
    return timedFetch(apiBase(repo) + '?ref=main', { headers: headers(token), cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('github-get ' + r.status);
      return r.json();
    }).then(function (body) {
      if (!body) return null;
      if (typeof body.content !== 'string') {
        throw new Error('github-get: ' + (body.message ? body.message : 'bad response'));
      }
      var json = JSON.parse(decodeURIComponent(escape(atob(body.content.replace(/\n/g, '')))));
      return { sha: body.sha, state: json };
    });
  }

  function putRemote(repo, token, state, sha) {
    var content = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    var payload = { message: 'Sync external-brain', content: content, branch: 'main' };
    if (sha) payload.sha = sha;
    return timedFetch(apiBase(repo), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers(token)),
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error('github-put ' + r.status);
      return r.json();
    });
  }

  function fmtErr(e) {
    if (!e) return 'unknown';
    var name = e.name ? e.name + ': ' : '';
    var msg = e.message || String(e);
    return (name + msg).slice(0, 300);
  }

  /* Публикация произвольного JSON-файла (журналы диагностики):
   * создать или перезаписать по sha. Возвращает текст статуса, не бросает. */
  function publishFile(repo, token, path, obj) {
    var url = 'https://api.github.com/repos/' + repo + '/contents/' + path;
    return fetchImpl(url + '?ref=main', { headers: headers(token) }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('github-log-get ' + r.status);
      return r.json();
    }).then(function (body) {
      var payload = {
        message: 'Sync journal',
        content: btoa(unescape(encodeURIComponent(JSON.stringify(obj)))),
        branch: 'main'
      };
      if (body && body.sha) payload.sha = body.sha;
      return fetchImpl(url, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers(token)),
        body: JSON.stringify(payload)
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('github-log-put ' + r.status);
      return r.json();
    }).then(function () {
      return 'logged';
    }).catch(function (e) {
      return 'log-error: ' + fmtErr(e);
    });
  }

  function syncNow(state) {
    var repo = state.settings.repo;
    var token = state.settings.token;
    if (!token) return Promise.resolve({ status: 'no-token', state: state });
    return attempt(state, repo, token, MAX_RETRIES).catch(function (e) {
      return { status: 'error', state: state, error: fmtErr(e) };
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* Пауза перед ретраем: растёт экспоненциально + случайный джиттер,
   * чтобы два устройства не долбили API в один и тот же момент. */
  function backoffDelay(retryIndex) {
    var base = Math.min(BACKOFF_BASE * Math.pow(2, retryIndex), BACKOFF_CAP);
    return base + Math.floor(Math.random() * (BACKOFF_JITTER + 1));
  }

  /* Одна попытка: скачать → объединить → опубликовать.
   * При 409/422 (кто-то запушил между GET и PUT) пауза, перечитать и объединить заново. */
  function attempt(state, repo, token, triesLeft) {
    return getRemote(repo, token).then(function (remote) {
      if (!remote) {
        if (L.isTasksEmpty(state.tasks)) {
          return { status: 'in-sync', state: state };
        }
        return putRemote(repo, token, { updatedAt: state.updatedAt, tasks: state.tasks }, null)
          .then(function () { return { status: 'pushed', state: state }; });
      }
      var remoteState = (remote.state && typeof remote.state === 'object') ? remote.state : {};
      var remoteTasks = L.normalizeTasks(remoteState.tasks);
      var mergedTasks = L.mergeTasks(state.tasks, remoteTasks);
      var localChanged = !L.tasksEqual(mergedTasks, state.tasks);
      var remoteChanged = !L.tasksEqual(mergedTasks, remoteTasks);
      if (localChanged) {
        state.tasks = mergedTasks;
        state.updatedAt = Date.now();
      }
      if (!remoteChanged) {
        return { status: localChanged ? 'pulled' : 'in-sync', state: state, sha: remote.sha };
      }
      var payload = {
        updatedAt: Math.max(state.updatedAt, remoteState.updatedAt || 0, Date.now()),
        tasks: mergedTasks
      };
      return putRemote(repo, token, payload, remote.sha)
        .then(function () {
          state.updatedAt = payload.updatedAt;
          return { status: localChanged ? 'merged' : 'pushed', state: state };
        })
        .catch(function (e) {
          var msg = String(e && e.message || e);
          if (triesLeft > 0 && /github-put (409|422)/.test(msg)) {
            return sleepFn(backoffDelay(MAX_RETRIES - triesLeft)).then(function () {
              return attempt(state, repo, token, triesLeft - 1);
            });
          }
          throw e;
        });
    });
  }

  return { syncNow: syncNow, getRemote: getRemote, putRemote: putRemote, fmtErr: fmtErr, publishFile: publishFile };
}));
