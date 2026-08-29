// ==UserScript==
// @name         Operator Ratunkowy - Menedżer UM OR
// @namespace    operatorratunkowy.local.poimanager
// @version      4.00
// @description  Katalog i kontrola UM/POI na podstawie Potencjalnych misji oraz własnych punktów UM.
// @author       ChatGPT
// @license      CC BY-NC-SA 4.0
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-um-or.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-um-or.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        GM_info
// ==/UserScript==

/*
 * Operator Ratunkowy - Menedżer UM OR
 * Wersja 4.00
 *
 * Założenia wersji 4.00:
 * - wspólna numeracja projektu Operator Menadżery rozpoczyna się od 4.00,
 * - wspólne zasady przycisków: jednakowy rozmiar, ikona + nazwa w pierwszej linii, wersja w drugiej linii, przycisk tylko na stronie głównej,
 * - nazwa na przycisku: „📍 UM”,
 * - rozmiar przycisku jest synchronizowany z widocznymi przyciskami pozostałych menedżerów; przy ich braku używany jest wspólny rozmiar awaryjny,
 * - numer wersji jest wyświetlany zwykłą, niepogrubioną czcionką pod nazwą i odczytywany z metadanych userscriptu przez GM_info,
 * - w zakładce „Moje UM” pozostaje niezależne sortowanie po typie i po nazwie,
 * - zachowano poprawione wyświetlanie przycisku na dole strony głównej,
 * - przycisk ma wysoki z-index i ustawia się automatycznie po lewej stronie
 *   istniejących przycisków pozostałych menedżerów,
 * - lista rodzajów UM nie jest wpisana na sztywno,
 * - katalog wymaganych UM jest pobierany z publicznej strony /einsaetze
 *   (Potencjalne misje), z kolumny "UM",
 * - skrypt zbiera wszystkie nazwy UM, usuwa duplikaty i przypisuje do nich misje,
 * - własne UM są pobierane z oficjalnego API /api/v2/pois,
 * - dla zgodności z różnymi wariantami odpowiedzi API parser akceptuje kilka nazw pól,
 * - jeśli API zwraca tylko numery typów POI, ich nazwy są mapowane przez
 *   https://api.lss-manager.de/pl_PL/pois,
 * - zakładka "Braki" pokazuje typy UM wymagane przez misje, których użytkownik
 *   nie ma wśród własnych UM,
 * - przycisk menedżera jest wyświetlany tylko na stronie głównej gry.
 */

(() => {
  'use strict';

  const APP_ID = 'or-um-manager-v30';
  const BUTTON_ID = `${APP_ID}-button`;
  const MODAL_ID = `${APP_ID}-modal`;
  const VERSION = '4.00';
  const MISSIONS_URL = '/einsaetze';
  const POIS_API_URL = '/api/v2/pois';
  const POI_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/pois';
  const PAGE_SIZE = 1000;

  if (window.top !== window.self) return;
  if (document.getElementById(BUTTON_ID)) return;

  const state = {
    activeTab: 'required',
    requiredPois: [],
    ownPois: [],
    poiCatalog: [],
    loadingRequired: false,
    loadingOwn: false,
    requiredError: '',
    ownError: '',
    query: '',
    statusFilter: 'all',
    requiredSort: 'name-asc',
    ownSort: 'type-asc',
  };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeKey(value) {
    return normalizeText(value)
      .toLocaleLowerCase('pl-PL')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function getScriptVersion() {
    try {
      if (typeof GM_info !== 'undefined') {
        const value = normalizeText(GM_info?.script?.version);
        if (value) return value;
      }
    } catch (_) {}
    return VERSION;
  }

  function isMainPage() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    return path === '/';
  }

  function injectStyles() {
    if (document.getElementById(`${APP_ID}-style`)) return;

    const style = document.createElement('style');
    style.id = `${APP_ID}-style`;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed !important;
        right: 520px;
        bottom: 18px;
        z-index: 2147483000 !important;
        display: inline-flex !important;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        width: 118px !important;
        height: 50px !important;
        box-sizing: border-box !important;
        border: 0;
        border-radius: 999px;
        padding: 6px 10px !important;
        background: #6c5ce7;
        color: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,.28);
        font: 700 13px/1.2 Arial,sans-serif;
        cursor: pointer;
        white-space: nowrap;
      }
      #${BUTTON_ID}:hover { filter: brightness(1.08); }
      #${BUTTON_ID} .or-um-launcher-title { display: inline-flex; align-items: center; justify-content: center; gap: 4px; font: 700 13px/1.15 Arial,sans-serif; }
      #${BUTTON_ID} .or-um-launcher-icon { font-weight: 400; }
      #${BUTTON_ID} .or-um-launcher-version { font: 400 9px/1.05 Arial,sans-serif; font-weight: 400 !important; opacity: .78; }

      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483001;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(0,0,0,.48);
      }
      #${MODAL_ID}.open { display: flex; }
      #${MODAL_ID} .or-um-window {
        width: min(1240px, 96vw);
        height: min(860px, 94vh);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 12px;
        background: #f7f8fa;
        box-shadow: 0 18px 55px rgba(0,0,0,.35);
        color: #1f2937;
      }
      #${MODAL_ID} .or-um-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 18px;
        background: #2d3436;
        color: #fff;
      }
      #${MODAL_ID} .or-um-header h2 { margin: 0; font-size: 20px; }
      #${MODAL_ID} .or-um-close {
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 8px;
        background: rgba(255,255,255,.12);
        color: #fff;
        font-size: 25px;
        cursor: pointer;
      }
      #${MODAL_ID} .or-um-tabs {
        display: flex;
        gap: 6px;
        padding: 10px 14px 0;
        background: #eceff3;
        border-bottom: 1px solid #d7dce2;
      }
      #${MODAL_ID} .or-um-tab {
        border: 1px solid #cfd5dc;
        border-bottom: 0;
        border-radius: 8px 8px 0 0;
        padding: 9px 14px;
        background: #dde2e8;
        cursor: pointer;
        font-weight: 700;
      }
      #${MODAL_ID} .or-um-tab.active { background: #fff; }
      #${MODAL_ID} .or-um-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 12px 14px;
        background: #fff;
        border-bottom: 1px solid #dde2e8;
      }
      #${MODAL_ID} input,
      #${MODAL_ID} select,
      #${MODAL_ID} button.or-um-btn {
        min-height: 34px;
        border: 1px solid #cbd3dc;
        border-radius: 7px;
        padding: 6px 10px;
        background: #fff;
        color: #1f2937;
      }
      #${MODAL_ID} input { min-width: 260px; flex: 1 1 300px; }
      #${MODAL_ID} button.or-um-btn { cursor: pointer; font-weight: 700; }
      #${MODAL_ID} button.or-um-btn.primary {
        background: #6c5ce7;
        border-color: #6c5ce7;
        color: #fff;
      }
      #${MODAL_ID} .or-um-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        padding: 8px 14px;
        background: #f8fafc;
        border-bottom: 1px solid #dde2e8;
        font-size: 13px;
      }
      #${MODAL_ID} .or-um-summary b { color: #111827; }
      #${MODAL_ID} .or-um-status {
        margin-left: auto;
        color: #5b6470;
      }
      #${MODAL_ID} .or-um-table-wrap {
        flex: 1;
        overflow: auto;
        background: #fff;
      }
      #${MODAL_ID} table { width: 100%; border-collapse: collapse; font-size: 13px; }
      #${MODAL_ID} th,
      #${MODAL_ID} td {
        padding: 8px 10px;
        border-bottom: 1px solid #edf0f3;
        vertical-align: top;
        text-align: left;
      }
      #${MODAL_ID} th {
        position: sticky;
        top: 0;
        z-index: 2;
        background: #eef1f5;
        color: #374151;
      }
      #${MODAL_ID} tr.missing { background: #fff5f5; }
      #${MODAL_ID} tr.present { background: #f3fff6; }
      #${MODAL_ID} .badge {
        display: inline-block;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 800;
        white-space: nowrap;
      }
      #${MODAL_ID} .badge.ok { background: #dff6e5; color: #146c2e; }
      #${MODAL_ID} .badge.miss { background: #ffe2e2; color: #a61b1b; }
      #${MODAL_ID} .badge.neutral { background: #e9edf2; color: #4b5563; }
      #${MODAL_ID} .muted { color: #6b7280; }
      #${MODAL_ID} .missions {
        max-width: 560px;
        white-space: normal;
        line-height: 1.35;
      }
      #${MODAL_ID} .or-um-empty {
        padding: 28px;
        text-align: center;
        color: #6b7280;
      }
      #${MODAL_ID} .or-um-error {
        margin: 12px 14px;
        padding: 10px 12px;
        border-radius: 7px;
        background: #ffe6e6;
        color: #8b1e1e;
      }
      #${MODAL_ID} .or-um-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 14px;
        background: #f1f3f6;
        border-top: 1px solid #d8dde4;
        font-size: 12px;
        color: #5b6470;
      }
      @media (max-width: 800px) {
        #${MODAL_ID} { padding: 0; }
        #${MODAL_ID} .or-um-window { width: 100vw; height: 100vh; border-radius: 0; }
        #${MODAL_ID} input { min-width: 180px; }
        #${BUTTON_ID} { bottom: 18px; }
      }
    `;
    document.head.appendChild(style);
  }

  function launcherCandidates() {
    const ids = [
      'or-crew-manager-v01-button',
      'orzr-launcher',
      'or-building-manager-v01-button',
      'or-fleet-manager-v01-button',
    ];
    const byId = ids.map(id => document.getElementById(id)).filter(Boolean);
    const byText = [...document.querySelectorAll('button')].filter(el => {
      if (el.id === BUTTON_ID) return false;
      const text = normalizeText(el.textContent);
      return /(?:Załoga OR|Menedżer ZR|Budynki OR|Flota OR)/i.test(text);
    });
    return [...new Set([...byId, ...byText])].filter(el => {
      if (!el || el.id === BUTTON_ID) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function syncLauncherSize(button, candidates) {
    if (!button) return;

    // Wspólna zasada projektu: przyciski menedżerów mają mieć jednakowe rozmiary.
    // Jeżeli inny przycisk jest już widoczny, przejmujemy jego faktyczny rozmiar.
    // Pozwala to zachować zgodność także wtedy, gdy standard wymiarów zmieni się
    // w pozostałych menedżerach.
    const preferred = candidates
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(x => x.rect.width >= 70 && x.rect.width <= 220 && x.rect.height >= 32 && x.rect.height <= 80)
      .sort((a, b) => {
        const at = normalizeText(a.el.textContent);
        const bt = normalizeText(b.el.textContent);
        const ap = /ZR Lista|Menedżer ZR/i.test(at) ? 0 : 1;
        const bp = /ZR Lista|Menedżer ZR/i.test(bt) ? 0 : 1;
        return ap - bp;
      })[0];

    if (preferred) {
      button.style.width = `${Math.round(preferred.rect.width)}px`;
      button.style.height = `${Math.round(preferred.rect.height)}px`;
    } else {
      button.style.width = '118px';
      button.style.height = '50px';
    }
  }

  function positionLauncherButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return false;

    button.style.bottom = '18px';
    const candidates = launcherCandidates();
    syncLauncherSize(button, candidates);
    if (!candidates.length) {
      button.style.right = '520px';
      return false;
    }

    // UM OR trafia po lewej stronie najbardziej wysuniętego w lewo
    // przycisku istniejących menedżerów, dzięki czemu nie nachodzi na nie.
    const leftmost = candidates.reduce((a, b) =>
      a.getBoundingClientRect().left < b.getBoundingClientRect().left ? a : b
    );
    const rect = leftmost.getBoundingClientRect();
    const gap = 10;
    const right = Math.max(10, Math.round(window.innerWidth - rect.left + gap));
    const bottom = Math.max(10, Math.round(window.innerHeight - rect.bottom));
    button.style.right = `${right}px`;
    button.style.bottom = `${bottom}px`;
    return true;
  }

  function startLauncherPositioning() {
    positionLauncherButton();
    [100, 300, 700, 1500, 3000, 5000].forEach(delay => {
      setTimeout(positionLauncherButton, delay);
    });
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      positionLauncherButton();
      if (attempts >= 40) clearInterval(timer);
    }, 250);
    window.addEventListener('resize', positionLauncherButton, { passive: true });
  }

  function createUi() {
    injectStyles();

    if (isMainPage()) {
      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.innerHTML = `<span class="or-um-launcher-title"><span class="or-um-launcher-icon" aria-hidden="true">📍</span> UM</span><span class="or-um-launcher-version">v${esc(getScriptVersion())}</span>`;
      button.title = 'Menedżer UM / POI';
      button.addEventListener('click', openManager);
      document.body.appendChild(button);
      startLauncherPositioning();
    }

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="or-um-window" role="dialog" aria-modal="true" aria-label="Menedżer UM OR">
        <div class="or-um-header">
          <h2>📍 Menedżer UM OR <span style="font-size:12px;opacity:.75">v${esc(getScriptVersion())}</span></h2>
          <button type="button" class="or-um-close" id="${APP_ID}-close" title="Zamknij">×</button>
        </div>

        <div class="or-um-tabs">
          <button type="button" class="or-um-tab active" data-tab="required">Wymagane UM</button>
          <button type="button" class="or-um-tab" data-tab="own">Moje UM</button>
          <button type="button" class="or-um-tab" data-tab="missing">Braki</button>
        </div>

        <div class="or-um-toolbar">
          <input id="${APP_ID}-search" type="search" placeholder="Szukaj UM, misji, ID...">
          <select id="${APP_ID}-status-filter">
            <option value="all">Wszystkie</option>
            <option value="present">Mam UM</option>
            <option value="missing">Brak UM</option>
          </select>
          <select id="${APP_ID}-sort"></select>
          <button type="button" class="or-um-btn primary" id="${APP_ID}-reload">↻ Odśwież dane</button>
          <button type="button" class="or-um-btn" id="${APP_ID}-export">Eksport CSV</button>
        </div>

        <div class="or-um-summary" id="${APP_ID}-summary"></div>
        <div id="${APP_ID}-errors"></div>
        <div class="or-um-table-wrap" id="${APP_ID}-content"></div>

        <div class="or-um-footer">
          <span>Źródła: „Potencjalne misje” + /api/v2/pois</span>
          <span>UM = POI</span>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById(`${APP_ID}-close`).addEventListener('click', closeManager);
    modal.addEventListener('click', event => {
      if (event.target === modal) closeManager();
    });

    modal.querySelectorAll('.or-um-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        modal.querySelectorAll('.or-um-tab').forEach(x => x.classList.toggle('active', x === tab));
        render();
      });
    });

    document.getElementById(`${APP_ID}-search`).addEventListener('input', event => {
      state.query = event.target.value;
      render();
    });

    document.getElementById(`${APP_ID}-status-filter`).addEventListener('change', event => {
      state.statusFilter = event.target.value;
      render();
    });

    document.getElementById(`${APP_ID}-sort`).addEventListener('change', event => {
      if (state.activeTab === 'own') state.ownSort = event.target.value;
      else state.requiredSort = event.target.value;
      render();
    });

    document.getElementById(`${APP_ID}-reload`).addEventListener('click', () => loadAll(true));
    document.getElementById(`${APP_ID}-export`).addEventListener('click', exportCsv);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal.classList.contains('open')) closeManager();
    });
  }

  async function openManager() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add('open');
    render();
    if (!state.requiredPois.length && !state.loadingRequired) {
      await loadAll(false);
    }
  }

  function closeManager() {
    document.getElementById(MODAL_ID)?.classList.remove('open');
  }

  async function loadAll(force) {
    if (force) {
      state.requiredPois = [];
      state.ownPois = [];
      state.poiCatalog = [];
      state.requiredError = '';
      state.ownError = '';
    }

    state.loadingRequired = true;
    state.loadingOwn = true;
    render();

    const catalogPromise = loadPoiCatalog().catch(() => []);
    const requiredPromise = loadRequiredPois();
    const ownPromise = loadOwnPois();

    const [catalogResult, requiredResult, ownResult] = await Promise.allSettled([
      catalogPromise,
      requiredPromise,
      ownPromise,
    ]);

    if (catalogResult.status === 'fulfilled') state.poiCatalog = catalogResult.value;

    if (requiredResult.status === 'fulfilled') {
      state.requiredPois = requiredResult.value;
      state.requiredError = '';
    } else {
      state.requiredError = requiredResult.reason?.message || String(requiredResult.reason || 'Nieznany błąd');
    }

    if (ownResult.status === 'fulfilled') {
      state.ownPois = ownResult.value;
      state.ownError = '';
    } else {
      state.ownError = ownResult.reason?.message || String(ownResult.reason || 'Nieznany błąd');
    }

    state.loadingRequired = false;
    state.loadingOwn = false;
    enrichOwnPoiTypes();
    render();
  }

  async function loadPoiCatalog() {
    const response = await fetch(POI_CATALOG_URL, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`Katalog POI: HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data.map(normalizeText) : [];
  }

  async function loadRequiredPois() {
    const response = await fetch(MISSIONS_URL, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`Potencjalne misje: HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = findMissionTable(doc);
    if (!table) throw new Error('Nie znaleziono tabeli „Potencjalne misje”.');

    const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
      .map(th => normalizeText(th.textContent));

    const umIndex = headers.findIndex(h => normalizeKey(h) === 'um');
    const nameIndex = headers.findIndex(h => normalizeKey(h).includes('nazwa misji'));
    if (umIndex < 0) throw new Error('Nie znaleziono kolumny „UM” w „Potencjalnych misjach”.');

    const map = new Map();
    const rows = Array.from(table.querySelectorAll('tbody tr'));

    for (const row of rows) {
      const cells = Array.from(row.children).filter(el => el.matches('td, th'));
      if (!cells.length || !cells[umIndex]) continue;

      const missionName = normalizeText(cells[nameIndex >= 0 ? nameIndex : 1]?.textContent) || 'Nieznana misja';
      const poiNames = extractPoiNames(cells[umIndex]);

      for (const poiName of poiNames) {
        const key = normalizeKey(poiName);
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, { name: poiName, missions: new Set() });
        }
        map.get(key).missions.add(missionName);
      }
    }

    return Array.from(map.values())
      .map(item => ({
        name: item.name,
        missions: Array.from(item.missions).sort((a, b) => a.localeCompare(b, 'pl')),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  }

  function findMissionTable(doc) {
    const tables = Array.from(doc.querySelectorAll('table'));
    return tables.find(table => {
      const headers = Array.from(table.querySelectorAll('th')).map(th => normalizeKey(th.textContent));
      return headers.includes('um') && headers.some(h => h.includes('nazwa misji'));
    }) || null;
  }

  function extractPoiNames(cell) {
    const anchorTexts = Array.from(cell.querySelectorAll('a'))
      .map(a => normalizeText(a.textContent))
      .filter(Boolean);
    if (anchorTexts.length) return [...new Set(anchorTexts)];

    const clone = cell.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('div, p, li').forEach(el => el.append('\n'));

    const text = String(clone.textContent || '').replace(/\u00a0/g, ' ');
    return [...new Set(text
      .split(/[\n\r]+/)
      .map(normalizeText)
      .filter(Boolean))];
  }

  async function loadOwnPois() {
    const all = [];
    let after = null;
    let rounds = 0;

    while (rounds < 200) {
      const url = new URL(POIS_API_URL, location.origin);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (after !== null) url.searchParams.set('after', String(after));

      const response = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Moje UM: HTTP ${response.status}`);

      const data = await response.json();
      const batch = extractArrayFromApi(data);
      if (!batch.length) break;

      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;

      const lastId = getId(batch[batch.length - 1]);
      if (lastId === null || String(lastId) === String(after)) break;
      after = lastId;
      rounds += 1;
    }

    const normalized = all.map(normalizeOwnPoi).filter(Boolean);
    const seen = new Set();
    return normalized.filter(poi => {
      const key = poi.id !== '' ? `id:${poi.id}` : `x:${poi.lat}:${poi.lon}:${poi.type}:${poi.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractArrayFromApi(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    for (const key of ['result', 'pois', 'data', 'items', 'records']) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  function getId(item) {
    if (!item || typeof item !== 'object') return null;
    return item.id ?? item.poi_id ?? item.poiId ?? null;
  }

  function normalizeOwnPoi(item) {
    if (!item || typeof item !== 'object') return null;

    const id = getId(item) ?? '';
    const typeRaw = item.poi_type ?? item.poiType ?? item.type_id ?? item.typeId ?? item.type ?? '';
    const typeCaption =
      item.poi_type_caption ?? item.poiTypeCaption ?? item.poi_type_name ?? item.poiTypeName ??
      item.type_caption ?? item.typeCaption ?? item.type_name ?? item.typeName ?? '';
    const name = normalizeText(item.caption ?? item.name ?? item.title ?? item.description ?? '');
    const lat = item.latitude ?? item.lat ?? item.position?.lat ?? item.location?.lat ?? '';
    const lon = item.longitude ?? item.lng ?? item.lon ?? item.position?.lng ?? item.position?.lon ?? item.location?.lng ?? item.location?.lon ?? '';

    return {
      id: String(id),
      typeRaw,
      type: normalizeText(typeCaption || (typeof typeRaw === 'string' && !/^\d+$/.test(typeRaw) ? typeRaw : '')),
      name,
      lat: lat === null || lat === undefined ? '' : String(lat),
      lon: lon === null || lon === undefined ? '' : String(lon),
      raw: item,
    };
  }

  function enrichOwnPoiTypes() {
    if (!state.poiCatalog.length || !state.ownPois.length) return;
    for (const poi of state.ownPois) {
      if (poi.type) continue;
      const n = Number(poi.typeRaw);
      if (!Number.isFinite(n)) continue;
      if (state.poiCatalog[n] !== undefined) poi.type = normalizeText(state.poiCatalog[n]);
      else if (n > 0 && state.poiCatalog[n - 1] !== undefined) poi.type = normalizeText(state.poiCatalog[n - 1]);
    }
  }

  function ownCountByType() {
    const counts = new Map();
    for (const poi of state.ownPois) {
      const key = normalizeKey(poi.type);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function combinedRequiredRows() {
    const counts = ownCountByType();
    return state.requiredPois.map(item => ({
      ...item,
      ownCount: counts.get(normalizeKey(item.name)) || 0,
    }));
  }

  function updateSortControl() {
    const select = document.getElementById(`${APP_ID}-sort`);
    if (!select) return;

    if (state.activeTab === 'own') {
      select.innerHTML = `
        <option value="type-asc">Typ A–Z</option>
        <option value="type-desc">Typ Z–A</option>
        <option value="own-name-asc">Nazwa A–Z</option>
        <option value="own-name-desc">Nazwa Z–A</option>
      `;
      select.value = state.ownSort;
    } else {
      select.innerHTML = `
        <option value="name-asc">Nazwa A–Z</option>
        <option value="name-desc">Nazwa Z–A</option>
        <option value="count-desc">Najwięcej własnych UM</option>
        <option value="missions-desc">Najwięcej misji</option>
      `;
      select.value = state.requiredSort;
    }
  }

  function applyFilters(rows, tab) {
    const q = normalizeKey(state.query);
    let result = rows.filter(row => {
      if (!q) return true;
      const hay = tab === 'own'
        ? [row.id, row.type, row.name, row.lat, row.lon].join(' ')
        : [row.name, ...(row.missions || [])].join(' ');
      return normalizeKey(hay).includes(q);
    });

    if (tab !== 'own' && state.statusFilter !== 'all') {
      result = result.filter(row => state.statusFilter === 'present' ? row.ownCount > 0 : row.ownCount === 0);
    }

    const sort = tab === 'own' ? state.ownSort : state.requiredSort;

    result.sort((a, b) => {
      if (tab === 'own') {
        const aType = normalizeText(a.type || a.typeRaw || '');
        const bType = normalizeText(b.type || b.typeRaw || '');
        const aName = normalizeText(a.name || '');
        const bName = normalizeText(b.name || '');

        if (sort === 'type-desc') {
          return bType.localeCompare(aType, 'pl') || aName.localeCompare(bName, 'pl');
        }
        if (sort === 'own-name-asc') {
          return aName.localeCompare(bName, 'pl') || aType.localeCompare(bType, 'pl');
        }
        if (sort === 'own-name-desc') {
          return bName.localeCompare(aName, 'pl') || aType.localeCompare(bType, 'pl');
        }
        return aType.localeCompare(bType, 'pl') || aName.localeCompare(bName, 'pl');
      }

      if (sort === 'name-desc') {
        return b.name.localeCompare(a.name, 'pl');
      }
      if (sort === 'count-desc') {
        return (b.ownCount || 0) - (a.ownCount || 0) || a.name.localeCompare(b.name, 'pl');
      }
      if (sort === 'missions-desc') {
        return (b.missions?.length || 0) - (a.missions?.length || 0) || a.name.localeCompare(b.name, 'pl');
      }
      return a.name.localeCompare(b.name, 'pl');
    });

    return result;
  }

  function render() {
    const content = document.getElementById(`${APP_ID}-content`);
    const summary = document.getElementById(`${APP_ID}-summary`);
    const errors = document.getElementById(`${APP_ID}-errors`);
    const statusFilter = document.getElementById(`${APP_ID}-status-filter`);
    if (!content || !summary || !errors) return;

    updateSortControl();

    const busy = state.loadingRequired || state.loadingOwn;
    const requiredRows = combinedRequiredRows();
    const missingRows = requiredRows.filter(row => row.ownCount === 0);

    summary.innerHTML = `
      <span>Wymagane typy UM: <b>${requiredRows.length}</b></span>
      <span>Moje UM: <b>${state.ownPois.length}</b></span>
      <span>Brakujące typy: <b>${missingRows.length}</b></span>
      <span class="or-um-status">${busy ? 'Wczytywanie danych…' : 'Dane gotowe'}</span>
    `;

    const errorParts = [];
    if (state.requiredError) errorParts.push(`<div class="or-um-error"><b>Potencjalne misje:</b> ${esc(state.requiredError)}</div>`);
    if (state.ownError) errorParts.push(`<div class="or-um-error"><b>Moje UM:</b> ${esc(state.ownError)}</div>`);
    errors.innerHTML = errorParts.join('');

    if (statusFilter) statusFilter.disabled = state.activeTab === 'own';

    if (busy && !requiredRows.length && !state.ownPois.length) {
      content.innerHTML = '<div class="or-um-empty">Wczytywanie listy UM…</div>';
      return;
    }

    if (state.activeTab === 'own') {
      renderOwn(content);
    } else if (state.activeTab === 'missing') {
      renderRequired(content, applyFilters(missingRows, 'missing'), true);
    } else {
      renderRequired(content, applyFilters(requiredRows, 'required'), false);
    }
  }

  function renderRequired(content, rows, onlyMissing) {
    if (!rows.length) {
      content.innerHTML = `<div class="or-um-empty">${onlyMissing ? 'Nie znaleziono brakujących UM dla obecnego filtra.' : 'Brak danych do wyświetlenia.'}</div>`;
      return;
    }

    content.innerHTML = `
      <table>
        <thead>
          <tr>
            <th style="width:34%">UM / POI</th>
            <th style="width:110px">Moje</th>
            <th style="width:110px">Misje</th>
            <th>Występuje w potencjalnych misjach</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr class="${row.ownCount > 0 ? 'present' : 'missing'}">
              <td><b>${esc(row.name)}</b></td>
              <td>${row.ownCount > 0
                ? `<span class="badge ok">Mam: ${row.ownCount}</span>`
                : '<span class="badge miss">BRAK</span>'}</td>
              <td><span class="badge neutral">${row.missions.length}</span></td>
              <td class="missions">${row.missions.map(esc).join('<br>')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderOwn(content) {
    const rows = applyFilters(state.ownPois, 'own');
    if (!rows.length) {
      content.innerHTML = '<div class="or-um-empty">Nie znaleziono własnych UM dla obecnego filtra.</div>';
      return;
    }

    content.innerHTML = `
      <table>
        <thead>
          <tr>
            <th style="width:100px">ID</th>
            <th style="width:30%">Typ UM</th>
            <th>Nazwa / opis</th>
            <th style="width:145px">Szerokość</th>
            <th style="width:145px">Długość</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${esc(row.id)}</td>
              <td><b>${esc(row.type || row.typeRaw || 'Nieznany typ')}</b></td>
              <td>${esc(row.name || '')}</td>
              <td>${esc(row.lat)}</td>
              <td>${esc(row.lon)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function exportCsv() {
    const sep = ';';
    const lines = [];

    if (state.activeTab === 'own') {
      const rows = applyFilters(state.ownPois, 'own');
      lines.push(['ID', 'Typ UM', 'Nazwa', 'Szerokosc', 'Dlugosc'].map(csvCell).join(sep));
      for (const row of rows) {
        lines.push([row.id, row.type || row.typeRaw || '', row.name, row.lat, row.lon].map(csvCell).join(sep));
      }
    } else {
      const required = combinedRequiredRows();
      const baseRows = state.activeTab === 'missing' ? required.filter(row => row.ownCount === 0) : required;
      const rows = applyFilters(baseRows, state.activeTab);
      lines.push(['UM', 'Liczba moich UM', 'Liczba misji', 'Misje'].map(csvCell).join(sep));
      for (const row of rows) {
        lines.push([row.name, row.ownCount, row.missions.length, row.missions.join(' | ')].map(csvCell).join(sep));
      }
    }

    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `menedzer-um-or-${state.activeTab}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  }

  createUi();
})();
