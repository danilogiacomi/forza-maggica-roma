/* =========================================================
   FORZA MAGGICA ROMA — app
   Tutto gira nel browser dell'utente: nessun server.
   - Notizie: feed RSS letti tramite rss2json (con proxy di riserva)
   - Partite e classifiche: API pubbliche ESPN (CORS aperto)
   ========================================================= */
(() => {
  'use strict';

  const ROMA_ID = '104';
  const NEWS_TTL = 10 * 60 * 1000;      // dopo 10 minuti le notizie in cache si riscaricano
  const SPORT_TTL = 15 * 60 * 1000;
  const PAGE_SIZE = 13;
  const LS = 'fmr:v1:';

  const gn = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=it&gl=IT&ceid=IT:it';

  // Fonti: testate giallorosse + ricerche Google News per categoria.
  // "via" = intermediari da provare in ordine. Il carico è diviso tra Jina e rss2json
  // perché i servizi gratuiti limitano le richieste per utente.
  const SOURCES = [
    { id: 'forzaroma', name: 'Forzaroma.info', site: 'https://www.forzaroma.info', url: 'https://www.forzaroma.info/feed', via: ['jina', 'rss2json'] },
    { id: 'cds', name: 'Corriere dello Sport', site: 'https://www.corrieredellosport.it/calcio/serie-a/roma', url: 'https://www.corrieredellosport.it/rss/calcio/serie-a/roma', via: ['jina', 'rss2json'] },
    { id: 'vocegiallorossa', name: 'Vocegiallorossa', site: 'https://www.vocegiallorossa.it', url: 'https://www.vocegiallorossa.it/rss/', via: ['jina', 'rss2json'] },
    { id: 'gn-coppe', name: 'Google News · Coppe', site: 'https://news.google.com', cat: 'coppe', gn: true, via: ['rss2json'],
      url: gn('Roma ("Champions League" OR "Europa League" OR "Conference League" OR "Coppa Italia") when:7d') },
    { id: 'romanews', name: 'RomaNews', site: 'https://www.romanews.eu', url: 'https://www.romanews.eu/feed/', via: ['rss2json'] },
    { id: 'gn-tifosi', name: 'Google News · Tifosi', site: 'https://news.google.com', cat: 'tifosi', gn: true, via: ['rss2json'],
      url: gn('(tifosi OR "Curva Sud" OR romanisti) (Roma OR giallorossi) when:10d') },
    { id: 'siamolaroma', name: 'Siamo la Roma', site: 'https://www.siamolaroma.it', url: 'https://www.siamolaroma.it/feed/', via: ['rss2json'] },
    { id: 'gn-mercato', name: 'Google News · Mercato', site: 'https://news.google.com', cat: 'mercato', gn: true, via: ['rss2json'],
      url: gn('Roma calciomercato when:4d') },
  ];
  const ITEMS_PER_SOURCE = 25;
  // notizie di altre squadre pubblicate dalle testate romaniste ("Serie A - Venezia-Udinese 0-0")
  const OFF_TOPIC = /^(serie a|serie b|serie c|premier league|liga|bundesliga|ligue 1|champions league|europa league)\s*[-–:]/i;

  const CAT_RULES = {
    coppe: /champions|europa league|conference league|coppa italia|supercoppa|\buefa\b|league phase|fase a gironi|ottavi|playoff europe|\bucl\b/i,
    mercato: /mercato|trattativ|acquist|cession|rinnov|ingaggi|prestito|offert|clausola|riscatto|svincolat|firma con|colpo|obiettivo|sondaggio|\bds\b|gennaio.*arriv/i,
    tifosi: /tifos|curva sud|romanist|ultras|sold out|biglietti|abbonament|trasferta|cori\b|coreografi|striscion|olimpico (?:pieno|esaurito)|spalti|supporter/i,
    campionato: /serie a\b|campionato|giornata|classifica|derby|anticipo|posticipo/i,
  };
  const JUNK = /pronostic|quote\b|bookmaker|scommess|fantacalcio|\bsos fanta\b|consigli fanta/i;

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const decoder = document.createElement('textarea');
  const decode = s => { let out = String(s ?? ''); for (let i = 0; i < 2; i++) { decoder.innerHTML = out; out = decoder.value; } return out; };
  const stripHtml = s => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(LS + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage pieno o bloccato */ } },
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchWithTimeout(url, ms = 12000, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  }

  const TZ = 'Europe/Rome';
  const fmt = {
    day: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: '2-digit' }),
    mon: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, month: 'short' }),
    wd: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'short' }),
    time: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
    full: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }),
    short: new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: 'numeric', month: 'short' }),
  };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function ago(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return 'adesso';
    if (d < 3600) return Math.floor(d / 60) + ' min fa';
    if (d < 86400) return Math.floor(d / 3600) + (Math.floor(d / 3600) === 1 ? ' ora fa' : ' ore fa');
    if (d < 172800) return 'ieri';
    if (d < 604800) return Math.floor(d / 86400) + ' giorni fa';
    return fmt.short.format(ts);
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // gol della Roma: schermo che lampeggia giallorosso, scritta enorme, coriandoli, vibrazione
  function celebrateGoal(score, scorer, min) {
    $('.goal')?.remove();
    try { navigator.vibrate?.([250, 90, 250, 90, 500]); } catch (e) { /* non supportato */ }
    const bits = Array.from({ length: 70 }, (_, i) => {
      const c = ['var(--gold)', 'var(--red-bright)', 'var(--cream)'][i % 3];
      return `<i style="--x:${(Math.random() * 100).toFixed(1)}vw;--d:${(Math.random() * 1.2).toFixed(2)}s;--t:${(2.2 + Math.random() * 1.8).toFixed(2)}s;--r:${Math.round(Math.random() * 720 - 360)}deg;--s:${(6 + Math.random() * 8).toFixed(0)}px;background:${c}"></i>`;
    }).join('');
    const el = document.createElement('div');
    el.className = 'goal';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="goal__flash"></div><div class="goal__rays"></div><div class="goal__confetti" aria-hidden="true">${bits}</div>
      <div class="goal__text"><span class="goal__word">GOOOL!</span><span class="goal__sub">Roma ${esc(score)}</span>${scorer || min ? `<span class="goal__who">${esc(scorer)}${scorer && min ? ' · ' : ''}${esc(min)}</span>` : ''}<span class="goal__cry">Daje Roma daje!</span></div>`;
    const close = () => { el.classList.add('is-out'); setTimeout(() => el.remove(), 400); };
    el.addEventListener('click', close);
    document.body.appendChild(el);
    setTimeout(close, 5200);
    const card = $('#nextMatch');
    if (card) { card.classList.remove('is-goal'); void card.offsetWidth; card.classList.add('is-goal'); setTimeout(() => card.classList.remove('is-goal'), 8000); }
  }

  /* =======================================================
     NOTIZIE
     ======================================================= */
  const PROXIES = {
    // Jina Reader: restituisce l'XML originale del feed (molte notizie, con immagini)
    jina: async (url) => parseXml(await (await okOrThrow(fetchWithTimeout('https://r.jina.ai/' + url, 15000, { headers: { 'X-Return-Format': 'html' } }))).text()),
    // rss2json: JSON già pronto, massimo 10 notizie, limite di 10 richieste al minuto
    rss2json: async (url) => {
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetchWithTimeout('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url));
        if (r.status !== 429) break;
        await sleep(8000 + attempt * 4000); // troppe richieste: aspetto e riprovo
      }
      if (!r.ok) throw new Error('rss2json ' + r.status);
      const j = await r.json();
      if (j.status !== 'ok') throw new Error(j.message || 'rss2json error');
      return j.items.map(it => ({
        title: it.title, link: it.link, date: parseRss2jsonDate(it.pubDate),
        desc: it.description || it.content || '',
        img: it.enclosure?.link && /image|jpe?g|png|webp/i.test((it.enclosure.type || '') + it.enclosure.link) ? it.enclosure.link : (it.thumbnail || ''),
        author: it.author || '',
      }));
    },
    // proxy "grezzi" di riserva
    allorigins: async (url) => parseXml(await (await okOrThrow(fetchWithTimeout('https://api.allorigins.win/raw?url=' + encodeURIComponent(url), 8000))).text()),
    codetabs: async (url) => parseXml(await (await okOrThrow(fetchWithTimeout('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url), 8000))).text()),
  };
  async function okOrThrow(p) { const r = await p; if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  function parseRss2jsonDate(s) {
    if (!s) return Date.now();
    const t = Date.parse(s.replace(' ', 'T') + 'Z'); // rss2json restituisce UTC
    return isNaN(t) ? Date.parse(s) || Date.now() : t;
  }
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML non valido');
    const nodes = [...doc.querySelectorAll('item, entry')];
    if (!nodes.length) throw new Error('feed vuoto');
    return nodes.slice(0, 40).map(n => {
      const get = sel => n.getElementsByTagName(sel)[0];
      const linkEl = get('link');
      const link = linkEl ? (linkEl.getAttribute('href') || linkEl.textContent) : '';
      const media = get('media:content') || get('media:thumbnail') || get('enclosure');
      const desc = get('description')?.textContent || get('content:encoded')?.textContent || get('summary')?.textContent || '';
      const imgInDesc = /<img[^>]+src=["']([^"']+)/i.exec(desc)?.[1] || '';
      return {
        title: get('title')?.textContent || '',
        link: link.trim(),
        date: Date.parse(get('pubDate')?.textContent || get('published')?.textContent || get('updated')?.textContent || '') || Date.now(),
        desc, img: media?.getAttribute('url') || imgInDesc, author: get('dc:creator')?.textContent || '',
      };
    });
  }

  async function fetchSource(src) {
    let lastErr;
    const order = [...src.via, ...['allorigins', 'codetabs'].filter(p => !src.via.includes(p))];
    for (const p of order) {
      try {
        const items = await PROXIES[p](src.url);
        if (items.length) return items;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('nessun dato');
  }

  let teamNames = []; // squadre di Serie A (dalla classifica), per riconoscere le notizie di campionato

  function normalize(raw, src) {
    let title = stripHtml(raw.title);
    let source = src.name;
    if (src.gn) {
      // Google News: "Titolo - Testata"
      const m = /^(.*)\s+-\s+([^-]{2,60})$/.exec(title);
      if (m) { title = m[1].trim(); source = m[2].trim(); }
    }
    let desc = src.gn ? '' : stripHtml(raw.desc);
    if (desc.startsWith(title)) desc = desc.slice(title.length).trim();
    if (desc.length > 260) desc = desc.slice(0, 257).replace(/\s+\S*$/, '') + '…';
    let img = raw.img || /<img[^>]+src=["']([^"']+)/i.exec(raw.desc || '')?.[1] || '';
    if (img.startsWith('//')) img = 'https:' + img;
    if (img && !/^https:/.test(img)) img = img.startsWith('http:') ? img.replace(/^http:/, 'https:') : '';
    const now = Date.now();
    const date = Math.min(raw.date || now, now);
    const text = (title + ' ' + desc);
    const cats = new Set();
    if (src.cat) cats.add(src.cat);
    for (const [cat, re] of Object.entries(CAT_RULES)) if (re.test(text)) cats.add(cat);
    if (!cats.has('coppe') && teamNames.some(n => n && new RegExp('\\b' + n + '\\b', 'i').test(title))) cats.add('campionato');
    return { id: (raw.link || title).trim(), title, desc, link: raw.link, img, date, source, srcId: src.id, cats: [...cats] };
  }

  const keyOf = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 3).slice(0, 8).join(' ');

  function mergeNews(perSource) {
    const all = [];
    const seen = new Map();
    for (const list of Object.values(perSource)) {
      for (const it of list.items || []) {
        if (!it.title || JUNK.test(it.title) || (OFF_TOPIC.test(it.title) && !/roma|gialloross/i.test(it.title))) continue;
        const k = keyOf(it.title);
        if (seen.has(k)) {
          const prev = seen.get(k);
          prev.cats = [...new Set([...prev.cats, ...it.cats])];
          if (!prev.img && it.img) prev.img = it.img;
          continue;
        }
        const copy = { ...it };
        seen.set(k, copy); all.push(copy);
      }
    }
    return all.sort((a, b) => b.date - a.date);
  }

  const state = { cat: 'tutte', shown: PAGE_SIZE, news: [], perSource: store.get('news') || {}, seenIds: new Set(store.get('seen') || []), firstVisit: !store.get('seen') };

  let loadingNews = null;
  function loadNews(force = false) {
    if (loadingNews) return loadingNews;
    loadingNews = doLoadNews(force).finally(() => { loadingNews = null; });
    return loadingNews;
  }
  async function doLoadNews(force) {
    const btn = $('#refreshBtn');
    btn.classList.add('is-spinning');
    $('#newsMeta').textContent = 'Aggiornamento in corso…';
    const now = Date.now();
    const stale = SOURCES.filter(s => force || !state.perSource[s.id] || now - (state.perSource[s.id].ts || 0) > NEWS_TTL);
    renderSources();

    // Una fila per intermediario: Jina in parallelo alla fila di rss2json, che va una richiesta alla volta
    const chains = {};
    const tasks = stale.map(src => {
      const q = src.via[0];
      const prev = chains[q] || Promise.resolve(null);
      return (chains[q] = prev.then(async (wasFirst) => {
      if (wasFirst !== null && q === 'rss2json') await sleep(1500);
      try {
        const raw = await fetchSource(src);
        state.perSource[src.id] = { ts: Date.now(), ok: true, items: raw.slice(0, ITEMS_PER_SOURCE).map(r => normalize(r, src)) };
      } catch (e) {
        const prev = state.perSource[src.id];
        state.perSource[src.id] = { ...(prev || { items: [] }), ok: false, err: String(e.message || e) };
      }
      store.set('news', state.perSource);
      rebuildNews();
      renderSources();
      const done = SOURCES.filter(x => state.perSource[x.id]?.ok).length;
      if (state.news.length) $('#newsMeta').textContent = `${state.news.length} notizie da ${done} fonti · ne arrivano altre…`;
      return true;
    }));
    });
    await Promise.allSettled(tasks);
    btn.classList.remove('is-spinning');
    const okCount = SOURCES.filter(s => state.perSource[s.id]?.ok).length;
    const time = fmt.time.format(Date.now());
    $('#newsMeta').textContent = state.news.length
      ? `${state.news.length} notizie da ${okCount} fonti · aggiornate alle ${time}`
      : 'Nessuna notizia raggiungibile al momento';
    if (force) toast(okCount ? 'Notizie aggiornate. Daje!' : 'Fonti non raggiungibili, riprova tra poco');
  }

  function rebuildNews() {
    // le categorie dipendono anche dalla classifica: ricalcolo dai dati grezzi già normalizzati
    state.news = mergeNews(state.perSource);
    renderTicker();
    renderChips();
    renderNews();
  }

  function filtered() {
    return state.cat === 'tutte' ? state.news : state.news.filter(n => n.cats.includes(state.cat));
  }

  const CAT_LABEL = { campionato: 'Campionato', coppe: 'Coppe', mercato: 'Mercato', tifosi: 'Tifosi' };

  function renderChips() {
    $$('#chips .chip').forEach(ch => {
      const c = ch.dataset.cat;
      const n = c === 'tutte' ? state.news.length : state.news.filter(x => x.cats.includes(c)).length;
      ch.innerHTML = `${esc(ch.dataset.label || (ch.dataset.label = ch.textContent.trim()))}<span class="count">${n || ''}</span>`;
    });
  }

  function newsCard(n, i) {
    const feature = i === 0;
    const isNew = !state.firstVisit && !state.seenIds.has(n.id);
    const tags = n.cats.filter(c => CAT_LABEL[c]).slice(0, 2).map(c => `<span class="tag tag--${c}">${CAT_LABEL[c]}</span>`).join('');
    const placeholderWords = n.title.split(/\s+/).slice(0, 4).join(' ');
    const media = n.img
      ? `<div class="card__media"><img src="${esc(n.img)}" alt="" loading="${i < 3 ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('card__media--type');this.parentNode.innerHTML='<span>${esc(esc(n.source))}</span>'"></div>`
      : `<div class="card__media card__media--type${i % 2 ? ' alt' : ''}"><span>${esc(n.source || placeholderWords)}</span></div>`;
    return `<a class="card${feature ? ' card--feature' : ''}${isNew ? ' is-new' : ''}" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" style="animation-delay:${Math.min(i, 8) * 40}ms">
      ${media}
      <div class="card__body">
        ${tags ? `<div class="card__tags">${tags}</div>` : ''}
        <h3 class="card__title">${esc(n.title)}</h3>
        ${n.desc ? `<p class="card__excerpt">${esc(n.desc)}</p>` : ''}
        <div class="card__foot"><span class="card__src">${esc(n.source)}</span><time class="card__time" datetime="${new Date(n.date).toISOString()}">${ago(n.date)}</time></div>
      </div>
    </a>`;
  }

  function renderNews() {
    const grid = $('#newsGrid');
    const list = filtered();
    if (!list.length) {
      const loading = SOURCES.some(s => !state.perSource[s.id]);
      if (loading && !state.news.length) return; // lascio gli scheletri finché arriva qualcosa
      grid.innerHTML = `<div class="empty"><strong>${state.news.length ? 'Niente in questa sezione' : 'Nessuna notizia'}</strong>${state.news.length ? 'Prova un\'altra categoria.' : 'Le fonti non rispondono. Controlla la connessione e tocca aggiorna.'}</div>`;
      $('#moreBtn').hidden = true;
      return;
    }
    grid.innerHTML = list.slice(0, state.shown).map(newsCard).join('');
    $('#moreBtn').hidden = list.length <= state.shown;
  }

  function renderTicker() {
    const top = state.news.slice(0, 10);
    if (!top.length) return;
    const html = top.map(n => `<a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`).join('');
    const el = $('#ticker');
    el.innerHTML = html + html; // duplicato per lo scorrimento infinito
    el.style.animationDuration = Math.max(40, top.reduce((a, n) => a + n.title.length, 0) / 6) + 's';
  }

  function renderSources() {
    $('#sourcesList').innerHTML = SOURCES.map(s => {
      const st = state.perSource[s.id];
      const cls = !st ? '' : st.ok ? 'ok' : (st.items?.length ? 'cache' : 'err');
      const title = !st ? 'in caricamento' : st.ok ? 'raggiungibile' : (st.items?.length ? 'non raggiungibile, mostro la copia salvata' : 'non raggiungibile');
      return `<li><a href="${esc(s.site)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a><span class="dot ${cls}" title="${title}" aria-label="${title}"></span></li>`;
    }).join('') + `<li><a href="https://www.espn.com/soccer/team/_/id/104" target="_blank" rel="noopener noreferrer">ESPN · Partite e classifiche</a><span class="dot ${sportOk === null ? '' : sportOk ? 'ok' : 'err'}"></span></li>`;
  }

  function markSeen() {
    // le notizie viste in questa visita non saranno "nuove" alla prossima
    const ids = state.news.slice(0, 200).map(n => n.id);
    store.set('seen', [...new Set([...ids, ...state.seenIds])].slice(0, 600));
  }

  /* =======================================================
     PARTITE E CLASSIFICHE (ESPN)
     ======================================================= */
  const ESPN = 'https://site.api.espn.com/apis';
  let sportOk = null;
  let liveTimer = null, countdownTimer = null, lastLiveFail = 0;

  const NAME_MAP = {
    'AS Roma': 'Roma', 'Internazionale': 'Inter', 'AC Milan': 'Milan', 'Hellas Verona': 'Verona', 'Paris Saint-Germain': 'PSG',
    'Manchester United': 'Man United', 'Manchester City': 'Man City', 'Bayern Munich': 'Bayern', 'Borussia Dortmund': 'Dortmund',
    'Atletico Madrid': 'Atlético', 'Real Madrid': 'Real Madrid', 'Tottenham Hotspur': 'Tottenham', 'Sporting CP': 'Sporting',
  };
  const COMP_MAP = {
    'ita.1': 'Serie A', 'uefa.champions': 'Champions League', 'uefa.europa': 'Europa League', 'uefa.europa.conf': 'Conference League',
    'ita.coppa_italia': 'Coppa Italia', 'ita.super_cup': 'Supercoppa', 'club.friendly': 'Amichevole',
  };
  const teamName = t => NAME_MAP[t.displayName] || NAME_MAP[t.shortDisplayName] || t.shortDisplayName || t.displayName || t.name || '?';
  // stemmi ridimensionati dal CDN di ESPN (l'originale è 500px)
  const teamLogo = (t, size = 120) => {
    const src = t.logos?.[0]?.href || t.logo || `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id}.png`;
    const m = /a\.espncdn\.com(\/i\/teamlogos\/[^?]+\.png)/.exec(src);
    return m ? `https://a.espncdn.com/combiner/i?img=${m[1]}&w=${size}&h=${size}` : src;
  };

  const SCHED_TTL = 30 * 1000;   // calendario e risultati: copia salvata valida solo 30 secondi
  const LIVE_EVERY = 15 * 1000;  // durante la partita: punteggio ogni 15 secondi

  async function espn(path, cacheKey, ttl = SPORT_TTL) {
    const cached = store.get(cacheKey);
    if (cached && Date.now() - cached.ts < ttl) return cached.data;
    try {
      const r = await fetchWithTimeout(ESPN + path, 12000);
      if (!r.ok) throw new Error('ESPN ' + r.status);
      const data = await r.json();
      store.set(cacheKey, { ts: Date.now(), data });
      return data;
    } catch (e) {
      if (cached) return cached.data;
      throw e;
    }
  }

  // gol della partita: squadra che segna (negli autogol è quella che ne beneficia), minuto, marcatore
  function goalsOf(details) {
    return details.filter(d => d.scoringPlay && !d.shootout).map(d => {
      const a = d.athletesInvolved?.[0] || {};
      return { team: d.team?.id, min: d.clock?.displayValue || '', who: a.shortName || a.displayName || '', og: !!d.ownGoal, pen: !!d.penaltyKick };
    });
  }
  const goalLabel = g => `${g.who || 'Gol'}${g.og ? ' (aut.)' : g.pen ? ' (rig.)' : ''}`;

  function normEvent(e) {
    const c = e.competitions?.[0] || {};
    const side = ha => {
      const t = c.competitors?.find(x => x.homeAway === ha) || {};
      const score = t.score && typeof t.score === 'object' ? t.score.displayValue : t.score;
      return { id: t.team?.id || t.id, name: teamName(t.team || {}), logo: teamLogo(t.team || { id: t.id }, 200), score, winner: t.winner };
    };
    const slug = e.league?.slug || e.season?.slug || '';
    const st = c.status?.type || e.status?.type || {};
    return {
      id: e.id, date: Date.parse(e.date), slug, comp: COMP_MAP[slug] || (e.league?.name || '').replace(/^Italian /, '').replace(/^UEFA /, ''),
      home: side('home'), away: side('away'), state: st.state || 'pre', status: st.name || '', detail: st.shortDetail || st.detail || '',
      clock: c.status?.displayClock || '', venue: c.venue?.fullName || '', tv: (c.broadcasts || []).flatMap(b => b.names || [b.media?.shortName]).filter(Boolean),
      ...(Array.isArray(c.details) ? { goals: goalsOf(c.details) } : {}),
    };
  }
  // cosa scrivere nel bollino LIVE: ESPN all'intervallo lascia il minuto fermo a 45'+x
  function liveLabel(m) {
    const n = m.status || '';
    if (/HALFTIME/.test(n)) return 'Intervallo';
    if (/END_OF_REGULATION/.test(n)) return 'Fine 90\'';
    if (/END_OF_EXTRA/.test(n)) return 'Fine supplementari';
    if (/SHOOTOUT|PENALT/.test(n)) return 'Rigori';
    return m.clock || m.detail;
  }
  const isCup = m => m.slug && m.slug !== 'ita.1' && m.slug !== 'club.friendly';
  function outcome(m) {
    const roma = m.home.id === ROMA_ID ? m.home : m.away;
    const opp = roma === m.home ? m.away : m.home;
    const a = parseInt(roma.score, 10), b = parseInt(opp.score, 10);
    if (isNaN(a) || isNaN(b)) return '';
    return a > b ? 'W' : a < b ? 'L' : (roma.winner ? 'W' : opp.winner ? 'L' : 'D'); // i rigori decidono il "winner"
  }

  let matches = { past: [], next: [] };

  async function loadMatches(force = false) {
    try {
      const ttl = force ? 0 : SCHED_TTL;
      const [past, next] = await Promise.all([
        espn('/site/v2/sports/soccer/all/teams/' + ROMA_ID + '/schedule', 'sched-past', ttl),
        espn('/site/v2/sports/soccer/all/teams/' + ROMA_ID + '/schedule?fixture=true', 'sched-next', ttl),
      ]);
      const byId = new Map();
      [...(past.events || []), ...(next.events || [])].forEach(e => { const m = normEvent(e); byId.set(m.id, { ...byId.get(m.id), ...m }); });
      const all = [...byId.values()].sort((a, b) => a.date - b.date);
      matches.past = all.filter(m => m.state === 'post').reverse();
      matches.next = all.filter(m => m.state !== 'post');
      sportOk = true;
      renderHero();
      renderFixtures();
    } catch (e) {
      sportOk = false;
      $('#nextMatch .match-card__body').outerHTML = `<div class="match-card__body"><p>Calendario non disponibile al momento.</p></div>`;
      $('#lastMatch').innerHTML = '<h2 class="eyebrow">Ultimo risultato</h2><p class="mini-card__note">Non disponibile</p>';
    }
    renderSources();
  }

  // partita in corso: chiedo solo il tabellone della competizione (leggero e aggiornato in pochi secondi)
  const romaScore = m => parseInt((m.home.id === ROMA_ID ? m.home : m.away).score, 10) || 0;
  async function pollLive(m) {
    if (document.hidden) { liveTimer = setTimeout(() => pollLive(m), LIVE_EVERY); return; }
    try {
      if (!m.slug) throw new Error('competizione sconosciuta');
      const r = await fetchWithTimeout(`${ESPN}/site/v2/sports/soccer/${m.slug}/scoreboard`, 10000);
      if (!r.ok) throw new Error('ESPN ' + r.status);
      const e = ((await r.json()).events || []).find(x => x.id === m.id);
      if (!e) throw new Error('partita non trovata');
      const u = normEvent(e);
      const nu = { ...m, ...u, slug: m.slug, comp: m.comp, tv: m.tv, venue: u.venue || m.venue };
      if (nu.state === 'post') { loadMatches(true); return; }
      const before = romaScore(m), after = romaScore(nu);
      matches.next = matches.next.map(x => x.id === m.id ? nu : x);
      renderHero();
      renderFixtures();
      if (after > before) {
        const g = (nu.goals || []).filter(x => x.team === ROMA_ID).pop();
        celebrateGoal(after, g ? goalLabel(g) : '', g?.min || '');
      }
    } catch (err) {
      lastLiveFail = Date.now();
      loadMatches(true);
    }
  }

  const icon = {
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
    cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    tv: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 2l3 4 3-4"/></svg>',
  };
  const scorers = m => {
    const list = t => `<ul class="scorers__list${t.id === ROMA_ID ? ' is-roma' : ''}">${(m.goals || []).filter(g => g.team === t.id)
      .map(g => `<li><span class="scorers__min">${esc(g.min)}</span> ${esc(goalLabel(g))}</li>`).join('')}</ul>`;
    return `<div class="scorers" aria-label="Marcatori">${list(m.home)}${list(m.away)}</div>`;
  };
  const teamBlock = t => `<div class="team${t.id === ROMA_ID ? ' is-roma' : ''}"><img class="team__logo" src="${esc(t.logo)}" alt="" loading="lazy"><span class="team__name">${esc(t.name)}</span></div>`;

  function renderHero() {
    const live = matches.next.find(m => m.state === 'in');
    const nm = live || matches.next[0];
    const box = $('#nextMatch');
    clearInterval(countdownTimer); clearTimeout(liveTimer);
    if (!nm) {
      box.innerHTML = `<h2 class="eyebrow" id="heroTitle">Prossima partita</h2><div class="match-card__body"><p>Nessuna partita in programma per ora.</p></div>`;
    } else {
      const when = cap(fmt.full.format(nm.date)) + ' · ore ' + fmt.time.format(nm.date);
      const mid = live
        ? `<div class="versus__mid"><span class="live-pill">LIVE ${esc(liveLabel(nm))}</span><span class="versus__score">${esc(nm.home.score ?? 0)} – ${esc(nm.away.score ?? 0)}</span></div>`
        : `<div class="versus__mid"><span class="versus__vs">VS</span></div>`;
      box.innerHTML = `
        <h2 class="eyebrow" id="heroTitle">${live ? 'In campo adesso' : 'Prossima partita'}</h2>
        <span class="comp-badge${isCup(nm) ? ' is-cup' : ''}">${esc(nm.comp)}</span>
        <div class="versus">${teamBlock(nm.home)}${mid}${teamBlock(nm.away)}</div>
        ${live && nm.goals?.length ? scorers(nm) : ''}
        ${live ? '' : '<div class="countdown" id="countdown" aria-label="Conto alla rovescia"></div>'}
        <div class="match-meta">
          <span>${icon.cal}${esc(when)}</span>
          ${nm.venue ? `<span>${icon.pin}${esc(nm.venue)}</span>` : ''}
          ${nm.tv.length ? `<span>${icon.tv}${esc(nm.tv.slice(0, 2).join(', '))}</span>` : ''}
        </div>`;
      if (live) {
        const soon = !live.goals && Date.now() - lastLiveFail > LIVE_EVERY;
        liveTimer = setTimeout(() => pollLive(live), soon ? 300 : LIVE_EVERY);
      } else {
        const tick = () => {
          const el = $('#countdown');
          if (!el) return;
          let d = Math.max(0, nm.date - Date.now());
          if (d === 0) { el.innerHTML = '<div style="grid-column:1/-1"><b>Si gioca!</b></div>'; clearInterval(countdownTimer); liveTimer = setTimeout(() => loadMatches(true), LIVE_EVERY); return; }
          const days = Math.floor(d / 864e5); d -= days * 864e5;
          const h = Math.floor(d / 36e5); d -= h * 36e5;
          const m = Math.floor(d / 6e4); d -= m * 6e4;
          const s = Math.floor(d / 1e3);
          const p = n => String(n).padStart(2, '0');
          el.innerHTML = `<div><b>${days}</b><small>${days === 1 ? 'giorno' : 'giorni'}</small></div><div><b>${p(h)}</b><small>ore</small></div><div><b>${p(m)}</b><small>min</small></div><div><b>${p(s)}</b><small>sec</small></div>`;
        };
        tick(); countdownTimer = setInterval(tick, 1000);
      }
    }

    // ultimo risultato
    const last = matches.past.find(m => m.slug !== 'club.friendly') || matches.past[0];
    if (last) {
      const o = outcome(last);
      const label = { W: 'Vittoria', D: 'Pareggio', L: 'Sconfitta' }[o] || '';
      $('#lastMatch').innerHTML = `<h2 class="eyebrow">Ultimo risultato</h2>
        <div class="last">
          <div class="last__team"><img src="${esc(last.home.logo)}" alt="" loading="lazy"><span>${esc(last.home.name)}</span></div>
          <div class="last__score">${esc(last.home.score)} – ${esc(last.away.score)}</div>
          <div class="last__team"><img src="${esc(last.away.logo)}" alt="" loading="lazy"><span>${esc(last.away.name)}</span></div>
        </div>
        <p class="last__sub">${esc(last.comp)} · ${esc(fmt.short.format(last.date))}${label ? `<br><span class="result-tag ${o}">${label}</span>` : ''}</p>`;
    }

    // forma: ultime 5 ufficiali
    const off = matches.past.filter(m => m.slug !== 'club.friendly').slice(0, 5);
    const res = off.map(outcome);
    $('#form').innerHTML = off.map((m, i) => {
      const r = res[i];
      const opp = m.home.id === ROMA_ID ? m.away.name : m.home.name;
      return `<span class="${r}" title="${esc(m.home.name)} ${esc(m.home.score)}-${esc(m.away.score)} ${esc(m.away.name)}" aria-label="${{ W: 'Vittoria', D: 'Pareggio', L: 'Sconfitta' }[r] || ''} contro ${esc(opp)}">${{ W: 'V', D: 'N', L: 'P' }[r] || '·'}</span>`;
    }).join('');
    const w = res.filter(r => r === 'W').length, d = res.filter(r => r === 'D').length, l = res.filter(r => r === 'L').length;
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    $('#formNote').textContent = off.length ? `Ultime ${off.length}: ${pl(w, 'vittoria', 'vittorie')}, ${pl(d, 'pareggio', 'pareggi')}, ${pl(l, 'sconfitta', 'sconfitte')}` : '';
  }

  let calMode = 'next';
  function renderFixtures() {
    const list = calMode === 'next' ? matches.next.slice(0, 8) : matches.past.slice(0, 8);
    if (!list.length) { $('#fixtures').innerHTML = '<li class="mini-card__note">Nessuna partita.</li>'; return; }
    $('#fixtures').innerHTML = list.map(m => {
      const o = calMode === 'past' ? outcome(m) : '';
      const past = calMode === 'past';
      const goals = side => past ? `<b class="fx__goals">${esc(side.score)}</b>` : '';
      const tag = past && o ? `<span class="result-tag ${o}">${{ W: 'V', D: 'N', L: 'P' }[o]}</span>` : '';
      return `<li class="fx${past ? ' fx--past' : ''}">
        <div class="fx__date">${esc(fmt.wd.format(m.date))}<b>${esc(fmt.day.format(m.date))}</b>${esc(fmt.mon.format(m.date).replace('.', ''))}</div>
        <div class="fx__teams">
          <span class="fx__comp${isCup(m) ? ' is-cup' : ''}">${esc(m.comp)}${m.state === 'in' ? ' · LIVE' : ''}</span>
          <div class="fx__team${m.home.id === ROMA_ID ? ' is-roma' : ''}"><img src="${esc(m.home.logo)}" alt="" loading="lazy"><span>${esc(m.home.name)}</span>${goals(m.home)}</div>
          <div class="fx__team${m.away.id === ROMA_ID ? ' is-roma' : ''}"><img src="${esc(m.away.logo)}" alt="" loading="lazy"><span>${esc(m.away.name)}</span>${goals(m.away)}</div>${tag}
        </div>${past ? '' : `
        <div class="fx__right">${esc(fmt.time.format(m.date))}</div>`}
      </li>`;
    }).join('');
  }

  let tableMode = 'ita.1';
  const tables = {};
  async function loadTable(slug) {
    try {
      const data = await espn('/v2/sports/soccer/' + slug + '/standings', 'table-' + slug);
      const group = data.children?.[0] || {};
      const entries = (group.standings?.entries || []).map(e => {
        const st = Object.fromEntries((e.stats || []).map(s => [s.name, s]));
        const v = k => st[k]?.displayValue ?? st[k]?.value ?? '';
        return {
          id: e.team.id, name: teamName(e.team), logo: teamLogo(e.team, 48), rank: +(st.rank?.value ?? 0),
          gp: v('gamesPlayed'), w: v('wins'), d: v('ties'), l: v('losses'), gd: v('pointDifferential'), pts: v('points'),
          zone: e.note?.color || '', zoneLabel: e.note?.description || '',
        };
      }).sort((a, b) => a.rank - b.rank);
      tables[slug] = { name: group.name || '', season: (group.name || '').replace(/^(\d{4})-(\d{4}) Italian Serie A$/, 'Serie A $1/$2').replace('League Phase', 'Fase campionato'), entries };
      if (slug === 'ita.1') {
        teamNames = entries.map(e => e.name).filter(n => n !== 'Roma' && n.length > 2).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        // ricategorizzo le notizie già caricate ora che conosco le squadre
        for (const src of SOURCES) {
          const ps = state.perSource[src.id];
          if (!ps?.items) continue;
          ps.items.forEach(it => {
            if (!it.cats.includes('coppe') && !it.cats.includes('campionato') && teamNames.some(n => new RegExp('\\b' + n + '\\b', 'i').test(it.title))) it.cats.push('campionato');
          });
        }
        rebuildNews();
      }
    } catch (e) {
      tables[slug] = { error: true };
    }
    if (slug === tableMode) renderTable();
  }

  function renderTable() {
    const t = tables[tableMode];
    const wrap = $('#tableWrap');
    $('#tableTitle').textContent = tableMode === 'ita.1' ? 'Classifica Serie A' : 'Champions League';
    if (!t) { wrap.innerHTML = '<div class="skeleton-block tall"></div>'; loadTable(tableMode); return; }
    if (t.error || !t.entries?.length) { wrap.innerHTML = '<p class="mini-card__note">Classifica non disponibile al momento.</p>'; $('#tableFoot').textContent = ''; return; }
    let rows = t.entries;
    let compact = false;
    if (rows.length > 22) {
      // Champions: mostro le prime 8 e la zona attorno alla Roma
      const ri = rows.findIndex(r => r.id === ROMA_ID);
      const keep = new Set([...Array(8).keys()]);
      if (ri >= 0) for (let i = Math.max(0, ri - 3); i <= Math.min(rows.length - 1, ri + 3); i++) keep.add(i);
      rows = rows.map((r, i) => keep.has(i) ? r : null);
      compact = true;
    }
    let html = '<table class="standings"><thead><tr><th>#</th><th>Squadra</th><th>G</th><th>V</th><th>N</th><th>P</th><th>DR</th><th>Pt</th></tr></thead><tbody>';
    let gap = false;
    rows.forEach(r => {
      if (!r) { if (!gap) html += '<tr class="gap"><td colspan="8">···</td></tr>'; gap = true; return; }
      gap = false;
      html += `<tr class="${r.id === ROMA_ID ? 'is-roma' : ''}">
        <td class="pos" style="--zone:${esc(r.zone || 'transparent')}">${r.rank}</td>
        <td class="team-cell"><div><img src="${esc(r.logo)}" alt="" loading="lazy"><span>${esc(r.name)}</span></div></td>
        <td>${esc(r.gp)}</td><td>${esc(r.w)}</td><td>${esc(r.d)}</td><td>${esc(r.l)}</td><td>${esc(r.gd)}</td><td class="pts">${esc(r.pts)}</td></tr>`;
    });
    html += '</tbody></table>';
    const zones = [...new Map(t.entries.filter(r => r.zone && r.zoneLabel).map(r => [r.zoneLabel, r.zone])).entries()];
    const ZONES = [[/conference league qualif/i, 'Preliminari Conference'], [/relegat/i, 'Retrocessione'], [/knockout.*play/i, 'Spareggi'], [/round of 16|last 16/i, 'Ottavi di finale'], [/eliminat/i, 'Eliminate'], [/qualif/i, 'Qualificazione']];
    const zoneIt = s => (ZONES.find(([re]) => re.test(s)) || [null, s])[1];
    const zonesIt = [...new Map(zones.map(([l, c]) => [zoneIt(l), c]).reverse()).entries()].reverse();
    if (zonesIt.length) html += '<div class="legend">' + zonesIt.map(([l, c]) => `<span><i style="background:${esc(c)}"></i>${esc(l)}</span>`).join('') + '</div>';
    wrap.innerHTML = html;
    const roma = t.entries.find(r => r.id === ROMA_ID);
    $('#tableFoot').textContent = (t.season || '') + (roma ? ` · Roma ${roma.rank}ª con ${roma.pts} punti` : '');
  }

  /* =======================================================
     UI: filtri, navigazione, installazione
     ======================================================= */
  function bindUI() {
    $('#chips').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      state.cat = b.dataset.cat; state.shown = PAGE_SIZE;
      $$('#chips .chip').forEach(c => { const on = c === b; c.classList.toggle('is-active', on); c.setAttribute('aria-selected', on); });
      renderNews();
    });
    $('#moreBtn').addEventListener('click', () => { state.shown += PAGE_SIZE; renderNews(); });
    $('#refreshBtn').addEventListener('click', () => { loadNews(true); loadMatches(); });

    $$('[data-table]').forEach(b => b.addEventListener('click', () => {
      tableMode = b.dataset.table;
      $$('[data-table]').forEach(x => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', on); });
      renderTable();
    }));
    $$('[data-cal]').forEach(b => b.addEventListener('click', () => {
      calMode = b.dataset.cal;
      $$('[data-cal]').forEach(x => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', on); });
      renderFixtures();
    }));

    // tab bar: evidenzia la sezione visibile
    const navLinks = $$('.tabbar a');
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) navLinks.forEach(a => a.classList.toggle('is-active', a.dataset.nav === en.target.id));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['partite', 'notizie', 'classifica', 'calendario'].forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });

    // installazione PWA
    // Il tasto "Installa" c'è sempre finché l'app non è installata:
    // - Chrome/Edge/Samsung (Android e desktop): apre la finestra di installazione del browser
    // - Safari iPhone/iPad, Safari Mac, Firefox…: mostra le istruzioni giuste per quel dispositivo
    let deferred = null;
    const ua = navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /android/i.test(ua);
    const isFirefox = /firefox|fxios/i.test(ua);
    const isSafariMac = !isIOS && /safari/i.test(ua) && !/chrome|chromium|crios|edg|opr|firefox/i.test(ua) && /macintosh/i.test(ua);
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const shareIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4l4 4M6 11v9h12v-9"/></svg>';
    const installBtn = $('#installBtn');
    const hint = $('#iosHint');

    function installHelp() {
      if (isIOS) return `Per installare l'app: tocca <strong>Condividi</strong> ${shareIcon} in basso (o in alto su iPad), poi <strong>Aggiungi alla schermata Home</strong>.`;
      if (isAndroid && isFirefox) return 'Per installare l\'app: apri il menu <strong>⋮</strong> di Firefox e scegli <strong>Installa</strong> (o <strong>Aggiungi alla schermata Home</strong>).';
      if (isAndroid) return 'Per installare l\'app: apri il menu <strong>⋮</strong> del browser e scegli <strong>Installa app</strong> o <strong>Aggiungi a schermata Home</strong>.';
      if (isSafariMac) return 'Per installare l\'app sul Mac: menu <strong>File</strong> → <strong>Aggiungi al Dock</strong>.';
      if (isFirefox) return 'Firefox per computer non installa le app web: apri il sito con <strong>Chrome</strong>, <strong>Edge</strong> o <strong>Safari</strong>, oppure dal telefono.';
      return 'Per installare l\'app: clicca l\'icona di installazione nella barra degli indirizzi, oppure menu <strong>⋮</strong> → <strong>Trasmetti, salva e condividi</strong> → <strong>Installa pagina come app</strong>.';
    }
    function showHelp() { $('#installHintText').innerHTML = installHelp(); hint.hidden = false; }

    installBtn.hidden = isStandalone();
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; installBtn.hidden = false; });
    installBtn.addEventListener('click', async () => {
      if (!deferred) { showHelp(); return; }
      const ev = deferred; deferred = null; // il prompt del browser si può usare una volta sola
      ev.prompt();
      const { outcome: choice } = await ev.userChoice;
      if (choice === 'accepted') { installBtn.hidden = true; toast('Forza Maggica Roma è installata. Daje!'); }
    });
    window.addEventListener('appinstalled', () => { installBtn.hidden = true; hint.hidden = true; });
    $('#iosHintClose').addEventListener('click', () => { hint.hidden = true; store.set('iosHintClosed', true); });

    // su iPhone non esiste un prompt automatico: mostro il suggerimento una volta, dopo qualche secondo
    if (isIOS && !isStandalone() && !store.get('iosHintClosed')) setTimeout(showHelp, 4000);

    // quando l'utente torna sull'app, aggiorno se i dati sono vecchi
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { markSeen(); return; }
      loadNews(false); loadMatches();
    });
    window.addEventListener('pagehide', markSeen);
    window.addEventListener('online', () => { toast('Di nuovo online'); loadNews(false); loadMatches(); });
    window.addEventListener('offline', () => toast('Sei offline: mostro le ultime notizie salvate', 3500));

    // anteprima dell'animazione del gol: aggiungi ?provagol all'indirizzo
    if (new URLSearchParams(location.search).has('provagol')) setTimeout(() => celebrateGoal(2, 'R. Mora', "58'"), 1200);

    // aggiorno i "x min fa" ogni minuto
    setInterval(() => $$('.card__time').forEach(t => { t.textContent = ago(Date.parse(t.getAttribute('datetime'))); }), 60000);
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Nuova versione disponibile: ricarica la pagina', 5000);
        });
      });
    }).catch(() => { /* il sito funziona anche senza */ });
  }

  // ---------- avvio ----------
  bindUI();
  if (Object.keys(state.perSource).length) rebuildNews(); // mostro subito quello che ho salvato
  renderSources();
  loadMatches();
  loadTable('ita.1');
  loadNews(false).then(() => { if (state.firstVisit) markSeen(); });
  registerSW();
})();
