'use strict';

(() => {
  const POLL_MS = 1500;
  const HISTORY_MAX = 120;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ helpers

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function fmtBytes(n) {
    if (n == null) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' kB';
    const mb = n / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });
  const fmtMs = (ms) => (ms >= 100 ? Math.round(ms) : ms.toFixed(1)) + ' ms';

  function kv(rows) {
    const dl = el('dl');
    for (const [label, value, cls] of rows) {
      dl.append(el('div', null, el('dt', null, label), el('dd', { class: cls }, value)));
    }
    return dl;
  }

  function meter(fraction, warnAt) {
    const bar = el('span');
    const wrap = el('div', { class: 'meter', 'aria-hidden': 'true' }, bar);
    const f = Math.max(0, Math.min(1, fraction));
    bar.style.width = (f * 100).toFixed(1) + '%';
    if (warnAt && f >= warnAt) wrap.classList.add('warn');
    return wrap;
  }

  function badge(kind, text) {
    return el('span', { class: 'badge ' + kind }, text);
  }

  function table(headers, rows, numericCols) {
    const num = numericCols || [];
    const head = el('tr', null, ...headers.map((h, i) => el('th', { class: num.includes(i) ? 'num' : null }, h)));
    const body = rows.map((r) =>
      el('tr', null, ...r.map((cell, i) => el('td', { class: num.includes(i) ? 'num' : null }, cell))),
    );
    return el('div', { class: 'table-scroll' }, el('table', null, el('thead', null, head), el('tbody', null, ...body)));
  }

  // ------------------------------------------------------------ api + passcode

  function passcode() {
    try {
      return sessionStorage.getItem('liftoff-passcode') || '';
    } catch {
      return '';
    }
  }

  function savePasscode(value) {
    try {
      sessionStorage.setItem('liftoff-passcode', value);
    } catch {
      /* storage can be blocked, the passcode then lasts until reload */
    }
  }

  async function api(path, method) {
    const headers = { 'x-liftoff-ui': '1' };
    const code = passcode();
    if (code) headers['x-liftoff-passcode'] = code;
    const res = await fetch(path, { method: method || 'GET', headers, cache: 'no-store' });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function describeError(err) {
    if (err && err.status === 429) return 'Too many requests. Wait a minute and try again.';
    if (err && err.status === 401) return 'The passcode was rejected.';
    return 'The request failed. Check that the app is running, then try again.';
  }

  // ------------------------------------------------------------ gate

  let started = false;
  let locked = false;

  function showGate(message) {
    locked = true;
    $('content').hidden = true;
    $('gate').hidden = false;
    $('gate-msg').textContent = message || '';
    $('pill').setAttribute('data-state', 'loading');
    $('pill').textContent = 'Locked';
  }

  function hideGate() {
    locked = false;
    $('gate').hidden = true;
    $('content').hidden = false;
  }

  async function unlock() {
    const value = $('gate-input').value;
    savePasscode(value);
    try {
      await api('/api/stats');
      $('gate-input').value = '';
      hideGate();
      start();
    } catch (err) {
      $('gate-msg').textContent = err.status === 401 ? 'That passcode didn’t match.' : describeError(err);
    }
  }

  // ------------------------------------------------------------ route

  const route = $('route');
  const stations = Array.from(route.querySelectorAll('.station'));
  let firstRender = true;
  let animating = false;
  let latestChecks = [];

  function httpsCheck() {
    if (location.protocol === 'https:') {
      return { id: 'https', state: 'pass', detail: 'This page was delivered over an encrypted connection.' };
    }
    return {
      id: 'https',
      state: 'wait',
      detail: 'This page is on HTTP. A certificate is requested after deploy and can take a short while.',
    };
  }

  function setStation(node, state, detail) {
    node.setAttribute('data-state', state);
    if (detail) node.querySelector('p').textContent = detail;
  }

  function lastPassFraction() {
    let last = -1;
    stations.forEach((node, i) => {
      if (node.getAttribute('data-state') === 'pass') last = i;
    });
    return last <= 0 ? 0 : last / (stations.length - 1);
  }

  function applyAll() {
    const byId = {};
    latestChecks.concat([httpsCheck()]).forEach((c) => (byId[c.id] = c));
    stations.forEach((node) => {
      const c = byId[node.getAttribute('data-id')];
      if (c) setStation(node, c.state, c.detail);
    });
    route.style.setProperty('--p', lastPassFraction());
  }

  function renderStations(checks) {
    latestChecks = checks;
    if (animating) return; // later polls only update the data the opening sequence settles on

    if (!firstRender || reduceMotion) {
      firstRender = false;
      applyAll();
      return;
    }

    // One orchestrated moment: the line advances and each station resolves in turn.
    firstRender = false;
    animating = true;
    const byId = {};
    checks.concat([httpsCheck()]).forEach((c) => (byId[c.id] = c));
    stations.forEach((node, i) => {
      setTimeout(() => {
        const c = byId[node.getAttribute('data-id')];
        if (c) setStation(node, c.state, c.detail);
        route.style.setProperty('--p', i / (stations.length - 1));
        if (i === stations.length - 1) {
          animating = false;
          applyAll();
        }
      }, 300 + i * 320);
    });
  }

  // ------------------------------------------------------------ telemetry

  let history = [];

  function drawChart(lineId, areaId, values, ceiling) {
    if (!values.length) return null;
    const w = 300;
    const h = 90;
    const pad = 4;
    const max = ceiling || Math.max(...values) * 1.25 || 1;
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const pts = values.map((v, i) => [i * step, h - pad - (Math.min(v, max) / max) * (h - pad * 2)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    $(lineId).setAttribute('d', d);
    $(areaId).setAttribute('d', d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + h + ' L0 ' + h + ' Z');
    return { max, h, pad };
  }

  function renderTelemetry(data) {
    const mem = data.memory;
    const limit = mem.limit;
    const rss = history.map((s) => s.rss);
    const ceiling = limit ? Math.max(limit, ...rss) * 1.02 : null;
    const geo = drawChart('mem-line', 'mem-area', rss, ceiling);

    const cap = $('mem-cap');
    if (limit && geo) {
      const y = (geo.h - geo.pad - (limit / geo.max) * (geo.h - geo.pad * 2)).toFixed(1);
      cap.setAttribute('y1', y);
      cap.setAttribute('y2', y);
      cap.classList.add('on');
    } else {
      cap.classList.remove('on');
    }

    $('mem-value').textContent = limit ? fmtBytes(mem.rss) + ' of ' + fmtBytes(limit) : fmtBytes(mem.rss);
    $('mem-note').textContent = limit
      ? 'Dashed line marks the container limit (' + mem.limitSource + ').'
      : 'No container memory limit is visible from inside this process.';

    const cpu = history.map((s) => s.cpu);
    const latest = history[history.length - 1] || { cpu: 0, lag: 0 };
    drawChart('cpu-line', 'cpu-area', cpu, Math.max(10, Math.max(0, ...cpu) * 1.25));
    $('cpu-value').textContent = latest.cpu.toFixed(1) + '%';
    $('lag-note').textContent = 'Event loop delay (p99): ' + latest.lag.toFixed(1) + ' ms';
  }

  // ------------------------------------------------------------ facts

  function fillList(id, rows) {
    const dl = $(id);
    dl.replaceChildren(...kv(rows).children);
  }

  function renderFacts(data) {
    const r = data.runtime;
    const fw = r.framework;
    const rows = [
      ['Node.js', r.node],
      ['Framework', fw ? fw.label + ' ' + fw.version : 'None detected'],
      ['Platform', r.platform],
      ['Container', (r.container ? r.container + ' · ' : '') + r.hostname],
      ['Process', 'pid ' + r.pid],
      ['Port', String(r.port)],
      ['NODE_ENV', r.nodeEnv],
      ['Started', fmtDateTime(data.startedAt)],
      [
        'Source',
        data.git ? data.git.commit.slice(0, 7) + (data.git.branch ? ' on ' + data.git.branch : '') : 'Uploaded files',
      ],
    ];
    rows.push(data.build ? ['Built', fmtDateTime(Date.parse(data.build.builtAt)) + ' · ' + data.build.host] : ['Built', 'No build record', 'empty']);
    const names = data.env.names;
    const shown = names.slice(0, 12).join(', ') + (names.length > 12 ? ' and ' + (names.length - 12) + ' more' : '');
    rows.push(['Env variables', names.length ? shown + ' (values hidden)' : 'None beyond the defaults', names.length ? null : 'empty']);
    fillList('runtime-list', rows);

    const proxyRows = Object.keys(data.proxy).map((k) => [k, data.proxy[k]]);
    if (!proxyRows.length) proxyRows.push(['Headers', 'None of the forwarding headers were present on this request.', 'empty']);
    fillList('proxy-list', proxyRows);

    $('foot-build').textContent =
      data.app.name + ' ' + data.app.version + (data.build ? ' · built with Node ' + data.build.node : '');

    const banner = $('banner');
    if (data.demo.banner) {
      banner.textContent = data.demo.banner;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    configureCrash(data.demo.crashEnabled);
  }

  // ------------------------------------------------------------ inspector panes

  function renderIsolation(r) {
    const root = el('div');

    const ns = r.userNamespace;
    const nsText = !ns
      ? 'Not visible from here'
      : ns.identity
        ? 'Not remapped. The container sees host user ids directly.'
        : 'User ' + ns.uid + ' in the container is user ' + (ns.hostUid ?? '?') + ' on the host.';
    const seccomp = { filter: 'Syscall filter active', strict: 'Strict mode', off: 'Off' }[r.seccomp] || 'Not visible from here';
    const caps = r.capabilities;

    root.append(
      el('div', { class: 'group' },
        el('h3', null, 'Container boundary'),
        kv([
          ['Container', r.container ? r.container + ' · ' + r.hostname : 'Not detected', r.container ? null : 'empty'],
          ['User namespace', nsText, 'plain'],
          ['Processes visible', r.processesVisible != null ? r.processesVisible + ' (this app is pid ' + r.pid + ')' : 'Not visible from here'],
          ['Seccomp', seccomp, 'plain'],
          ['No new privileges', r.noNewPrivs == null ? 'Not visible from here' : r.noNewPrivs ? 'Yes' : 'No'],
          ['Capabilities', caps ? caps.count + ' of ' + caps.total + (caps.names.length ? ' · ' + caps.names.join(', ') : '') : 'Not visible from here'],
        ]),
      ),
    );

    const cg = r.cgroup;
    const limits = el('div', { class: 'group' }, el('h3', null, 'Resource limits'));
    if (!cg) {
      limits.append(el('p', { class: 'panel-note' }, 'The cgroup files can’t be read from inside this container.'));
    } else {
      const memMax = cg.memory.max;
      const memRow = el('dd', null,
        fmtBytes(cg.memory.current) + (memMax ? ' of ' + fmtBytes(memMax) : ' · no limit set') +
          (cg.memory.peak ? ' · peak ' + fmtBytes(cg.memory.peak) : ''),
      );
      if (memMax && cg.memory.current != null) memRow.append(meter(cg.memory.current / memMax, 0.85));

      const pidsRow = el('dd', null, (cg.pids.current ?? '–') + (cg.pids.max ? ' of ' + cg.pids.max : ' · no limit set'));
      if (cg.pids.max && cg.pids.current != null) pidsRow.append(meter(cg.pids.current / cg.pids.max, 0.85));

      const dl = el('dl');
      const row = (label, node) => dl.append(el('div', null, el('dt', null, label), node));
      row('Memory', memRow);
      row('CPU', el('dd', null, cg.cpu.cpus ? cg.cpu.cpus + ' CPUs quota' : 'No CPU quota set', cg.cpu.throttledPeriods != null ? ' · throttled ' + cg.cpu.throttledPeriods + ' times' : ''));
      row('Processes', pidsRow);
      row('Out-of-memory kills', el('dd', null, cg.oomKills == null ? 'Not reported' : String(cg.oomKills)));
      row('Open files', el('dd', null, r.openFiles == null ? '–' : String(r.openFiles)));
      row('Threads', el('dd', null, r.threads == null ? '–' : String(r.threads)));
      limits.append(el('p', { class: 'panel-note' }, 'Read from cgroup v' + cg.version + ' inside the container.'), dl);
    }
    root.append(limits);

    const fs = r.filesystem;
    root.append(
      el('div', { class: 'group' },
        el('h3', null, 'Filesystem'),
        kv([
          ['App folder', fs.appDirWritable ? 'Writable' : 'Read-only', 'plain'],
          ['Temp folder', fs.tmpWritable ? 'Writable' : 'Read-only', 'plain'],
          ['Disk free', fs.disk ? fmtBytes(fs.disk.free) + ' of ' + fmtBytes(fs.disk.total) : 'Not visible from here'],
        ]),
        el('p', { class: 'panel-note' }, 'Account quotas aren’t visible from inside the container, so this shows the disk the app folder sits on.'),
      ),
    );
    return root;
  }

  function renderNetwork(data) {
    const rows = data.results.map((r) => [
      r.label,
      r.ok ? badge('pass', 'Reachable') : badge('bad', 'Failed'),
      fmtMs(r.ms),
      el('code', null, r.detail),
    ]);
    return el('div', null,
      table(['Target', 'Result', 'Time', 'Detail'], rows, [2]),
      el('p', { class: 'panel-note' }, 'Docker Hub answering with 401 is expected. Any HTTP answer shows the route works.'),
    );
  }

  const DB_HINTS = {
    ECONNREFUSED: 'The database host refused the connection. Check the host and port the platform provided.',
    ETIMEDOUT: 'The connection timed out. The database may not be reachable from inside the container.',
    ENOTFOUND: 'The database host name didn’t resolve from inside the container.',
    ER_ACCESS_DENIED_ERROR: 'The database rejected the user name or password.',
    ER_BAD_DB_ERROR: 'The database name doesn’t exist on that server.',
  };

  function renderData(data) {
    const seen = data.envNames.length ? data.envNames.join(', ') : 'none';
    if (!data.linked) {
      return el('div', null,
        el('p', null, badge('wait', 'No database linked')),
        el('p', { class: 'panel-note' }, 'Link a MySQL database to this app in cPanel, restart the app, then check again.'),
        kv([['Variables seen', seen, data.envNames.length ? null : 'empty']]),
      );
    }
    if (!data.connected) {
      return el('div', null,
        el('p', null, badge('bad', 'Could not connect')),
        el('p', { class: 'panel-note' }, DB_HINTS[data.error] || 'The connection failed. The error code below can help narrow it down.'),
        kv([['Error code', data.error], ['Variables seen', seen]]),
      );
    }
    return el('div', null,
      el('p', null, badge('pass', 'Connected')),
      kv([
        ['Server', data.server],
        ['Query time', fmtMs(data.medianMs) + ' median over 5 queries'],
        ['Variables seen', seen],
      ]),
    );
  }

  function renderDeps(d) {
    const root = el('div');
    const inv = d.inventory;

    if (!inv) {
      root.append(el('p', { class: 'panel-note' }, 'No build record yet, so the package inventory isn’t available.'));
    } else {
      const biggest = inv.largest[0].bytes || 1;
      const list = el('div', { class: 'bar-list' });
      for (const p of inv.largest) {
        list.append(el('div', { class: 'bar-row' }, el('span', { class: 'name' }, p.name + ' ' + p.version), meter(p.bytes / biggest), el('span', { class: 'size' }, fmtBytes(p.bytes))));
      }
      root.append(
        el('div', { class: 'group' },
          el('h3', null, inv.count + ' packages · ' + fmtBytes(inv.bytes) + ' installed'),
          el('p', { class: 'panel-note' }, 'Counted in the build container after npm install. Largest packages:'),
          list,
          el('p', { class: 'panel-note' }, 'Licenses: ' + inv.licenses.map((l) => l.name + ' ' + l.count).join(' · ')),
        ),
      );
    }

    root.append(
      el('div', { class: 'group' },
        el('h3', null, 'Direct dependencies'),
        table(['Package', 'Requested', 'Installed'], d.direct.map((p) => [el('code', null, p.name), p.wanted, p.installed || 'missing'])),
      ),
    );

    if (d.assets && d.assets.length) {
      const raw = d.assets.reduce((s, a) => s + a.raw, 0);
      const br = d.assets.reduce((s, a) => s + a.br, 0);
      const rows = d.assets.map((a) => [el('code', null, a.file), fmtBytes(a.raw), fmtBytes(a.br), Math.round((1 - a.br / a.raw) * 100) + '%']);
      rows.push([el('strong', null, 'Total'), fmtBytes(raw), fmtBytes(br), Math.round((1 - br / raw) * 100) + '%']);
      root.append(
        el('div', { class: 'group' },
          el('h3', null, 'Build output'),
          el('p', { class: 'panel-note' }, 'The build step precompresses each static file. The server sends the Brotli copy when the browser accepts it' + (d.buildMs != null ? ' (build script: ' + d.buildMs + ' ms).' : '.')),
          table(['File', 'Original', 'Brotli', 'Saved'], rows, [1, 2, 3]),
        ),
      );
    }
    return root;
  }

  function renderRequests(data) {
    const note = el('p', { class: 'panel-note' }, 'Requests marked direct came without forwarding headers, which usually means the server itself, such as a health probe. This page’s own polling is left out.');
    if (!data.entries.length) {
      return el('div', null, el('p', { class: 'panel-note' }, 'Nothing yet. Open the app from another browser, or press the buttons under Demo tools.'), note);
    }
    const rows = data.entries.map((e) => [
      fmtClock(e.t),
      e.method,
      el('code', null, e.path),
      badge(e.status < 400 ? 'pass' : e.status < 500 ? 'wait' : 'bad', String(e.status)),
      fmtMs(e.ms),
      badge(e.via === 'proxy' ? '' : 'wait', e.via),
    ]);
    return el('div', null, table(['Time', 'Method', 'Path', 'Status', 'Took', 'Source'], rows, [4]), note);
  }

  // ------------------------------------------------------------ tabs

  const TAB_IDS = ['isolation', 'network', 'data', 'deps', 'requests'];
  let activeTab = 'isolation';
  let paneTimer = null;

  const loaders = {
    isolation: () => api('/api/isolation').then((d) => $('pane-isolation').replaceChildren(renderIsolation(d))),
    deps: () => api('/api/dependencies').then((d) => $('pane-deps').replaceChildren(renderDeps(d))),
    requests: () => api('/api/requests').then((d) => $('pane-requests').replaceChildren(renderRequests(d))),
  };

  function refreshActivePane() {
    if (locked || !loaders[activeTab]) return;
    loaders[activeTab]().catch((err) => {
      if (err.status === 401) showGate('The passcode was rejected.');
    });
  }

  function selectTab(id, focus) {
    activeTab = id;
    for (const t of TAB_IDS) {
      const tab = $('tab-' + t);
      const on = t === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
      if (on && focus) tab.focus();
    }
    clearInterval(paneTimer);
    refreshActivePane();
    // Isolation and requests change while you watch, so they refresh. The others run on demand.
    if (id === 'isolation' || id === 'requests') paneTimer = setInterval(refreshActivePane, id === 'requests' ? 3000 : 5000);
  }

  function wireTabs() {
    for (const t of TAB_IDS) {
      $('tab-' + t).addEventListener('click', () => selectTab(t));
      $('tab-' + t).addEventListener('keydown', (e) => {
        const i = TAB_IDS.indexOf(t);
        if (e.key === 'ArrowRight') { e.preventDefault(); selectTab(TAB_IDS[(i + 1) % TAB_IDS.length], true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); selectTab(TAB_IDS[(i + TAB_IDS.length - 1) % TAB_IDS.length], true); }
      });
    }
    runOnDemand('network-button', 'Run checks', 'Running…', () => api('/api/network', 'POST'), renderNetwork, 'network-result');
    runOnDemand('data-button', 'Check database', 'Checking…', () => api('/api/data'), renderData, 'data-result');
  }

  function runOnDemand(buttonId, idleText, busyText, fetcher, render, targetId) {
    const button = $(buttonId);
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.classList.add('busy');
      button.textContent = busyText;
      try {
        $(targetId).replaceChildren(render(await fetcher()));
      } catch (err) {
        $(targetId).replaceChildren(el('p', { class: 'panel-note' }, describeError(err)));
      } finally {
        button.disabled = false;
        button.classList.remove('busy');
        button.textContent = idleText;
      }
    });
  }

  // ------------------------------------------------------------ demo tools

  // Round trip
  const pingButton = $('ping-button');
  const pingBars = $('ping-bars');
  const pingResult = $('ping-result');
  const PING_COUNT = 10;

  const median = (values) => {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  pingButton.addEventListener('click', async () => {
    pingButton.disabled = true;
    pingResult.textContent = 'Running…';
    pingBars.replaceChildren();
    const bars = Array.from({ length: PING_COUNT }, () => el('div', { class: 'bar pending' }));
    pingBars.append(...bars);
    const times = [];
    try {
      for (let n = 0; n < PING_COUNT; n++) {
        const t0 = performance.now();
        await api('/healthz?n=' + n + '&t=' + Date.now());
        times.push(performance.now() - t0);
        bars[n].className = 'bar';
        const tallest = Math.max(...times);
        times.forEach((v, i) => (bars[i].style.height = Math.max(4, (v / tallest) * 100) + '%'));
      }
      pingResult.textContent = 'Median ' + Math.round(median(times)) + ' ms · fastest ' + Math.round(Math.min(...times)) + ' ms · slowest ' + Math.round(Math.max(...times)) + ' ms';
    } catch (err) {
      pingResult.textContent = 'The test stopped because a request failed. Check that the app is running, then run it again.';
    } finally {
      pingButton.disabled = false;
    }
  });

  // Log marker
  $('marker-button').addEventListener('click', async () => {
    const button = $('marker-button');
    button.disabled = true;
    try {
      const { id } = await api('/api/marker', 'POST');
      $('marker-result').textContent = 'Written. Look for “LIFTOFF MARKER ' + id + '” in the App Logs tab.';
    } catch (err) {
      $('marker-result').textContent = describeError(err);
    } finally {
      button.disabled = false;
    }
  });

  // Stop and recover
  const crashButton = $('crash-button');
  let crashEnabled = false;
  let armedTimer = null;
  let recovery = null;
  let recoveryTimer = null;

  function configureCrash(enabled) {
    if (enabled === crashEnabled && $('crash-note').dataset.set) return;
    crashEnabled = enabled;
    $('crash-note').dataset.set = '1';
    $('crash-note').textContent = enabled
      ? 'Stops the app process on purpose and times how long the platform takes to bring it back.'
      : 'Turned off. Set DEMO_CRASH=on in App Env and restart the app to enable it.';
    if (!recovery) crashButton.disabled = !enabled;
  }

  function disarm() {
    clearTimeout(armedTimer);
    crashButton.textContent = 'Stop the app';
  }

  function updateRecoveryText() {
    if (!recovery) return;
    const secs = Math.round((Date.now() - recovery.since) / 1000);
    $('crash-result').textContent =
      secs > 360
        ? 'Not back after ' + fmtDuration(secs * 1000) + '. Press Start in cPanel to bring it back.'
        : 'Stopped. Waiting for the platform to bring it back… ' + fmtDuration(secs * 1000);
  }

  crashButton.addEventListener('click', async () => {
    if (crashButton.textContent === 'Stop the app') {
      crashButton.textContent = 'Confirm: stop the app';
      $('crash-result').textContent = 'This ends the running process. Press again within six seconds to confirm.';
      armedTimer = setTimeout(() => {
        disarm();
        $('crash-result').textContent = '';
      }, 6000);
      return;
    }
    disarm();
    crashButton.disabled = true;
    try {
      const sent = await api('/api/demo/crash', 'POST');
      recovery = { since: Date.now(), prevStarted: sent.startedAt, prevPid: sent.pid };
      updateRecoveryText();
      recoveryTimer = setInterval(updateRecoveryText, 1000);
    } catch (err) {
      $('crash-result').textContent = err.status === 403 ? 'This is turned off. Set DEMO_CRASH=on in App Env and restart.' : describeError(err);
      crashButton.disabled = !crashEnabled;
    }
  });

  function checkRecovery(data) {
    if (!recovery || data.startedAt === recovery.prevStarted) return;
    const secs = Math.round((Date.now() - recovery.since) / 1000);
    $('crash-result').textContent = 'Recovered in ' + fmtDuration(secs * 1000) + '. New process pid ' + data.runtime.pid + ' (was ' + recovery.prevPid + ').';
    clearInterval(recoveryTimer);
    recovery = null;
    crashButton.disabled = !crashEnabled;
  }

  // ------------------------------------------------------------ polling

  const pill = $('pill');
  let failures = 0;
  let lastSample = 0;

  function setPill(state, text) {
    pill.setAttribute('data-state', state);
    pill.textContent = text;
  }

  async function tick() {
    if (locked) return;
    try {
      const data = await api('/api/stats?since=' + lastSample);
      failures = 0;
      for (const s of data.history) history.push(s);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      if (history.length) lastSample = history[history.length - 1].t;

      setPill('live', 'Live · up ' + fmtDuration(data.now - data.startedAt));
      renderStations(data.checks);
      renderTelemetry(data);
      renderFacts(data);
      checkRecovery(data);
    } catch (err) {
      if (err.status === 401) {
        showGate(passcode() ? 'That passcode didn’t match.' : '');
        return;
      }
      failures += 1;
      // The sample cursor is kept: after a restart, new samples are always newer than the last one seen.
      if (recovery) setPill('lost', 'Process stopped · waiting');
      else setPill('lost', failures > 1 ? 'Connection lost · retrying' : 'Reconnecting…');
    }
    setTimeout(tick, POLL_MS);
  }

  function start() {
    if (started) {
      tick();
      return;
    }
    started = true;
    wireTabs();
    selectTab('isolation');
    tick();
  }

  $('gate-button').addEventListener('click', unlock);
  $('gate-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlock();
  });

  (async () => {
    try {
      const gate = await api('/api/gate');
      if (gate.required && !passcode()) {
        showGate('');
        return;
      }
    } catch {
      /* if the gate check fails, try the normal path and let polling report the problem */
    }
    start();
  })();
})();
