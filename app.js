/* app.js — интерфейс «Внешнего мозга»: инбокс + прояснение по джедайским техникам. */
'use strict';

(function () {
  var APP_VERSION = 'v1';
  var L = window.EBLogic;
  var state = null;
  var syncStatus = '';
  var lastAction = '';
  var bootError = '';
  var bootStack = '';

  function el(id) { return document.getElementById(id); }

  /* Подписка, стойкая к рассинхрону кэшей: если index.html старый, а app.js новый,
   * элемента может не быть — пропускаем подписку, а не роняем всё приложение. */
  function on(id, ev, fn) {
    var n = el(id);
    if (n) n.addEventListener(ev, fn);
    return n;
  }

  window.addEventListener('error', function (e) {
    var msg = (e && e.message) ? e.message : String(e);
    var stack = '';
    try {
      if (e && e.error && e.error.stack) stack = String(e.error.stack);
    } catch (x) { stack = ''; }
    if (!stack) stack = 'at ' + ((e && e.filename) ? e.filename : '?') + ':' + ((e && e.lineno) ? e.lineno : '?');
    bootError = 'ОШИБКА: ' + msg;
    bootStack = stack.slice(0, 1500);
    try { renderStatus(); } catch (err) {
      var s = document.getElementById('status');
      if (s) s.textContent = bootError;
    }
  });

  /* Своя модалка: prompt/confirm на iOS Chrome вне user-activation блокируются. */
  function askText(title, initial, showClear) {
    return new Promise(function (resolve) {
      var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
      var ok = el('modalOk'), clear = el('modalClear'), cancel = el('modalCancel');
      if (!back || !input || !ok || !cancel) { resolve(null); return; }
      text.textContent = title;
      input.style.display = '';
      input.value = initial || '';
      var clearBtn = el('modalClear');
      if (clearBtn) clearBtn.style.display = showClear ? '' : 'none';
      back.classList.add('open');
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
      function done(v) {
        back.classList.remove('open');
        ok.onclick = null; cancel.onclick = null;
        if (clearBtn) clearBtn.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(input.value); };
      if (clearBtn) clearBtn.onclick = function () { done(''); };
      cancel.onclick = function () { done(null); };
    });
  }

  function askConfirm(title) {
    return new Promise(function (resolve) {
      var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
      var ok = el('modalOk'), cancel = el('modalCancel'), clearBtn = el('modalClear');
      if (!back || !ok || !cancel) { resolve(false); return; }
      text.textContent = title;
      if (input) input.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      back.classList.add('open');
      function done(v) {
        back.classList.remove('open');
        ok.onclick = null; cancel.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
    });
  }

  function save() {
    if (!state) return Promise.resolve(false);
    return window.EBStore.save(state).then(function () {
      scheduleSync();
      return true;
    });
  }

  function mutate(fn) {
    var r = fn();
    render();
    save();
    return r;
  }

  /* --- single-flight синк: летит один, повтор ждёт очереди --- */
  var syncFlying = false;
  var syncQueued = false;
  var syncFails = 0;
  var syncTimer = null;

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { doSync(); }, 2000);
  }

  function doSync(force) {
    if (!state || !state.settings.token) {
      syncStatus = 'выключен (нет ключа)';
      renderStatus();
      return Promise.resolve('no-token');
    }
    if (syncFlying) { syncQueued = true; return Promise.resolve('queued'); }
    syncFlying = true;
    setLight('yellow', true);
    return window.EBSync.syncNow(state).then(function (res) {
      syncFlying = false;
      syncStatus = res.status;
      if (res.status === 'error') {
        setLight('red', false);
        syncFails += 1;
        if (syncFails <= 5) {
          setTimeout(function () { doSync(); }, 2000);
        }
      } else {
        syncFails = 0;
        setLight(res.status === 'in-sync' ? 'green' : 'green', false);
        if (res.status === 'pulled' || res.status === 'merged') {
          window.EBStore.save(state);
          render();
        }
      }
      if (syncQueued) { syncQueued = false; doSync(); }
      else if (!force) { /* ждём следующий триггер */ }
      renderStatus();
      return res.status;
    }).catch(function (e) {
      syncFlying = false;
      syncStatus = 'error: ' + String(e && e.message || e).slice(0, 120);
      setLight('red', false);
      renderStatus();
      return 'error';
    });
  }

  function setLight(color, blink) {
    var n = el('syncLight');
    if (!n) return;
    var map = { green: '#4caf50', yellow: '#ffc107', red: '#f44336', gray: '#bbb' };
    n.style.background = map[color] || map.gray;
    if (blink) n.classList.add('blink');
    else n.classList.remove('blink');
    n.classList.remove('alert');
  }

  function setAlert() {
    var n = el('syncLight');
    if (!n) return;
    n.classList.add('alert');
    n.style.background = '#f44336';
    n.textContent = '!';
  }

  /* --- Проверка новой версии: качает app.js мимо кэша SW --- */
  var lastCheck = 0;
  function checkUpdate() {
    var now = Date.now();
    if (now - lastCheck < 5 * 60 * 1000) return;
    lastCheck = now;
    fetch('./app.js?nocache=' + now).then(function (r) {
      if (!r.ok) return null;
      return r.text();
    }).then(function (txt) {
      if (!txt) return;
      var m = txt.match(/APP_VERSION\s*=\s*'([^']+)'/);
      if (m && m[1] !== APP_VERSION) {
        askConfirm('Вышла новая версия (' + m[1] + ') — обновить?').then(function (ok) {
          if (!ok) return;
          if ('caches' in window) {
            caches.keys().then(function (keys) {
              return Promise.all(keys.map(function (k) { return caches.delete(k); }));
            }).then(function () { location.reload(); });
          } else location.reload();
        });
      }
    }).catch(function () {});
  }

  function pokeSwUpdate() {
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg && reg.update) reg.update();
        }).catch(function () {});
      }
    } catch (e) {}
  }

  /* --- Рендер --- */

  function taskRow(t, buttons) {
    var div = document.createElement('div');
    div.className = 'row';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.status === 'done';
    cb.setAttribute('aria-label', 'Готово');
    cb.addEventListener('change', function () {
      mutate(function () {
        if (cb.checked) L.completeTask(state.tasks, t.id);
        else L.reopenTask(state.tasks, t.id);
      });
    });
    div.appendChild(cb);
    var nm = document.createElement('span');
    nm.className = 'row-name' + (t.status === 'done' ? ' done' : '');
    var label = t.title;
    if (t.project) label += ' [' + t.project + ']';
    if (t.slicesTotal > 0) label += ' (' + t.slicesDone + '/' + t.slicesTotal + ')';
    if (t.frog) label = 'FROG ' + label;
    nm.textContent = label;
    div.appendChild(nm);
    buttons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.textContent = b[0];
      btn.title = b[1] || b[0];
      btn.addEventListener('click', function () { b[2](t); });
      div.appendChild(btn);
    });
    return div;
  }

  function renderGroup(boxId, title, list, mkButtons) {
    var box = el(boxId);
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    var h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = title + ' (' + list.length + ')';
    box.appendChild(h);
    list.forEach(function (t) {
      box.appendChild(taskRow(t, mkButtons(t)));
    });
  }

  function render() {
    if (!state) return;
    var v = el('appVerHead');
    if (v) v.textContent = APP_VERSION;
    var v2 = el('appVer');
    if (v2) v2.textContent = APP_VERSION;
    var f = L.focusTask(state.tasks);
    var fb = el('focus');
    if (fb) {
      fb.innerHTML = '';
      var fh = document.createElement('div');
      fh.className = 'group-title';
      fh.textContent = 'Фокус дня';
      fb.appendChild(fh);
      var fp = document.createElement('div');
      fp.className = 'focus-text';
      fp.textContent = f ? (f.title + (f.project ? ' [' + f.project + ']' : '')) : 'Инбокс пуст, следующих нет — можно отдыхать';
      fb.appendChild(fp);
    }
    var inboxBtns = function (t) {
      return [
        ['Next', 'В следующие', function (x) { mutate(function () { L.clarifyTask(state.tasks, x.id, { status: 'next' }); }); }],
        ['Wait', 'В ожидание', function (x) { mutate(function () { L.clarifyTask(state.tasks, x.id, { status: 'waiting' }); }); }],
        ['Someday', 'В когда-нибудь', function (x) { mutate(function () { L.clarifyTask(state.tasks, x.id, { status: 'someday' }); }); }],
        ['Proj', 'Проект', function (x) {
          askText('Проект для «' + x.title + '»', x.project || '', true).then(function (p) {
            if (p == null) return;
            mutate(function () { L.clarifyTask(state.tasks, x.id, { project: p, status: 'next' }); });
          });
        }],
        ['X', 'Удалить', function (x) {
          askConfirm('Удалить «' + x.title + '»?').then(function (ok) {
            if (ok) mutate(function () { L.removeTask(state.tasks, x.id); });
          });
        }]
      ];
    };
    var nextBtns = function (t) {
      var arr = [
        [t.frog ? 'Unfrog' : 'Frog', 'Лягушка дня', function (x) { mutate(function () { L.setFrog(state.tasks, x.id, !x.frog); }); }],
        ['+1', 'Съесть бифштекс', function (x) { mutate(function () { L.completeSlice(state.tasks, x.id); }); }],
        ['Slices', 'Нарезать слона', function (x) {
          askText('Сколько бифштексов в слоне «' + x.title + '»? (0 — без нарезки)', String(x.slicesTotal || 0), false).then(function (p) {
            if (p == null) return;
            mutate(function () { L.setSlices(state.tasks, x.id, parseInt(p, 10) || 0); });
          });
        }],
        ['X', 'Удалить', function (x) {
          askConfirm('Удалить «' + x.title + '»?').then(function (ok) {
            if (ok) mutate(function () { L.removeTask(state.tasks, x.id); });
          });
        }]
      ];
      return arr;
    };
    var simpleBtns = function (t) {
      return [
        ['Next', 'В следующие', function (x) { mutate(function () { L.clarifyTask(state.tasks, x.id, { status: 'next' }); }); }],
        ['X', 'Удалить', function (x) {
          askConfirm('Удалить «' + x.title + '»?').then(function (ok) {
            if (ok) mutate(function () { L.removeTask(state.tasks, x.id); });
          });
        }]
      ];
    };
    var doneBtns = function (t) {
      return [
        ['Reopen', 'Вернуть', function (x) { mutate(function () { L.reopenTask(state.tasks, x.id); }); }],
        ['X', 'Удалить', function (x) {
          askConfirm('Удалить «' + x.title + '»?').then(function (ok) {
            if (ok) mutate(function () { L.removeTask(state.tasks, x.id); });
          });
        }]
      ];
    };
    renderGroup('gInbox', 'Инбокс — прояснить', L.inboxList(state.tasks), inboxBtns);
    renderGroup('gNext', 'Следующие', L.nextList(state.tasks), nextBtns);
    renderGroup('gWaiting', 'Ожидание', L.waitingList(state.tasks), simpleBtns);
    renderGroup('gSomeday', 'Когда-нибудь', L.somedayList(state.tasks), simpleBtns);
    renderGroup('gDone', 'Готово', L.doneList(state.tasks).slice(0, 30), doneBtns);
    renderStatus();
  }

  function renderStatus() {
    var s = el('status');
    if (!s || !state) return;
    var st = L.stats(state.tasks);
    var parts = [
      'Инбокс: ' + st.inbox,
      'следующих: ' + st.next,
      'синк: ' + (syncStatus || '—')
    ];
    if (lastAction) parts.push(lastAction);
    if (bootError) parts.push(bootError);
    s.textContent = parts.join(' · ');
  }

  function diagText() {
    var st = state ? L.stats(state.tasks) : {};
    return [
      'Внешний мозг ' + APP_VERSION,
      'Задач: инбокс ' + st.inbox + ', следующих ' + st.next + ', ожидание ' + st.waiting + ', когда-нибудь ' + st.someday + ', готово ' + st.done,
      'Лягушка: ' + (st.hasFrog ? 'есть' : 'нет'),
      'Синк: ' + (syncStatus || '—'),
      'Repo: ' + (state ? state.settings.repo : '?'),
      'Ключ: ' + (state && state.settings.token ? 'введён' : 'выключен (нет ключа)'),
      bootError ? bootError + ' ' + bootStack : 'Ошибок: нет'
    ].join('\n');
  }

  function wire() {
    on('quickAdd', 'click', function () {
      var inp = el('quickInput');
      if (!inp) return;
      var title = inp.value;
      var t = mutate(function () { return L.createTask(state.tasks, title); });
      if (t) { inp.value = ''; lastAction = 'в инбоксе: ' + t.title; }
      render();
    });
    on('quickInput', 'keydown', function (e) {
      if (e.key === 'Enter') {
        var b = el('quickAdd');
        if (b) b.click();
      }
    });
    var gear = el('gearMenu');
    on('gearBtn', 'click', function () {
      if (gear) gear.classList.toggle('open');
      ensureTokenInput();
    });
    on('diagBtn', 'click', function () {
      askText(diagText(), '', false).then(function () {});
    });
    on('syncNowBtn', 'click', function () { doSync(true); });
    on('installBtn', 'click', function () {
      if (window._deferredPrompt) {
        window._deferredPrompt.prompt();
        window._deferredPrompt = null;
      } else {
        askConfirm('Установка: в меню браузера выберите «Установить приложение» / «На экран Домой». Понятно?').then(function () {});
      }
    });
    on('shareBtn', 'click', function () {
      var txt = L.shareText(state.tasks);
      if (navigator.share) navigator.share({ text: txt }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { lastAction = 'скопировано'; renderStatus(); });
      else askText(txt, '', false).then(function () {});
    });
    on('clearDone', 'click', function () {
      askConfirm('Удалить все выполненные задачи?').then(function (ok) {
        if (!ok) return;
        mutate(function () {
          L.doneList(state.tasks).forEach(function (t) { L.removeTask(state.tasks, t.id); });
        });
      });
    });
    on('saveSettings', 'click', function () {
      var repo = el('repoInput');
      var tok = document.getElementById('tokenInput');
      mutate(function () {
        if (repo && repo.value) state.settings.repo = repo.value.trim();
        if (tok) state.settings.token = tok.value.trim();
      });
      var tw = el('tokenWrap');
      if (tw) tw.innerHTML = '';
      if (gear) gear.classList.remove('open');
      doSync(true);
    });
    /* Поле токена живёт в DOM только при открытых настройках: иначе Chrome
     * видит пару «текст + пароль» и предлагает сохранить токен как логин. */
    function ensureTokenInput() {
      var wrap = el('tokenWrap');
      if (!wrap || document.getElementById('tokenInput')) return;
      var inp = document.createElement('input');
      inp.id = 'tokenInput';
      inp.type = 'password';
      inp.placeholder = 'GitHub token';
      inp.autocomplete = 'off';
      if (state && state.settings.token) inp.value = state.settings.token;
      wrap.appendChild(inp);
    }
    var sl = el('syncLight');
    if (sl) sl.addEventListener('click', function () { doSync(true); });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window._deferredPrompt = e;
    });
    /* Возврат на вкладку: три события (visibilitychange + focus + pageshow),
     * иначе bfcache/focus без visibility оставляет старое. */
    var lastFg = 0;
    function onForeground() {
      var now = Date.now();
      if (now - lastFg < 15000) return;
      lastFg = now;
      pokeSwUpdate();
      checkUpdate();
      doSync();
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) onForeground();
    });
    window.addEventListener('focus', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('online', function () { doSync(true); });
  }

  function setupPolling() {
    setInterval(function () {
      if (!document.hidden && navigator.onLine && state && state.settings.token) doSync();
    }, 60000);
  }

  function boot() {
    wire();
    window.EBStore.load().then(function (s) {
      state = s;
      var repo = el('repoInput');
      if (repo && state.settings.repo) repo.value = state.settings.repo;
      render();
      setLight(state.settings.token ? 'gray' : 'gray', false);
      syncStatus = state.settings.token ? '' : 'выключен (нет ключа)';
      renderStatus();
      doSync();
      checkUpdate();
      setupPolling();
    }).catch(function (e) {
      bootError = 'ОШИБКА загрузки: ' + String(e && e.message || e);
      var s = el('status');
      if (s) s.textContent = bootError;
    });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (!window._ebReloaded) { window._ebReloaded = true; location.reload(); }
        });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
