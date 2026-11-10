'use strict';

(function () {
  var POLL_MS = 1500;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var pill = document.getElementById('pill');
  var route = document.getElementById('route');
  var stations = Array.prototype.slice.call(route.querySelectorAll('.station'));
  var firstRender = true;
  var failures = 0;

  // ---------------------------------------------------------------- format

  function fmtBytes(n) {
    if (n == null) return '–';
    var mb = n / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
  }

  function fmtDuration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  // ---------------------------------------------------------------- stations

  function setStation(el, state, detail) {
    el.setAttribute('data-state', state);
    if (detail) el.querySelector('p').textContent = detail;
  }

  function httpsCheck() {
    if (location.protocol === 'https:') {
      return { id: 'https', state: 'pass', detail: 'This page was delivered over an encrypted connection.' };
    }
    return {
      id: 'https',
      state: 'wait',
      detail: 'This page is on HTTP. A certificate is requested after deploy and can take a short while.'
    };
  }

  var animating = false;
  var latestChecks = [];

  function applyAll() {
    var byId = {};
    latestChecks.concat([httpsCheck()]).forEach(function (c) { byId[c.id] = c; });
    stations.forEach(function (el) {
      var c = byId[el.getAttribute('data-id')];
      if (c) setStation(el, c.state, c.detail);
    });
    route.style.setProperty('--p', lastPassFraction());
  }

  function renderStations(checks) {
    latestChecks = checks;

    // While the opening sequence plays, later polls only update the data it will settle on.
    if (animating) return;

    if (!firstRender || reduceMotion) {
      firstRender = false;
      applyAll();
      return;
    }

    // One orchestrated moment: the line advances and each station resolves in turn.
    firstRender = false;
    animating = true;
    var byId = {};
    checks.concat([httpsCheck()]).forEach(function (c) { byId[c.id] = c; });
    stations.forEach(function (el, i) {
      window.setTimeout(function () {
        var c = byId[el.getAttribute('data-id')];
        if (c) setStation(el, c.state, c.detail);
        route.style.setProperty('--p', i / (stations.length - 1));
        if (i === stations.length - 1) {
          animating = false;
          applyAll();
        }
      }, 300 + i * 320);
    });
  }

  function lastPassFraction() {
    var last = -1;
    stations.forEach(function (el, i) {
      if (el.getAttribute('data-state') === 'pass') last = i;
    });
    return last <= 0 ? 0 : last / (stations.length - 1);
  }

  // ---------------------------------------------------------------- charts

  function drawChart(lineId, areaId, values, ceiling) {
    var line = document.getElementById(lineId);
    var area = document.getElementById(areaId);
    if (!values.length) return;
    var w = 300;
    var h = 90;
    var pad = 4;
    var max = ceiling || Math.max.apply(null, values) * 1.25 || 1;
    var step = values.length > 1 ? w / (values.length - 1) : w;
    var pts = values.map(function (v, i) {
      var y = h - pad - (Math.min(v, max) / max) * (h - pad * 2);
      return [i * step, y];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + h + ' L0 ' + h + ' Z');
    return { max: max, h: h, pad: pad };
  }

  function renderTelemetry(data) {
    var hist = data.history || [];
    var mem = data.memory;
    var limit = mem.limit;

    var rssValues = hist.map(function (s) { return s.rss; });
    var memCeiling = limit ? Math.max(limit, Math.max.apply(null, rssValues)) * 1.02 : null;
    var geo = drawChart('mem-line', 'mem-area', rssValues, memCeiling);
    var capLine = document.getElementById('mem-cap');
    if (limit && geo) {
      var y = geo.h - geo.pad - (limit / geo.max) * (geo.h - geo.pad * 2);
      capLine.setAttribute('y1', y.toFixed(1));
      capLine.setAttribute('y2', y.toFixed(1));
      capLine.classList.add('on');
    } else {
      capLine.classList.remove('on');
    }

    document.getElementById('mem-value').textContent = limit
      ? fmtBytes(mem.rss) + ' of ' + fmtBytes(limit)
      : fmtBytes(mem.rss);
    document.getElementById('mem-note').textContent = limit
      ? 'Dashed line marks the container limit (' + mem.limitSource + ').'
      : 'No container memory limit is visible from inside this process.';

    var latest = hist[hist.length - 1] || { cpu: 0, lag: 0 };
    drawChart('cpu-line', 'cpu-area', hist.map(function (s) { return s.cpu; }), Math.max(10, Math.max.apply(null, hist.map(function (s) { return s.cpu; })) * 1.25));
    document.getElementById('cpu-value').textContent = latest.cpu.toFixed(1) + '%';
    document.getElementById('lag-note').textContent = 'Event loop delay (p99): ' + latest.lag.toFixed(1) + ' ms';
  }

  // ---------------------------------------------------------------- facts

  function fillList(id, rows) {
    var dl = document.getElementById(id);
    dl.textContent = '';
    rows.forEach(function (row) {
      var wrap = document.createElement('div');
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = row[0];
      dd.textContent = row[1];
      if (row[2]) dd.className = 'empty';
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });
  }

  function renderFacts(data) {
    var r = data.runtime;
    var rows = [
      ['Node.js', r.node],
      ['Platform', r.platform],
      ['Container', (r.container ? r.container + ' · ' : '') + r.hostname],
      ['Process', 'pid ' + r.pid + (r.uid != null ? ' · uid ' + r.uid : '')],
      ['Port', String(r.port)],
      ['NODE_ENV', r.nodeEnv],
      ['Started', fmtTime(data.startedAt)]
    ];
    if (data.build) {
      rows.push(['Built', fmtTime(Date.parse(data.build.builtAt)) + ' · ' + data.build.host]);
    } else {
      rows.push(['Built', 'No build record', true]);
    }
    fillList('runtime-list', rows);

    var proxyRows = Object.keys(data.proxy).map(function (k) { return [k, data.proxy[k]]; });
    if (!proxyRows.length) proxyRows.push(['Headers', 'None of the forwarding headers were present on this request.', true]);
    fillList('proxy-list', proxyRows);

    document.getElementById('foot-build').textContent =
      data.app.name + ' ' + data.app.version + (data.build ? ' · built with Node ' + data.build.node : '');
  }

  // ---------------------------------------------------------------- polling

  function setPill(state, text) {
    pill.setAttribute('data-state', state);
    pill.textContent = text;
  }

  function tick() {
    fetch('/api/stats', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        failures = 0;
        setPill('live', 'Live · up ' + fmtDuration(data.now - data.startedAt));
        renderStations(data.checks);
        renderTelemetry(data);
        renderFacts(data);
      })
      .catch(function () {
        failures += 1;
        setPill('lost', failures > 1 ? 'Connection lost · retrying' : 'Reconnecting…');
      })
      .then(function () {
        window.setTimeout(tick, POLL_MS);
      });
  }

  // ---------------------------------------------------------------- round trip

  var pingButton = document.getElementById('ping-button');
  var pingBars = document.getElementById('ping-bars');
  var pingResult = document.getElementById('ping-result');
  var PING_COUNT = 10;

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function runPing() {
    pingButton.disabled = true;
    pingResult.textContent = 'Running…';
    pingBars.textContent = '';
    var bars = [];
    for (var i = 0; i < PING_COUNT; i++) {
      var bar = document.createElement('div');
      bar.className = 'bar pending';
      pingBars.appendChild(bar);
      bars.push(bar);
    }
    var times = [];

    function next(n) {
      if (n === PING_COUNT) return finish();
      var t0 = performance.now();
      return fetch('/healthz?n=' + n + '&t=' + Date.now(), { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function () {
          var ms = performance.now() - t0;
          times.push(ms);
          bars[n].className = 'bar';
          var tallest = Math.max.apply(null, times);
          times.forEach(function (v, idx) {
            bars[idx].style.height = Math.max(4, (v / tallest) * 100) + '%';
          });
          return next(n + 1);
        });
    }

    function finish() {
      var min = Math.min.apply(null, times);
      var max = Math.max.apply(null, times);
      pingResult.textContent =
        'Median ' + median(times).toFixed(0) + ' ms · fastest ' + min.toFixed(0) + ' ms · slowest ' + max.toFixed(0) + ' ms';
      pingButton.disabled = false;
    }

    next(0).catch(function () {
      pingResult.textContent = 'The test stopped because a request failed. Check that the app is running, then run it again.';
      pingButton.disabled = false;
    });
  }

  pingButton.addEventListener('click', runPing);
  tick();
})();
