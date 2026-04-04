(() => {
  const STREAM_URL = 'https://nexafeed.nota.deno.net/stream';
  const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nexacoin&vs_currencies=usd&include_24hr_change=true';
  const PRICE_TTL = 5 * 60 * 1000;
  const MAX_ROCKETS = 100;
  const STAGGER_MS = 160;

  const CSS = `
:host {
display: block;
width: 100%;
font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace;
font-size: 13px;
line-height: 1.5;
color: #e0e0e0;
background: #000;
border: 1px solid #2a2a2a;
overflow: hidden;
box-sizing: border-box;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

/* ── HEADER ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #2a2a2a;
}

.logo {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #fff;
}
.logo span { color: #00e5ff; }

.status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #888;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #555;
  flex-shrink: 0;
  transition: background 0.3s;
}
.dot.live  { background: #00e5ff; box-shadow: 0 0 5px #00e5ff; }
.dot.error { background: #ff6b00; box-shadow: 0 0 5px #ff6b00; }

/* ── ROCKET LANE ── */
.rocket-lane {
  position: relative;
  height: 46px;
  overflow: hidden;
  border-bottom: 1px solid #2a2a2a;
  background: #000;
}

.rocket {
  position: absolute;
  left: -32px;
  font-size: 17px;
  line-height: 1;
  user-select: none;
  animation: fly linear forwards;
  will-change: transform;
}
@keyframes fly {
  from { transform: translateX(0); }
  to   { transform: translateX(calc(100% + 200px + 64px)); }
}

/* ── STATS ── */
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: #2a2a2a;
}

.stat {
  background: #000;
  padding: 10px 14px;
}

.stat-label {
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #666;
  margin-bottom: 3px;
}

.stat-value {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  letter-spacing: -0.02em;
  line-height: 1.1;
  transition: color 0.15s;
}
.stat-value.flash { color: #00e5ff; }
.stat-value.small { font-size: 14px; letter-spacing: 0; }

.stat-sub {
  font-size: 10px;
  color: #666;
  margin-top: 2px;
}

/* ── FOOTER ── */
.footer {
  padding: 6px 14px;
  border-top: 1px solid #2a2a2a;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  color: #444;
}

.footer a {
  color: #555;
  text-decoration: none;
  letter-spacing: 0.04em;
}
.footer a:hover { color: #00e5ff; }
'

`;

  const HTML = `
<div class="header">
<div class="logo">NEXA<span> BLOCK </span>FEED</div>
<div class="status">
<div class="dot" id="dot"></div>
<span id="statusText">CONNECTING</span>
</div>
</div>

'
<div class="rocket-lane" id="rocketLane"></div>

<div class="stats">
  <div class="stat">
    <div class="stat-label">Latest Block</div>
    <div class="stat-value" id="valHeight">—</div>
    <div class="stat-sub">height</div>
  </div>
  <div class="stat">
    <div class="stat-label">Transactions</div>
    <div class="stat-value" id="valTx">—</div>
    <div class="stat-sub">confirmed</div>
  </div>
  <div class="stat">
    <div class="stat-label">Block Time</div>
    <div class="stat-value" id="valTime">—</div>
    <div class="stat-sub" id="valTimeAgo"></div>
  </div>
  <div class="stat">
    <div class="stat-label">NEXA / USD</div>
    <div class="stat-value small" id="valPrice">—</div>
    <div class="stat-sub" id="valPriceChange"></div>
  </div>
</div>

<div class="footer">
  <a href="https://nexafeed.nota.deno.net" target="_blank" rel="noopener">nexa.org</a>
</div>
'

`;

  class NexaWidget extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: 'open' });
      this._es = null;
      this._lastBlockTs = null;
      this._timeAgoTimer = null;
    }

    connectedCallback() {
      // inject styles + markup into shadow DOM
      const style = document.createElement('style');
      style.textContent = CSS;
      const wrap = document.createElement('div');
      wrap.innerHTML = HTML;
      this._shadow.appendChild(style);
      this._shadow.appendChild(wrap);

      this._bindRefs();
      this._connectSSE();
      this._fetchPrice();
      this._timeAgoTimer = setInterval(() => this._refreshTimeAgo(), 15_000);
    }

    disconnectedCallback() {
      if (this._es) { this._es.close(); this._es = null; }
      if (this._timeAgoTimer) { clearInterval(this._timeAgoTimer); }
    }

    _bindRefs() {
      const s = this._shadow;
      this._dot = s.getElementById('dot');
      this._statusText = s.getElementById('statusText');
      this._valHeight = s.getElementById('valHeight');
      this._valTx = s.getElementById('valTx');
      this._valTime = s.getElementById('valTime');
      this._valTimeAgo = s.getElementById('valTimeAgo');
      this._valPrice = s.getElementById('valPrice');
      this._valPriceChange = s.getElementById('valPriceChange');
      this._rocketLane = s.getElementById('rocketLane');
    }

    _connectSSE() {
      // allow overriding stream URL via attribute
      const url = this.getAttribute('stream') || STREAM_URL;
      this._es = new EventSource(url);

      this._es.onopen = () => {
        this._dot.className = 'dot live';
        this._statusText.textContent = 'LIVE';
      };

      this._es.onerror = () => {
        this._dot.className = 'dot error';
        this._statusText.textContent = 'RECONNECTING';
      };

      this._es.onmessage = (e) => {
        const block = JSON.parse(e.data);
        const txCount = block.txCount ?? block.txcount ?? 0;
        this._updateHero({ ...block, txCount });
        if (txCount > 0) this._launchRockets(txCount);
      };
    }

    _updateHero(block) {
      this._lastBlockTs = new Date(block.timestamp);
      this._flash(this._valHeight, this._fmt(block.height));
      this._flash(this._valTx, block.txCount != null ? this._fmt(block.txCount) : '—');
      this._valTime.textContent = this._lastBlockTs.toLocaleTimeString();
      this._valTimeAgo.textContent = this._timeAgo(this._lastBlockTs);
    }

    _flash(el, val) {
      el.textContent = val;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 400);
    }

    _launchRockets(txCount) {
      const count = Math.min(Math.max(txCount, 1), MAX_ROCKETS);
      const laneH = this._rocketLane.clientHeight;
      const laneW = this._rocketLane.clientWidth;

      for (let i = 0; i < count; i++) {
        setTimeout(() => {
          const el = document.createElement('span');
          el.className = 'rocket';
          el.textContent = '🚀';
          el.style.top = `${5 + Math.random() * (laneH - 24)}px`;
          el.style.animationDuration = `${(6500 + Math.random() * 2000).toFixed(0)}ms`;
          // scale travel distance to actual lane width
          el.style.setProperty('--lane-w', `${laneW}px`);
          this._rocketLane.appendChild(el);
          el.addEventListener('animationend', () => el.remove(), { once: true });
        }, i * STAGGER_MS);
      }
    }

    async _fetchPrice() {
      try {
        const res = await fetch(PRICE_URL);
        const data = await res.json();
        const usd = data?.nexacoin?.usd;
        const change = data?.nexacoin?.usd_24h_change;
        if (usd == null) return;

        valPrice.textContent = usd < 0.001
          ? `$${usd.toFixed(10)}`
          : `$${usd.toFixed(6)}`;

        if (change != null) {
          const sign = change >= 0 ? '+' : '';
          valPriceChange.textContent = `${sign}${change.toFixed(2)}% 24h`;
          valPriceChange.style.color = change >= 0 ? '#00e5ff' : '#ff6b00';
        }
      } catch (e) {
        console.warn('[nexa-widget] price fetch failed:', e.message);
      }
      setTimeout(() => fetchPrice(), PRICE_TTL);
    }

    _refreshTimeAgo() {
      if (this._lastBlockTs) {
        this._valTimeAgo.textContent = this._timeAgo(this._lastBlockTs);
      }
    }

    _fmt(n) { return Number(n).toLocaleString(); }

    _timeAgo(date) {
      const s = Math.floor((Date.now() - date) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      return `${Math.floor(s / 3600)}h ago`;
    }

  }

  customElements.define('nexa-widget', NexaWidget);
})();