// ── DOM ──
const dot = document.getElementById('dot');
const dotWrap = document.getElementById('dotWrap');
const statusText = document.getElementById('statusText');
const valHeight = document.getElementById('valHeight');
const valTx = document.getElementById('valTx');
const valTime = document.getElementById('valTime');
const valTimeAgo = document.getElementById('valTimeAgo');
const valPrice = document.getElementById('valPrice');
const valPriceChange = document.getElementById('valPriceChange');
const rocketLane = document.getElementById('rocketLane');

// stagger hero stats in
['statHeight', 'statTx', 'statTime', 'statPrice'].forEach((id, i) =>
  setTimeout(() => document.getElementById(id).classList.add('visible'), 80 + i * 110)
);

let lastBlockTs = null;

// ── SSE ──
const es = new EventSource('/stream');
es.onopen = () => setStatus('live', 'LIVE');
es.onerror = () => setStatus('error', 'DISCONNECTED');
es.onmessage = (e) => {
  const block = JSON.parse(e.data);
  updateHero(block);
  if (block.txCount) launchRockets(block.txCount);
};

// ── STATUS ──
function setStatus(state, label) {
  dot.className = 'dot ' + state;
  statusText.textContent = label;
  if (state === 'live') {
    const ring = document.createElement('div');
    ring.className = 'ring';
    dotWrap.appendChild(ring);
    setTimeout(() => ring.remove(), 2000);
  }
}

// ── HERO ──
function updateHero(block) {
  lastBlockTs = new Date(block.timestamp);
  flashValue(valHeight, fmt(block.height));
  flashValue(valTx, block.txCount != null ? fmt(block.txCount) : '—');
  valTime.textContent = lastBlockTs.toLocaleTimeString('en-US', { hour12: false });
  valTimeAgo.textContent = timeAgo(lastBlockTs);
}

function flashValue(el, val) {
  el.textContent = val;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 400);
}

// ── ROCKETS ──
const MAX_ROCKETS = 100;
const STAGGER_MS = 160;

function launchRockets(txCount) {
  const count = Math.min(Math.max(txCount, 1), MAX_ROCKETS);
  const laneH = rocketLane.clientHeight;
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const el = document.createElement('span');
      el.className = 'rocket';
      el.textContent = '🚀';
      el.style.top = `${5 + Math.random() * (laneH - 28)}px`;
      el.style.animationDuration = `${(6500 + Math.random() * 2000).toFixed(0)}ms`;
      rocketLane.appendChild(el);
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, i * STAGGER_MS);
  }
}

// ── PRICE ──
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nexacoin&vs_currencies=usd&include_24hr_change=true';
const PRICE_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 min

async function fetchPrice() {
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
      valPriceChange.style.color = change >= 0 ? 'var(--accent)' : 'var(--accent2)';
    }
  } catch (e) {
    console.warn('Price fetch failed:', e.message);
  }

}

fetchPrice();
setInterval(fetchPrice, PRICE_REFRESH_MS);

// ── UTILS ──
function fmt(n) { return Number(n).toLocaleString(); }

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

setInterval(() => {
  if (lastBlockTs) valTimeAgo.textContent = timeAgo(lastBlockTs);
}, 15_000);