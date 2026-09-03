// ==UserScript==
// @name         Menedżer Generator Misji Sojuszu
// @namespace    https://www.operatorratunkowy.pl/
// @version      4.01
// @description  Generator dużych misji sojuszu: natywny formularz gry, szablony, podgląd i skalowanie wymagań.
// @author       ChatGPT + użytkownik
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-misji-sojuszu.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-misji-sojuszu.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @match        https://policja.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// ==/UserScript==

(() => {
    'use strict';

    const APP_ID = 'or-alliance-mission-manager';
    const VERSION = '4.01';
    const TAG = '[OR Generator Misji Sojuszu]';
    const STORAGE_URL = `${APP_ID}:native-url`;
    const STORAGE_TEMPLATES = `${APP_ID}:templates`;
    const STORAGE_LAST_TEMPLATE = `${APP_ID}:last-template`;

    if (window.top !== window.self) return;
    if (location.pathname !== '/') return;

    const state = {
        nativeUrl: loadText(STORAGE_URL, ''),
        templates: loadJSON(STORAGE_TEMPLATES, {}),
        activeTemplate: loadText(STORAGE_LAST_TEMPLATE, ''),
        discoverBusy: false,
        discoveredAlliancePage: '',
        summaryTimer: null,
        positionTimer: null,
        sizeTimer: null,
        frameLoadSeq: 0
    };

    function log(...args) {
        console.log(TAG, ...args);
    }

    function normalize(text) {
        return String(text ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\u00a0/g, ' ')
            .replace(/[–—]/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function escapeHTML(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function loadText(key, fallback = '') {
        try {
            const value = localStorage.getItem(key);
            return value == null ? fallback : value;
        } catch {
            return fallback;
        }
    }

    function saveText(key, value) {
        try {
            localStorage.setItem(key, String(value ?? ''));
        } catch (error) {
            console.warn(TAG, 'Nie udało się zapisać ustawienia:', error);
        }
    }

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(TAG, 'Nie udało się zapisać danych:', error);
        }
    }

    function sameOriginUrl(value) {
        try {
            const url = new URL(value, location.origin);
            if (url.origin !== location.origin) return null;
            return url;
        } catch {
            return null;
        }
    }

    function canonicalUrl(value) {
        const url = sameOriginUrl(value);
        if (!url) return '';
        url.hash = '';
        return url.href;
    }

    function debounceSummary() {
        clearTimeout(state.summaryTimer);
        state.summaryTimer = setTimeout(updateSummary, 120);
    }

    function ensureStyles() {
        if (document.getElementById(`${APP_ID}-style`)) return;

        const style = document.createElement('style');
        style.id = `${APP_ID}-style`;
        style.textContent = `
#${APP_ID}-launcher{
    position:fixed;right:540px;bottom:18px;z-index:99990;border:0;border-radius:999px;
    padding:8px 16px 7px;background:#337ab7;color:#fff;font:600 13px Arial,sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,.28);cursor:pointer;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:2px;white-space:nowrap;line-height:1.05;
}
#${APP_ID}-launcher:hover{background:#286090}
#${APP_ID}-launcher .or-ams-version{font-size:9px;font-weight:400;opacity:.82;line-height:1}
#${APP_ID}-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);padding:12px;display:none}
#${APP_ID}-overlay.or-ams-open{display:flex}
#${APP_ID}-window{width:min(1740px,calc(100vw - 24px));height:calc(100vh - 24px);margin:auto;background:#fff;
    border-radius:8px;box-shadow:0 10px 45px rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column;
    font-family:Arial,sans-serif;color:#222}
#${APP_ID}-header{height:48px;min-height:48px;background:#333;color:#fff;display:flex;align-items:center;gap:12px;padding:0 14px}
#${APP_ID}-header h3{font-size:17px;line-height:1;margin:0;font-weight:600;flex:1}
#${APP_ID}-header small{font-size:11px;font-weight:400;opacity:.72;margin-left:7px}
#${APP_ID}-close{border:0;background:transparent;color:#fff;font-size:30px;line-height:1;cursor:pointer;padding:0 4px}
#${APP_ID}-body{flex:1;min-height:0;display:flex;flex-direction:column;background:#f5f5f5}
.or-ams-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:8px 10px;background:#fff;border-bottom:1px solid #ddd}
.or-ams-toolbar label{font-size:12px;color:#555;margin:0}
.or-ams-toolbar input,.or-ams-toolbar select{height:32px;border:1px solid #bbb;border-radius:4px;padding:5px 8px;background:#fff;color:#222}
.or-ams-toolbar input[type="number"]{width:84px}
#${APP_ID}-native-url{flex:1;min-width:340px}
#${APP_ID}-template-name{width:190px}
#${APP_ID}-template-select{min-width:210px;max-width:300px}
.or-ams-btn{height:32px;border:1px solid #adadad;border-radius:4px;padding:5px 10px;background:#fff;color:#333;cursor:pointer;white-space:nowrap}
.or-ams-btn:hover{background:#e6e6e6}
.or-ams-btn-primary{background:#337ab7;border-color:#2e6da4;color:#fff}.or-ams-btn-primary:hover{background:#286090}
.or-ams-btn-success{background:#5cb85c;border-color:#4cae4c;color:#fff}.or-ams-btn-success:hover{background:#449d44}
.or-ams-btn-danger{background:#d9534f;border-color:#d43f3a;color:#fff}.or-ams-btn-danger:hover{background:#c9302c}
#${APP_ID}-status{padding:7px 10px;border-bottom:1px solid #ddd;font-size:12px;background:#d9edf7;color:#245269;min-height:29px}
#${APP_ID}-status.or-ams-success{background:#dff0d8;color:#3c763d}
#${APP_ID}-status.or-ams-warning{background:#fcf8e3;color:#8a6d3b}
#${APP_ID}-status.or-ams-danger{background:#f2dede;color:#a94442}
#${APP_ID}-workspace{flex:1;min-height:0;display:grid;grid-template-columns:minmax(270px,330px) 1fr;gap:8px;padding:8px}
#${APP_ID}-side{min-height:0;display:flex;flex-direction:column;gap:8px}
.or-ams-card{background:#fff;border:1px solid #d5d5d5;border-radius:5px;overflow:hidden}
.or-ams-card h4{font-size:13px;margin:0;padding:8px 10px;background:#eee;border-bottom:1px solid #d5d5d5}
.or-ams-card .or-ams-card-body{padding:9px 10px;font-size:12px}
#${APP_ID}-summary{max-height:48vh;overflow:auto;white-space:normal;line-height:1.45}
#${APP_ID}-summary .or-ams-summary-row{padding:3px 0;border-bottom:1px dotted #ddd}
#${APP_ID}-summary .or-ams-summary-row:last-child{border-bottom:0}
#${APP_ID}-summary .or-ams-summary-label{font-weight:600}
#${APP_ID}-frame-wrap{min-height:0;background:#fff;border:1px solid #cfcfcf;border-radius:5px;overflow:hidden;position:relative}
#${APP_ID}-frame{width:100%;height:100%;border:0;background:#fff}
#${APP_ID}-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#777;padding:30px;background:#fff;font-size:14px}
.or-ams-hint{color:#777;line-height:1.45}
.or-ams-kbd{display:inline-block;padding:1px 5px;border:1px solid #bbb;border-bottom-width:2px;border-radius:3px;background:#f7f7f7;font-size:11px}
@media(max-width:1000px){
    #${APP_ID}-workspace{grid-template-columns:1fr}
    #${APP_ID}-side{display:none}
    #${APP_ID}-native-url{min-width:220px}
}
        `;
        document.head.appendChild(style);
    }

    function findReferenceButton() {
        return document.getElementById('orzr-launcher') ||
            document.getElementById('or-building-manager-v01-button') ||
            [...document.querySelectorAll('button,a')].find(el => {
                const text = normalize(el.textContent);
                return text.includes('menedzer zr') || text.includes('budynki');
            }) || null;
    }

    function positionLauncher() {
        const launcher = document.getElementById(`${APP_ID}-launcher`);
        if (!launcher) return;

        // Przycisk tego menedżera ma zawsze pozostać w dolnym rzędzie strony głównej.
        // Inne menedżery służą wyłącznie jako punkt odniesienia w poziomie.
        launcher.style.bottom = '18px';

        const ref = findReferenceButton();
        if (!ref || ref === launcher) {
            launcher.style.left = 'auto';
            launcher.style.right = '18px';
            return;
        }

        const rect = ref.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            launcher.style.left = 'auto';
            launcher.style.right = '18px';
            return;
        }

        const gap = 8;
        launcher.style.right = 'auto';
        launcher.style.left = `${Math.max(8, Math.round(rect.left - launcher.offsetWidth - gap))}px`;
    }

    function syncLauncherSize() {
        const launcher = document.getElementById(`${APP_ID}-launcher`);
        const ref = findReferenceButton();
        if (!launcher || !ref || ref === launcher) return;
        const rect = ref.getBoundingClientRect();
        if (rect.width >= 90 && rect.height >= 32) {
            launcher.style.width = `${Math.round(rect.width)}px`;
            launcher.style.height = `${Math.round(rect.height)}px`;
            launcher.style.padding = '0 8px';
        }
    }

    function schedulePositioning() {
        clearTimeout(state.positionTimer);
        state.positionTimer = setTimeout(() => {
            syncLauncherSize();
            positionLauncher();
        }, 80);
    }

    function createLauncher() {
        if (document.getElementById(`${APP_ID}-launcher`)) return;
        const button = document.createElement('button');
        button.id = `${APP_ID}-launcher`;
        button.type = 'button';
        button.title = 'Menedżer Generator Misji Sojuszu';
        button.innerHTML = `<span>🤝 Misje sojuszu</span><span class="or-ams-version">v${VERSION}</span>`;
        button.addEventListener('click', openManager);
        document.body.appendChild(button);
        schedulePositioning();
        setTimeout(schedulePositioning, 350);
        setTimeout(schedulePositioning, 1000);
    }

    function createUI() {
        if (document.getElementById(`${APP_ID}-overlay`)) return;

        const overlay = document.createElement('div');
        overlay.id = `${APP_ID}-overlay`;
        overlay.innerHTML = `
<div id="${APP_ID}-window" role="dialog" aria-modal="true" aria-label="Menedżer Generator Misji Sojuszu">
    <div id="${APP_ID}-header">
        <h3>🤝 Menedżer Generator Misji Sojuszu <small>v${VERSION}</small></h3>
        <button id="${APP_ID}-close" type="button" title="Zamknij">×</button>
    </div>
    <div id="${APP_ID}-body">
        <div class="or-ams-toolbar">
            <label for="${APP_ID}-native-url">Natywny generator:</label>
            <input id="${APP_ID}-native-url" type="text" spellcheck="false" placeholder="Adres zostanie wykryty automatycznie…">
            <button id="${APP_ID}-discover" class="or-ams-btn or-ams-btn-primary" type="button">🔎 Wykryj</button>
            <button id="${APP_ID}-open-tab" class="or-ams-btn" type="button">↗ Nowa karta</button>
            <button id="${APP_ID}-reload" class="or-ams-btn" type="button">↻ Odśwież formularz</button>
        </div>
        <div class="or-ams-toolbar">
            <label>Szablon:</label>
            <select id="${APP_ID}-template-select"><option value="">— wybierz —</option></select>
            <input id="${APP_ID}-template-name" type="text" maxlength="80" placeholder="Nazwa nowego szablonu">
            <button id="${APP_ID}-save-template" class="or-ams-btn or-ams-btn-success" type="button">💾 Zapisz szablon</button>
            <button id="${APP_ID}-apply-template" class="or-ams-btn" type="button">▶ Zastosuj</button>
            <button id="${APP_ID}-delete-template" class="or-ams-btn or-ams-btn-danger" type="button">🗑 Usuń</button>
            <span style="width:8px"></span>
            <label for="${APP_ID}-factor">Mnożnik wymagań:</label>
            <input id="${APP_ID}-factor" type="number" min="0.1" max="20" step="0.1" value="1.5">
            <button class="or-ams-btn or-ams-factor" type="button" data-factor="0.5">×0,5</button>
            <button class="or-ams-btn or-ams-factor" type="button" data-factor="1.5">×1,5</button>
            <button class="or-ams-btn or-ams-factor" type="button" data-factor="2">×2</button>
            <button id="${APP_ID}-scale" class="or-ams-btn" type="button">⚙ Skaluj wymagania</button>
            <button id="${APP_ID}-clear" class="or-ams-btn" type="button">0 Wyzeruj wymagania</button>
        </div>
        <div id="${APP_ID}-status">Gotowy.</div>
        <div id="${APP_ID}-workspace">
            <div id="${APP_ID}-side">
                <div class="or-ams-card">
                    <h4>Podgląd ustawień</h4>
                    <div class="or-ams-card-body" id="${APP_ID}-summary">Najpierw wczytaj natywny formularz dużej misji sojuszu.</div>
                </div>
                <div class="or-ams-card">
                    <h4>Jak działa generator</h4>
                    <div class="or-ams-card-body or-ams-hint">
                        Menedżer korzysta z <strong>oryginalnego formularza gry</strong>. Ustaw misję i miejsce tak jak zwykle, a następnie możesz zapisać ustawienia jako szablon.<br><br>
                        <strong>Skalowanie</strong> obejmuje wyłącznie pola rozpoznane jako wymagania pojazdów. Pola pozycji, czasu, kredytów i pacjentów są pomijane.<br><br>
                        Jeżeli wykrywanie nie znajdzie strony, wklej jej adres do pola u góry i naciśnij <span class="or-ams-kbd">Enter</span>.
                    </div>
                </div>
            </div>
            <div id="${APP_ID}-frame-wrap">
                <iframe id="${APP_ID}-frame" title="Natywny generator misji sojuszu"></iframe>
                <div id="${APP_ID}-empty">Wykrywam stronę tworzenia dużej misji sojuszu…</div>
            </div>
        </div>
    </div>
</div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) closeManager();
        });
        document.getElementById(`${APP_ID}-close`).addEventListener('click', closeManager);
        document.getElementById(`${APP_ID}-discover`).addEventListener('click', () => discoverCreator(true));
        document.getElementById(`${APP_ID}-open-tab`).addEventListener('click', openNativeInTab);
        document.getElementById(`${APP_ID}-reload`).addEventListener('click', reloadFrame);
        document.getElementById(`${APP_ID}-native-url`).addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            useUrlFromInput();
        });
        document.getElementById(`${APP_ID}-native-url`).addEventListener('change', useUrlFromInput);
        document.getElementById(`${APP_ID}-save-template`).addEventListener('click', saveCurrentTemplate);
        document.getElementById(`${APP_ID}-apply-template`).addEventListener('click', applySelectedTemplate);
        document.getElementById(`${APP_ID}-delete-template`).addEventListener('click', deleteSelectedTemplate);
        document.getElementById(`${APP_ID}-template-select`).addEventListener('change', event => {
            state.activeTemplate = event.target.value;
            saveText(STORAGE_LAST_TEMPLATE, state.activeTemplate);
            const name = event.target.value;
            if (name) document.getElementById(`${APP_ID}-template-name`).value = name;
        });
        document.querySelectorAll('.or-ams-factor').forEach(button => {
            button.addEventListener('click', () => {
                document.getElementById(`${APP_ID}-factor`).value = button.dataset.factor;
            });
        });
        document.getElementById(`${APP_ID}-scale`).addEventListener('click', () => {
            const factor = Number(document.getElementById(`${APP_ID}-factor`).value);
            scaleRequirements(factor);
        });
        document.getElementById(`${APP_ID}-clear`).addEventListener('click', clearRequirements);

        const frame = document.getElementById(`${APP_ID}-frame`);
        frame.addEventListener('load', onFrameLoaded);

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && overlay.classList.contains('or-ams-open')) closeManager();
        });

        renderTemplates();
        if (state.nativeUrl) document.getElementById(`${APP_ID}-native-url`).value = state.nativeUrl;
    }

    function setStatus(message, type = 'info') {
        const el = document.getElementById(`${APP_ID}-status`);
        if (!el) return;
        el.className = '';
        if (type === 'success') el.classList.add('or-ams-success');
        if (type === 'warning') el.classList.add('or-ams-warning');
        if (type === 'danger') el.classList.add('or-ams-danger');
        el.textContent = message;
    }

    function setEmpty(message, visible = true) {
        const el = document.getElementById(`${APP_ID}-empty`);
        if (!el) return;
        el.innerHTML = escapeHTML(message).replace(/\n/g, '<br>');
        el.style.display = visible ? 'flex' : 'none';
    }

    async function openManager() {
        createUI();
        const overlay = document.getElementById(`${APP_ID}-overlay`);
        overlay.classList.add('or-ams-open');

        if (state.nativeUrl) {
            loadNativeUrl(state.nativeUrl, { silent: true });
        } else {
            await discoverCreator(false);
        }
    }

    function closeManager() {
        document.getElementById(`${APP_ID}-overlay`)?.classList.remove('or-ams-open');
    }

    function scoreLink(anchor) {
        const text = normalize(`${anchor.textContent || ''} ${anchor.getAttribute('title') || ''}`);
        const href = normalize(anchor.getAttribute('href') || '');
        let score = 0;

        if (/duz[aey]\s+misj/.test(text)) score += 18;
        if (text.includes('misja sojuszu') || text.includes('misje sojuszu')) score += 20;
        if (text.includes('duzy alarm sojuszu') || text.includes('duze zdarzenie sojuszu')) score += 15;
        if (text.includes('large alliance mission')) score += 20;
        if (text.includes('verbandsgrosseinsatz') || text.includes('verband grosseinsatz')) score += 20;
        if (text.includes('utworz') || text.includes('stworz') || text.includes('generuj') || text.includes('nowa')) score += 8;
        if (href.includes('alliance') || href.includes('verband') || href.includes('sojusz')) score += 6;
        if (href.includes('mission') || href.includes('einsatz')) score += 5;
        if (href.includes('new') || href.includes('create')) score += 5;

        if (text.includes('mala misja') || text.includes('small alliance')) score -= 15;
        if (text.includes('misje sojuszu') && !text.includes('duz') && !text.includes('utworz') && !text.includes('stworz')) score -= 3;

        return score;
    }

    function bestCreatorLink(doc, baseUrl = location.href) {
        const candidates = [];
        for (const anchor of doc.querySelectorAll('a[href]')) {
            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
            let url;
            try {
                url = new URL(href, baseUrl);
            } catch {
                continue;
            }
            if (url.origin !== location.origin) continue;
            const score = scoreLink(anchor);
            if (score >= 10) candidates.push({ url: url.href, score, text: normalize(anchor.textContent) });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0] || null;
    }

    function allianceNavigationLinks(doc = document, baseUrl = location.href) {
        const found = new Map();
        for (const anchor of doc.querySelectorAll('a[href]')) {
            let url;
            try {
                url = new URL(anchor.getAttribute('href'), baseUrl);
            } catch {
                continue;
            }
            if (url.origin !== location.origin) continue;
            const text = normalize(`${anchor.textContent || ''} ${anchor.getAttribute('title') || ''} ${url.pathname}`);
            if (!/(sojusz|alliance|verband)/.test(text)) continue;
            if (/logout|signout/.test(url.pathname)) continue;
            const key = `${url.origin}${url.pathname}${url.search}`;
            if (!found.has(key)) found.set(key, url.href);
        }
        return [...found.values()].slice(0, 12);
    }

    async function fetchDocument(url) {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'text/html,application/xhtml+xml' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return { doc, finalUrl: response.url || url, html };
    }

    function looksLikeCreatorDocument(doc, url = '') {
        const body = normalize(doc.body?.innerText || doc.body?.textContent || '');
        const path = normalize(url);
        const formCount = doc.querySelectorAll('form').length;
        const inputs = doc.querySelectorAll('input,select,textarea').length;
        const hasAlliance = /(sojusz|alliance|verband)/.test(`${body} ${path}`);
        const hasLargeMission = /(duz[aey]\s+misj|large alliance mission|verbandsgrosseinsatz|grosseinsatz)/.test(`${body} ${path}`);
        const hasCreate = /(utworz|stworz|generuj|zapisz|create|new)/.test(`${body} ${path}`);
        return formCount > 0 && inputs >= 2 && hasAlliance && (hasLargeMission || hasCreate);
    }

    async function discoverCreator(force = false) {
        if (state.discoverBusy) return;
        state.discoverBusy = true;
        const discoverButton = document.getElementById(`${APP_ID}-discover`);
        if (discoverButton) discoverButton.disabled = true;

        try {
            setStatus('Szukam natywnego generatora dużej misji sojuszu…');
            setEmpty('Wykrywam stronę tworzenia dużej misji sojuszu…', true);

            if (!force && state.nativeUrl) {
                loadNativeUrl(state.nativeUrl);
                return;
            }

            const direct = bestCreatorLink(document, location.href);
            if (direct) {
                log('Generator znaleziony bezpośrednio:', direct);
                loadNativeUrl(direct.url);
                return;
            }

            const navPages = allianceNavigationLinks(document, location.href);
            let fallbackAlliancePage = navPages[0] || '';

            for (const pageUrl of navPages.slice(0, 8)) {
                try {
                    const { doc, finalUrl } = await fetchDocument(pageUrl);
                    fallbackAlliancePage ||= finalUrl;

                    const nested = bestCreatorLink(doc, finalUrl);
                    if (nested) {
                        log('Generator znaleziony na stronie sojuszu:', nested);
                        loadNativeUrl(nested.url);
                        return;
                    }

                    if (looksLikeCreatorDocument(doc, finalUrl)) {
                        loadNativeUrl(finalUrl);
                        return;
                    }
                } catch (error) {
                    log('Pominięto stronę podczas wykrywania:', pageUrl, error.message);
                }
            }

            const fallbackPaths = [
                '/alliance_missions/new',
                '/alliance_mission/new',
                '/alliances/missions/new',
                '/alliance/large_missions/new',
                '/verband_grosseinsatz/new',
                '/verband_grosseinsatz'
            ];

            for (const path of fallbackPaths) {
                const url = new URL(path, location.origin).href;
                try {
                    const { doc, finalUrl } = await fetchDocument(url);
                    const nested = bestCreatorLink(doc, finalUrl);
                    if (nested) {
                        loadNativeUrl(nested.url);
                        return;
                    }
                    if (looksLikeCreatorDocument(doc, finalUrl)) {
                        loadNativeUrl(finalUrl);
                        return;
                    }
                } catch {
                    // Kolejna znana konwencja ścieżki.
                }
            }

            state.discoveredAlliancePage = fallbackAlliancePage;
            setStatus('Nie udało się automatycznie ustalić adresu generatora. Wklej adres strony tworzenia dużej misji sojuszu w pole u góry.', 'warning');
            setEmpty('Nie znaleziono natywnego generatora.\nOtwórz w grze tworzenie dużej misji sojuszu, skopiuj adres i wklej go w pole „Natywny generator”.', true);
        } finally {
            state.discoverBusy = false;
            if (discoverButton) discoverButton.disabled = false;
        }
    }

    function useUrlFromInput() {
        const input = document.getElementById(`${APP_ID}-native-url`);
        if (!input) return;
        const url = canonicalUrl(input.value.trim());
        if (!url) {
            setStatus('Podany adres nie jest prawidłowym adresem w domenie Operator Ratunkowy.', 'danger');
            return;
        }
        loadNativeUrl(url);
    }

    function loadNativeUrl(value, options = {}) {
        const url = canonicalUrl(value);
        if (!url) {
            setStatus('Nieprawidłowy adres natywnego generatora.', 'danger');
            return;
        }

        state.nativeUrl = url;
        saveText(STORAGE_URL, url);
        const input = document.getElementById(`${APP_ID}-native-url`);
        if (input) input.value = url;

        const frame = document.getElementById(`${APP_ID}-frame`);
        if (!frame) return;
        setEmpty('Wczytuję natywny formularz gry…', true);
        if (!options.silent) setStatus('Wczytuję natywny formularz dużej misji sojuszu…');

        const current = frame.getAttribute('src') || '';
        if (current === url) {
            try {
                frame.contentWindow.location.reload();
            } catch {
                frame.src = url;
            }
        } else {
            frame.src = url;
        }
    }

    function reloadFrame() {
        const frame = document.getElementById(`${APP_ID}-frame`);
        if (!frame || !state.nativeUrl) {
            setStatus('Najpierw wykryj lub podaj adres generatora.', 'warning');
            return;
        }
        setEmpty('Odświeżam formularz…', true);
        try {
            frame.contentWindow.location.reload();
        } catch {
            frame.src = state.nativeUrl;
        }
    }

    function openNativeInTab() {
        const inputUrl = document.getElementById(`${APP_ID}-native-url`)?.value.trim();
        const url = canonicalUrl(inputUrl || state.nativeUrl || state.discoveredAlliancePage);
        if (!url) {
            setStatus('Brak adresu strony do otwarcia.', 'warning');
            return;
        }
        window.open(url, '_blank', 'noopener');
    }

    function getFrameDocument() {
        const frame = document.getElementById(`${APP_ID}-frame`);
        if (!frame) return null;
        try {
            return frame.contentDocument || frame.contentWindow?.document || null;
        } catch {
            return null;
        }
    }

    function onFrameLoaded() {
        const seq = ++state.frameLoadSeq;
        const frame = document.getElementById(`${APP_ID}-frame`);
        if (!frame) return;

        let doc = getFrameDocument();
        if (!doc) {
            setStatus('Formularz nie może być osadzony w menedżerze. Użyj przycisku „Nowa karta”.', 'warning');
            setEmpty('Ta strona nie pozwala na osadzenie formularza. Otwórz ją przyciskiem „Nowa karta”.', true);
            return;
        }

        setTimeout(() => {
            if (seq !== state.frameLoadSeq) return;
            doc = getFrameDocument();
            if (!doc) return;

            // Nie nadpisujemy zapamiętanego adresu generatora po wysłaniu formularza.
            // Natywny formularz może po utworzeniu misji przejść do strony szczegółów,
            // a przy następnym otwarciu menedżer ma wrócić do generatora, nie do tej misji.
            const actualUrl = canonicalUrl(frame.contentWindow?.location?.href || state.nativeUrl);

            const form = findPrimaryForm(doc);
            setEmpty('', false);

            if (!form) {
                const nested = bestCreatorLink(doc, actualUrl || state.nativeUrl);
                if (nested && nested.url !== actualUrl) {
                    setStatus('Znalazłem przycisk tworzenia misji. Otwieram właściwy formularz…');
                    loadNativeUrl(nested.url, { silent: true });
                    return;
                }
                setStatus('Strona została wczytana, ale nie znalazłem formularza. Wybierz na niej opcję utworzenia dużej misji sojuszu.', 'warning');
                updateSummary();
                return;
            }

            wireFormListeners(doc, form);
            setStatus('Natywny formularz gry jest gotowy. Możesz ustawić misję, zapisać szablon albo skalować wymagania.', 'success');
            updateSummary();
        }, 160);
    }

    function findPrimaryForm(doc) {
        const forms = [...doc.querySelectorAll('form')];
        if (!forms.length) return null;

        let best = null;
        let bestScore = -Infinity;
        for (const form of forms) {
            const text = normalize(form.innerText || form.textContent || '');
            const controls = form.querySelectorAll('input,select,textarea');
            let score = controls.length;
            if (/(sojusz|alliance|verband)/.test(text)) score += 20;
            if (/(misj|mission|einsatz)/.test(text)) score += 20;
            if (/(pojazd|vehicle|fahrzeug|wymagan|required)/.test(text)) score += 12;
            if (controls.length < 2) score -= 20;
            if (score > bestScore) {
                best = form;
                bestScore = score;
            }
        }
        return bestScore >= 2 ? best : null;
    }

    function wireFormListeners(doc, form) {
        if (form.dataset.orAllianceMissionManagerWired === '1') return;
        form.dataset.orAllianceMissionManagerWired = '1';
        form.addEventListener('input', debounceSummary, true);
        form.addEventListener('change', debounceSummary, true);
        doc.addEventListener('click', debounceSummary, true);
    }

    function labelForControl(doc, control) {
        if (!control) return '';
        if (control.id) {
            try {
                const label = doc.querySelector(`label[for="${CSS.escape(control.id)}"]`);
                if (label) return label.textContent.replace(/\s+/g, ' ').trim();
            } catch {
                // Ignoruj nietypowy identyfikator.
            }
        }
        const ownLabel = control.closest('label');
        if (ownLabel) return ownLabel.textContent.replace(/\s+/g, ' ').trim();

        const row = control.closest('tr,.form-group,.field,.control-group,.row,[class*="form-"]');
        if (row) {
            const label = row.querySelector('label,th,.control-label,.help-block,strong,b');
            if (label && label !== control) return label.textContent.replace(/\s+/g, ' ').trim();
        }

        return control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.name || control.id || '';
    }

    function isIgnoredControl(control) {
        if (!control || control.disabled) return true;
        const type = normalize(control.type || '');
        const name = normalize(`${control.name || ''} ${control.id || ''}`);
        if (['submit', 'button', 'reset', 'file', 'password', 'image'].includes(type)) return true;
        if (type === 'hidden') {
            if (/(authenticity|csrf|token|utf8|method)/.test(name)) return true;
            return !/(mission|einsatz|type|vehicle|fahrzeug|lat|lon|lng|location|poi|map)/.test(name);
        }
        return false;
    }

    function controlKey(control) {
        return control.name ? `name:${control.name}` : control.id ? `id:${control.id}` : '';
    }

    function snapshotForm() {
        const doc = getFrameDocument();
        const form = doc && findPrimaryForm(doc);
        if (!doc || !form) throw new Error('Nie znaleziono natywnego formularza misji.');

        const fields = [];
        for (const control of form.querySelectorAll('input,select,textarea')) {
            if (isIgnoredControl(control)) continue;
            const key = controlKey(control);
            if (!key) continue;
            const type = normalize(control.type || control.tagName);
            const item = {
                key,
                tag: control.tagName.toLowerCase(),
                type,
                label: labelForControl(doc, control),
                value: control.value ?? ''
            };
            if (type === 'checkbox' || type === 'radio') item.checked = !!control.checked;
            fields.push(item);
        }

        if (!fields.length) throw new Error('Formularz nie zawiera pól, które można zapisać w szablonie.');
        return {
            savedAt: Date.now(),
            sourceUrl: state.nativeUrl,
            fields
        };
    }

    function findControlBySnapshot(doc, form, item) {
        if (item.key.startsWith('name:')) {
            const name = item.key.slice(5);
            const list = [...form.elements].filter(el => el.name === name);
            if (item.type === 'radio') return list.find(el => String(el.value) === String(item.value)) || list[0] || null;
            return list[0] || null;
        }
        if (item.key.startsWith('id:')) return doc.getElementById(item.key.slice(3));
        return null;
    }

    function setControlValue(control, item) {
        if (!control) return false;
        const type = normalize(control.type || control.tagName);
        if (type === 'checkbox' || type === 'radio') {
            control.checked = !!item.checked;
        } else {
            control.value = item.value == null ? '' : String(item.value);
        }
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function saveCurrentTemplate() {
        const nameInput = document.getElementById(`${APP_ID}-template-name`);
        const select = document.getElementById(`${APP_ID}-template-select`);
        const name = String(nameInput?.value || select?.value || '').trim();
        if (!name) {
            setStatus('Podaj nazwę szablonu.', 'warning');
            nameInput?.focus();
            return;
        }

        try {
            const snapshot = snapshotForm();
            state.templates[name] = snapshot;
            state.activeTemplate = name;
            saveJSON(STORAGE_TEMPLATES, state.templates);
            saveText(STORAGE_LAST_TEMPLATE, name);
            renderTemplates();
            setStatus(`Zapisano szablon „${name}” (${snapshot.fields.length} pól).`, 'success');
        } catch (error) {
            setStatus(error.message || 'Nie udało się zapisać szablonu.', 'danger');
        }
    }

    function applySelectedTemplate() {
        const select = document.getElementById(`${APP_ID}-template-select`);
        const name = select?.value || state.activeTemplate;
        const template = state.templates[name];
        if (!name || !template) {
            setStatus('Wybierz szablon do zastosowania.', 'warning');
            return;
        }

        const doc = getFrameDocument();
        const form = doc && findPrimaryForm(doc);
        if (!doc || !form) {
            setStatus('Nie znaleziono formularza, do którego można zastosować szablon.', 'danger');
            return;
        }

        let applied = 0;
        let skipped = 0;
        for (const item of template.fields || []) {
            const control = findControlBySnapshot(doc, form, item);
            if (control && setControlValue(control, item)) applied++;
            else skipped++;
        }
        state.activeTemplate = name;
        saveText(STORAGE_LAST_TEMPLATE, name);
        updateSummary();
        setStatus(`Zastosowano szablon „${name}”: ${applied} pól${skipped ? `, pominięto ${skipped}` : ''}.`, skipped ? 'warning' : 'success');
    }

    function deleteSelectedTemplate() {
        const select = document.getElementById(`${APP_ID}-template-select`);
        const name = select?.value;
        if (!name || !state.templates[name]) {
            setStatus('Wybierz szablon do usunięcia.', 'warning');
            return;
        }
        if (!confirm(`Usunąć szablon „${name}”?`)) return;
        delete state.templates[name];
        if (state.activeTemplate === name) state.activeTemplate = '';
        saveJSON(STORAGE_TEMPLATES, state.templates);
        saveText(STORAGE_LAST_TEMPLATE, state.activeTemplate);
        renderTemplates();
        document.getElementById(`${APP_ID}-template-name`).value = '';
        setStatus(`Usunięto szablon „${name}”.`, 'success');
    }

    function renderTemplates() {
        const select = document.getElementById(`${APP_ID}-template-select`);
        if (!select) return;
        const names = Object.keys(state.templates).sort((a, b) => a.localeCompare(b, 'pl', { sensitivity: 'base', numeric: true }));
        select.innerHTML = '<option value="">— wybierz —</option>' + names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
        if (state.activeTemplate && state.templates[state.activeTemplate]) select.value = state.activeTemplate;
    }

    function requirementSignature(doc, control) {
        return normalize(`${control.name || ''} ${control.id || ''} ${labelForControl(doc, control)}`);
    }

    function isVehicleRequirementControl(doc, control) {
        if (!control || control.disabled) return false;
        const type = normalize(control.type || '');
        if (type !== 'number' && type !== 'text' && type !== 'range') return false;

        const signature = requirementSignature(doc, control);
        if (!signature) return false;

        const excluded = [
            'pacjent', 'patient', 'kredyt', 'credit', 'coin', 'czas', 'time', 'minut', 'hour',
            'lat', 'lon', 'lng', 'latitude', 'longitude', 'promien', 'radius', 'distance',
            'pozyc', 'position', 'nagrod', 'reward', 'wartosc', 'value max', 'water', 'woda', 'foam', 'piana'
        ];
        if (excluded.some(token => signature.includes(token))) return false;

        const included = [
            'pojazd', 'vehicle', 'fahrzeug', 'wymagan', 'required', 'requirement', 'potrzeb',
            'firetruck', 'ambulance', 'radiowoz', 'police', 'straz', 'straż', 'rettungswagen',
            'lf ', 'rtw', 'stw', 'gw-', 'elw', 'dlk', 'aao', 'vehicle_type'
        ];
        return included.some(token => signature.includes(normalize(token)));
    }

    function requirementControls() {
        const doc = getFrameDocument();
        const form = doc && findPrimaryForm(doc);
        if (!doc || !form) return { doc: null, controls: [] };
        const controls = [...form.querySelectorAll('input[type="number"],input[type="text"],input[type="range"]')]
            .filter(control => isVehicleRequirementControl(doc, control));
        return { doc, controls };
    }

    function numericValue(control) {
        const raw = String(control.value ?? '').replace(',', '.').trim();
        if (!raw) return 0;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    function assignNumeric(control, value) {
        let next = Number(value);
        if (!Number.isFinite(next)) return false;
        const min = control.min !== '' ? Number(control.min) : null;
        const max = control.max !== '' ? Number(control.max) : null;
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);
        control.value = String(next);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function scaleRequirements(factor) {
        if (!Number.isFinite(factor) || factor <= 0 || factor > 20) {
            setStatus('Mnożnik musi być liczbą większą od 0 i nie większą niż 20.', 'warning');
            return;
        }
        const { controls } = requirementControls();
        if (!controls.length) {
            setStatus('Nie rozpoznałem żadnych pól wymagań pojazdów w tym formularzu.', 'warning');
            return;
        }

        let changed = 0;
        for (const control of controls) {
            const current = numericValue(control);
            if (current == null || current <= 0) continue;
            const next = Math.ceil(current * factor);
            if (next !== current && assignNumeric(control, next)) changed++;
        }
        updateSummary();
        setStatus(`Przeskalowano ${changed} pól wymagań pojazdów mnożnikiem ×${String(factor).replace('.', ',')}.`, changed ? 'success' : 'warning');
    }

    function clearRequirements() {
        const { controls } = requirementControls();
        if (!controls.length) {
            setStatus('Nie rozpoznałem żadnych pól wymagań pojazdów w tym formularzu.', 'warning');
            return;
        }
        if (!confirm(`Wyzerować ${controls.length} wykrytych pól wymagań pojazdów?`)) return;
        let changed = 0;
        for (const control of controls) {
            const current = numericValue(control);
            if (current != null && current !== 0 && assignNumeric(control, 0)) changed++;
        }
        updateSummary();
        setStatus(`Wyzerowano ${changed} pól wymagań pojazdów.`, 'success');
    }

    function updateSummary() {
        const summary = document.getElementById(`${APP_ID}-summary`);
        if (!summary) return;

        const doc = getFrameDocument();
        const form = doc && findPrimaryForm(doc);
        if (!doc || !form) {
            summary.textContent = 'Nie znaleziono aktywnego formularza misji.';
            return;
        }

        const rows = [];
        const seen = new Set();
        for (const control of form.querySelectorAll('input,select,textarea')) {
            if (isIgnoredControl(control)) continue;
            const type = normalize(control.type || control.tagName);
            if (type === 'radio' && !control.checked) continue;
            if (type === 'checkbox' && !control.checked) continue;

            let value = control.value ?? '';
            if (type === 'checkbox') value = 'Tak';
            if (control.tagName === 'SELECT') {
                value = control.selectedOptions?.[0]?.textContent?.trim() || value;
            }
            const textValue = String(value).trim();
            if (!textValue || textValue === '0' || textValue === '0.0') continue;

            const label = labelForControl(doc, control) || control.name || control.id || 'Pole';
            const key = `${normalize(label)}|${textValue}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ label, value: textValue, requirement: isVehicleRequirementControl(doc, control) });
            if (rows.length >= 60) break;
        }

        const requirements = rows.filter(row => row.requirement);
        const others = rows.filter(row => !row.requirement);
        const ordered = [...requirements, ...others];
        if (!ordered.length) {
            summary.textContent = 'Formularz jest pusty lub wszystkie wartości są zerowe.';
            return;
        }

        summary.innerHTML = ordered.map(row => `
            <div class="or-ams-summary-row">
                <span class="or-ams-summary-label">${row.requirement ? '🚒 ' : ''}${escapeHTML(row.label)}:</span>
                ${escapeHTML(row.value)}
            </div>`).join('');
    }

    function registerMenu() {
        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('Otwórz Generator Misji Sojuszu', openManager);
            }
        } catch (error) {
            log('Nie udało się zarejestrować menu Tampermonkey:', error);
        }
    }

    function init() {
        ensureStyles();
        createLauncher();
        createUI();
        registerMenu();

        window.addEventListener('resize', schedulePositioning);
        const observer = new MutationObserver(schedulePositioning);
        observer.observe(document.body, { childList: true, subtree: true });

        state.sizeTimer = setInterval(() => {
            const launcher = document.getElementById(`${APP_ID}-launcher`);
            if (!launcher) createLauncher();
            schedulePositioning();
        }, 2500);

        log(`Uruchomiono v${VERSION}.`);
    }

    init();
})();
