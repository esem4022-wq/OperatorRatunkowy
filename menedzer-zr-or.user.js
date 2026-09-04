// ==UserScript==
// @name         Menedżer ZR OR
// @namespace    https://www.operatorratunkowy.pl/
// @version      3.15.16
// @description  Tworzenie ZR z aktualnie otwartej misji – przycisk w nagłówku misji.
// @author       ChatGPT + użytkownik
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zr-or.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zr-or.user.js
// @match        https://www.operatorratunkowy.pl/*
// @match        https://operatorratunkowy.pl/*
// @match        https://policja.operatorratunkowy.pl/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      operatorratunkowy.pl
// @connect      www.operatorratunkowy.pl
// @connect      policja.operatorratunkowy.pl
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    const TAG = '[OR Menedżer ZR]';
    const VERSION = '3.15.16';
    const CAPTURE_KEY = 'or_zr_capture_v31516';
    const MAP_KEY = 'or_zr_map_v020';

    const state = {
        capture: loadJSON(CAPTURE_KEY, null),
        map: loadJSON(MAP_KEY, {}),
        fields: [],
        aaosPromise: null,
        aaosLoadedAt: 0,
        aaoCategoriesPromise: null,
        aaoCategoriesLoadedAt: 0,
        azrCategoryId: null,
        autoSelectBusy: false,
        autoSelectMissionKey: '',
        autoSelectFirstSeenAt: 0,
        autoSelectRetryTimer: null,
        autoSelectAttempts: 0,
        // Po skutecznym wyborze zapamiętujemy konkretną misję i ZR.
        // MutationObserver może wtedy zmieniać DOM dowolną liczbę razy bez
        // ponownego klikania tej samej ZR i migania komunikatu.
        autoSelectCompletedMissionKey: '',
        autoSelectCompletedAAOId: null,
        autoSelectCompletedTargetName: '',
        autoSelectCompletedState: '',
        azrLookupState: 'idle',
        azrLookupMissionKey: '',
        azrLookupTargetName: '',
        azrLookupTargetId: null
    };

    function log(...args) {
        console.log(TAG, ...args);
    }

    function loadJSON(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (raw == null) return fallback;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    function normalize(text) {
        return String(text ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            // `ł`/`Ł` nie rozkłada się w NFD do `l` + znak diakrytyczny.
            // Bez jawnej zamiany filtry typu `Wydziały Ruchu Drogowego`
            // nie pasowały do wersji ASCII `wydzialy ...`.
            .replace(/ł/g, 'l')
            .replace(/\u00a0/g, ' ')
            .replace(/[\/|]/g, ' lub ')
            .replace(/[()[\]{},.:;!?]/g, ' ')
            .replace(/[\-\u058A\u05BE\u1400\u1806\u2010-\u2015\u2E17\u2E1A\u2E3A-\u2E3B\u2E40\u301C\u3030\u30A0\uFE31-\uFE32\uFE58\uFE63\uFF0D\u2212]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanLines(text) {
        return String(text ?? '')
            .replace(/\u00a0/g, ' ')
            .split(/\r?\n/)
            .map(x => x.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    function isVisible(el) {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10 &&
            r.bottom > 0 && r.right > 0 &&
            r.top < innerHeight && r.left < innerWidth;
    }

    function isDisplayedInInterface(el) {
        if (!el || !el.isConnected) return false;
        let node = el;
        while (node && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
            node = node.parentElement;
        }
        return true;
    }

    function parseIntLoose(text) {
        const m = String(text ?? '').match(/\d[\d\s.]*/);
        if (!m) return null;
        const digits = m[0].replace(/[^\d]/g, '');
        return digits ? Number.parseInt(digits, 10) : null;
    }

    // ------------------------------------------------------------------
    // WYKRYWANIE NAGŁÓWKA MISJI
    // ------------------------------------------------------------------

    function isDarkColor(rgb) {
        const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        return (r * 0.299 + g * 0.587 + b * 0.114) < 110;
    }

    function findMissionHeader() {
        const candidates = [];

        for (const el of document.querySelectorAll('div,header,section')) {
            if (!isVisible(el)) continue;

            const r = el.getBoundingClientRect();
            if (r.top > 100 || r.height < 45 || r.height > 105 || r.width < 700) continue;

            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 500) continue;

            const cs = getComputedStyle(el);
            let score = 0;

            if (isDarkColor(cs.backgroundColor)) score += 10;
            if (r.top <= 10) score += 5;
            if (r.width > innerWidth * 0.7) score += 5;
            if (/minut|dzis|wczoraj/i.test(text)) score += 3;

            // Nagłówek misji zwykle zawiera nazwę dużymi literami.
            if (/[A-ZĄĆĘŁŃÓŚŹŻ]{4,}/.test(text)) score += 4;

            candidates.push({ el, score, area: r.width * r.height });
        }

        candidates.sort((a, b) => b.score - a.score || a.area - b.area);
        return candidates[0]?.score >= 10 ? candidates[0].el : null;
    }


    function findOpenedMissionHeader() {
        const candidates = [];

        for (const el of document.querySelectorAll('div,header,section')) {
            if (!isVisible(el)) continue;

            const r = el.getBoundingClientRect();

            // Nagłówek otwartej misji jest szeroki, niski i znajduje się przy górnej krawędzi.
            if (r.top > 120 || r.height < 45 || r.height > 110 || r.width < innerWidth * 0.65) continue;

            const text = (el.innerText || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!text || text.length > 600) continue;

            const n = normalize(text);
            const cs = getComputedStyle(el);

            // Charakterystyczny tekst nagłówka misji:
            // "4 minuty temu (Dziś o 11:44)", "godzinę temu", "Wczoraj o..."
            const hasTimeMeta =
                /\btemu\b/i.test(text) ||
                /\bDziś o\b/i.test(text) ||
                /\bDzis o\b/i.test(text) ||
                /\bWczoraj o\b/i.test(text);

            if (!hasTimeMeta) continue;
            if (!isDarkColor(cs.backgroundColor)) continue;

            // Szukamy przycisku zamknięcia "x/×" w samym nagłówku lub tuż obok.
            let hasClose = false;

            for (const child of el.querySelectorAll('button,a,span,i')) {
                const t = (child.textContent || '').trim();
                const cls = `${child.className || ''} ${child.id || ''}`.toLowerCase();

                if (
                    t === '×' ||
                    t.toLowerCase() === 'x' ||
                    cls.includes('close') ||
                    cls.includes('mission_close') ||
                    cls.includes('mission-close')
                ) {
                    hasClose = true;
                    break;
                }
            }

            // Czasem X jest rodzeństwem nagłówka.
            if (!hasClose && el.parentElement) {
                for (const child of el.parentElement.querySelectorAll(':scope > button, :scope > a, :scope > span')) {
                    const t = (child.textContent || '').trim();
                    const cls = `${child.className || ''} ${child.id || ''}`.toLowerCase();

                    if (t === '×' || t.toLowerCase() === 'x' || cls.includes('close')) {
                        hasClose = true;
                        break;
                    }
                }
            }

            let score = 0;
            if (hasClose) score += 20;
            if (/\btemu\b/i.test(text)) score += 10;
            if (/\b(?:Dziś|Dzis|Wczoraj)\s+o\b/i.test(text)) score += 10;
            if (/[A-ZĄĆĘŁŃÓŚŹŻ]{4,}/.test(text)) score += 5;
            if (r.top < 20) score += 5;

            candidates.push({ el, score, area: r.width * r.height, hasClose });
        }

        candidates.sort((a, b) => b.score - a.score || a.area - b.area);

        // Wymagamy wysokiego wyniku, żeby na stronie głównej nie złapać paska nawigacji.
        const best = candidates[0];
        if (!best || best.score < 20) return null;

        return best.el;
    }

    function isMissionNameNoise(value) {
        const text = String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) return true;

        // Komunikat gry o zmianie misji nie jest nazwą misji.
        if (/^Misja\s+zaktualizowana!?\s*Odśwież!?$/i.test(text)) return true;
        if (/^Misja\s+zaktualizowana!?\s*Odswiez!?$/i.test(text)) return true;

        // Metadane czasu z nagłówka misji nigdy nie są nazwą ZR.
        if (/^\d+\s+(?:sekund(?:a|y|ę)?|minut(?:a|y|ę)?|godzin(?:a|y|ę)?)\s+temu(?:\s*\([^)]*\))?$/i.test(text)) return true;
        if (/^(?:godzinę|godzine|chwilę|chwile)\s+temu(?:\s*\([^)]*\))?$/i.test(text)) return true;
        if (/^(?:Dziś|Dzis|Wczoraj)\s+o\s+\d{1,2}:\d{2}$/i.test(text)) return true;
        if (/\b(?:Dziś|Dzis|Wczoraj)\s+o\s+\d{1,2}:\d{2}\b/i.test(text) && /\btemu\b/i.test(text)) return true;

        const n = normalize(text);
        if ([
            'pojazdy', 'pacjenci', 'woda', 'piana',
            'utworz zr', 'zaznaczono zr'
        ].includes(n)) return true;

        return false;
    }

    function findMissionTitleElement(header) {
        if (!header) return null;

        const candidates = [...header.querySelectorAll('h1,h2,h3,h4,strong,span,div')];
        const hr = header.getBoundingClientRect();

        let best = null;
        let bestScore = -999;

        for (const el of candidates) {
            if (!isVisible(el)) continue;

            // v0.32: nasze własne przyciski/status nie mogą być nigdy uznane
            // za nazwę misji. To powodowało m.in. nazwę "+ UTWÓRZ ZR💾"
            // i losowe problemy z automatycznym wyborem istniejącej ZR.
            if (
                el.closest('#orzr-header-actions') ||
                el.closest('#orzr-auto-select-status') ||
                String(el.id || '').startsWith('orzr-')
            ) continue;

            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length < 4 || text.length > 220) continue;
            if (/UTWÓRZ\s+ZR|UTWORZ\s+ZR|Zaznaczono\s+ZR/i.test(text)) continue;
            if (isMissionNameNoise(text)) continue;

            const r = el.getBoundingClientRect();
            if (r.height > 100 || r.width < 80) continue;

            let score = 0;

            const fs = Number.parseFloat(getComputedStyle(el).fontSize) || 0;
            score += fs;

            if (/[A-ZĄĆĘŁŃÓŚŹŻ]{4,}/.test(text)) score += 10;
            if (/minut|dzis|wczoraj|godzinę|godzine/i.test(text)) score -= 20;

            // Tytuł misji jest po lewej stronie ciemnego nagłówka. Przyciski
            // Menedżera i pasek postępu są znacznie dalej na prawo.
            const centerX = r.left + r.width / 2;
            if (centerX < hr.left + hr.width * 0.45) score += 16;
            if (centerX > hr.left + hr.width * 0.65) score -= 18;

            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }

        return best;
    }

    // ------------------------------------------------------------------
    // ODCZYT MISJI
    // ------------------------------------------------------------------

    function getOpenedMissionName() {
        const header = findOpenedMissionHeader();
        const title = findMissionTitleElement(header);
        return sanitizeMissionName(title?.textContent || '');
    }

    function missionCardCandidateScore(el, missionName) {
        if (!el || !isVisible(el)) return -9999;

        const r = el.getBoundingClientRect();
        if (r.width < 280 || r.height < 70) return -9999;

        const raw = (el.innerText || el.textContent || '')
            .replace(/\u00a0/g, ' ')
            .trim();
        const text = raw.replace(/\s+/g, ' ').trim();

        if (!text || text.length < 10 || text.length > 12000) return -9999;
        if (!/\bPojazdy\b/i.test(text)) return -9999;
        if (!/\b\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(text)) return -9999;

        let score = 0;
        const ntext = normalize(text);
        const nname = normalize(missionName);

        if (nname && ntext.includes(nname)) score += 50;
        if (el.matches?.('.alert-warning,.panel-warning,.alert,.panel,.well')) score += 18;
        if (/\bPacjenci\b/i.test(text)) score += 5;
        if (/\bMoże się rozwinąć|\bMoze sie rozwinac/i.test(text)) score += 4;
        if (/\bWoda\b|\bPiana\b/i.test(text)) score += 4;
        if (r.left > innerWidth * 0.30) score += 5;

        // Duży kontener obejmujący także listę jednostek jest mniej pożądany,
        // ale NIE dyskwalifikujemy go — potrafimy później wyciąć samą kartę.
        if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(text)) score -= 20;

        score -= Math.floor(text.length / 900);
        return score;
    }

    function findExactMissionCardByTitle() {
        const missionName = getOpenedMissionName();
        const wanted = normalize(missionName);
        if (!wanted) return null;

        const openedHeader = findOpenedMissionHeader();
        const titleCandidates = document.querySelectorAll(
            'h1,h2,h3,h4,h5,strong,.panel-title,.modal-title,[class*="mission"][class*="title"],[class*="caption"]'
        );

        const cards = [];

        for (const titleEl of titleCandidates) {
            if (!isVisible(titleEl)) continue;
            if (openedHeader?.contains(titleEl)) continue;

            const titleText = sanitizeMissionName(titleEl.textContent || '');
            if (normalize(titleText) !== wanted) continue;

            let cur = titleEl;
            for (let depth = 0; depth < 9 && cur; depth++, cur = cur.parentElement) {
                if (!isVisible(cur)) continue;

                const raw = (cur.innerText || cur.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .trim();
                const compact = raw.replace(/\s+/g, ' ').trim();

                if (!/\bPojazdy\b/i.test(compact)) continue;

                // Najbliższy przodek zawierający tytuł + sekcję Pojazdy jest
                // zdecydowanie najpewniejszą żółtą kartą bieżącej misji.
                const containsUnits = /\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(compact);
                const r = cur.getBoundingClientRect();
                let score = 100 - depth * 8;
                if (!containsUnits) score += 40;
                if (r.left > innerWidth * 0.30) score += 10;
                if (/\bPacjenci\b/i.test(compact)) score += 3;
                if (/\bMoże się rozwinąć\b|\bMoze sie rozwinac\b/i.test(compact)) score += 2;

                cards.push({ el: cur, score, len: compact.length });
                break;
            }
        }

        cards.sort((a, b) => b.score - a.score || a.len - b.len);
        return cards[0]?.el || null;
    }

    function isPaleMissionCardBackground(el) {
        if (!el) return false;
        const bg = getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return false;

        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);

        // Żółta karta Operatora ma bardzo jasne tło. Nie wymagamy dokładnego
        // koloru, bo motywy mogą go lekko zmieniać.
        return r >= 220 && g >= 210 && b >= 170 && r >= b && g >= b;
    }

    function findVisibleVehiclesHeading() {
        const selectors = 'h1,h2,h3,h4,h5,h6,p,span,strong,b,div,dt,dd';
        const candidates = [];

        for (const el of document.querySelectorAll(selectors)) {
            if (!isVisible(el)) continue;

            const ownText = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (normalize(ownText) !== 'pojazdy') continue;

            const rect = el.getBoundingClientRect();
            let score = 0;

            // Karta wymagań znajduje się po prawej stronie okna misji.
            if (rect.left > innerWidth * 0.35) score += 30;
            if (rect.top > 50 && rect.top < innerHeight * 0.85) score += 8;

            const fs = Number.parseFloat(getComputedStyle(el).fontSize) || 0;
            score += Math.min(fs, 30);

            candidates.push({ el, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
    }

    function findMissionCardFromVehiclesHeading() {
        const heading = findVisibleVehiclesHeading();
        if (!heading) return null;

        const missionName = getOpenedMissionName();
        const wantedName = normalize(missionName);
        const candidates = [];

        let cur = heading;

        for (let depth = 0; depth < 10 && cur; depth++, cur = cur.parentElement) {
            if (!isVisible(cur)) continue;

            const rect = cur.getBoundingClientRect();
            if (rect.width < 280 || rect.height < 70) continue;

            const raw = (cur.innerText || cur.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            const compact = raw.replace(/\s+/g, ' ').trim();

            if (!/\bPojazdy\b/i.test(compact)) continue;

            // Jeżeli wspięliśmy się aż do kontenera z listą dostępnych jednostek,
            // wyszliśmy poza właściwą żółtą kartę.
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(compact)) {
                continue;
            }

            const afterVehicles = compact.replace(/^.*?\bPojazdy\b/i, '').trim();
            if (!/\b\d+\s+\S+/.test(afterVehicles)) continue;

            let score = 100 - depth * 4;

            if (wantedName && normalize(compact).includes(wantedName)) score += 45;
            if (isPaleMissionCardBackground(cur)) score += 30;
            if (/\bPacjenci\b/i.test(compact)) score += 5;
            if (/\bMoże się rozwinąć\b|\bMoze sie rozwinac\b/i.test(compact)) score += 4;
            if (rect.left > innerWidth * 0.30) score += 10;

            // Karta ma być lokalnym, nie ogromnym kontenerem.
            score -= Math.floor(compact.length / 1200);

            candidates.push({ el: cur, score, len: compact.length });
        }

        candidates.sort((a, b) => b.score - a.score || a.len - b.len);
        return candidates[0]?.el || null;
    }

    function findMissionInfoBlock() {
        // v0.29: najpewniejszym punktem zaczepienia jest widoczny nagłówek
        // "Pojazdy" w żółtej karcie. Nie wymagamy już, aby przeglądarka
        // umieściła nazwę misji i sekcję Pojazdy w tym samym podkontenerze.
        const headingCard = findMissionCardFromVehiclesHeading();
        if (headingCard) {
            log('Karta misji znaleziona po nagłówku Pojazdy:', headingCard, headingCard.innerText);
            return headingCard;
        }

        const exactCard = findExactMissionCardByTitle();
        if (exactCard) {
            log('Dokładnie dopasowana karta aktualnej misji:', exactCard, exactCard.innerText);
            return exactCard;
        }

        const missionName = getOpenedMissionName();
        const candidates = [];
        const seen = new Set();

        const selectors = [
            '.alert-warning', '.panel-warning', '.alert', '.panel', '.well',
            '[class*="mission"]', '[id*="mission"]',
            'section', 'article', 'aside', 'div'
        ];

        for (const selector of selectors) {
            let elements = [];
            try { elements = [...document.querySelectorAll(selector)]; } catch {}

            for (const el of elements) {
                if (seen.has(el)) continue;
                seen.add(el);

                const score = missionCardCandidateScore(el, missionName);
                if (score <= -9999) continue;

                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                candidates.push({ el, score, len: text.length });
            }
        }

        candidates.sort((a, b) => b.score - a.score || a.len - b.len);

        let chosen = candidates[0]?.el || null;

        // Jeśli najmniejszy znaleziony element nie zawiera nazwy misji,
        // spróbuj wejść po rodzicach do właściwej żółtej karty.
        if (chosen && missionName) {
            let cur = chosen;
            for (let i = 0; i < 7 && cur; i++, cur = cur.parentElement) {
                if (!isVisible(cur)) continue;
                const text = (cur.innerText || cur.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (
                    normalize(text).includes(normalize(missionName)) &&
                    /\bPojazdy\b/i.test(text)
                ) {
                    // Preferuj pierwszy możliwie mały kontener zawierający nazwę + Pojazdy.
                    chosen = cur;
                    break;
                }
            }
        }

        if (chosen) log('Pole informacji o misji:', chosen, chosen.innerText);
        return chosen;
    }

    function getMissionCardText(block, missionName = '') {
        if (!block) return '';

        let text = (block.innerText || block.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) return '';

        const name = sanitizeMissionName(missionName || getOpenedMissionName());
        if (name) {
            const pos = normalize(text).indexOf(normalize(name));
            if (pos >= 0) {
                // index w normalize() nie zawsze jest 1:1 dla znaków diakrytycznych,
                // więc najpierw próbujemy zwykłego wyszukania bez uwzględniania wielkości liter.
                const direct = text.toLocaleLowerCase('pl-PL').indexOf(name.toLocaleLowerCase('pl-PL'));
                if (direct >= 0) text = text.slice(direct);
            }
        }

        // Nawet jeżeli znaleziony blok jest szerszy, wszystko po tej sekcji
        // nie należy już do żółtej karty wymagań.
        const stopPatterns = [
            /\s+Dostępne jednostki\b/i,
            /\s+Dostepne jednostki\b/i,
            /\s+Alarmowo\b/i
        ];
        let cut = text.length;
        for (const re of stopPatterns) {
            const m = re.exec(text);
            if (m && m.index < cut) cut = m.index;
        }

        return text.slice(0, cut).trim();
    }

    function missionInfoBlockMatchesCurrentMission(block) {
        if (!block) return false;

        const cardText = getMissionCardText(block);
        if (!cardText || !/\bPojazdy\b/i.test(cardText)) return false;

        // v0.29: nie wymagamy już zgodności tytułu karty z ciemnym nagłówkiem.
        // W części misji tytuł i lista pojazdów są w osobnych podkontenerach,
        // mimo że wizualnie tworzą jedną żółtą kartę.
        //
        // Bezpieczeństwo zapewniają:
        // - wybór widocznej sekcji "Pojazdy" po prawej stronie,
        // - odcięcie "Dostępne jednostki",
        // - brak pobierania danych z linków "Może się rozwinąć w...".
        const segment = getVehiclesTextSegment(block);

        return /\b\d+\s+\S+/.test(segment || '');
    }

    function exactMissionTitleFromGame() {
        // Najpewniejsze źródło tytułu w LSS/Operatorze. Ten atrybut zawiera
        // wyłącznie nazwę bieżącej misji, bez czasu, komunikatów i danych karty.
        const selectors = [
            '#mission_general_info[data-mission-title]',
            '[id="mission_general_info"][data-mission-title]',
            '[data-mission-title]'
        ];

        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (!el.isConnected) continue;
                const raw = String(el.getAttribute('data-mission-title') || '').trim();
                const name = sanitizeMissionName(raw);
                if (name && !isMissionNameNoise(name)) return name;
            }
        }
        return '';
    }

    function sanitizeMissionName(value) {
        let text = String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/^[*✱✳✽❉🔥🚑🚒🚓\s]+/, '')
            .replace(/\s+/g, ' ')
            .trim();

        // Powiadomienie „Misja zaktualizowana! Odśwież!” bywa w tym samym
        // kontenerze co właściwy tytuł. Usuwamy je zanim zaczniemy ocenę nazwy.
        text = text
            .replace(/\bMisja\s+zaktualizowana!?\s*Odśwież!?\b/gi, ' ')
            .replace(/\bMisja\s+zaktualizowana!?\s*Odswiez!?\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text || isMissionNameNoise(text)) return '';

        // Dane, które czasami znajdują się w tym samym kontenerze co nazwa,
        // ale NIE są częścią nazwy misji.
        const cutPatterns = [
            /\s+POI\b/i,
            /\s+Pojazdy\b/i,
            /\s+Pacjenci\b/i,
            /\s+Może się rozwinąć\b/i,
            /\s+Moze sie rozwinac\b/i,
            /\s+Minimum pacjent(?:ów|ow)\b/i,
            /\s+Maksimum pacjent(?:ów|ow)\b/i,
            /\s+Potrzebna woda\b/i,
            /\s+Wymagana woda\b/i,
            /\s+Wymagana piana\b/i,
            /\s+Dostępne jednostki\b/i,
            /\s+Dostepne jednostki\b/i,
            /\s+Misja\s+zaktualizowana!?\s*Odśwież!?/i,
            /\s+Misja\s+zaktualizowana!?\s*Odswiez!?/i
        ];

        let cut = text.length;
        for (const re of cutPatterns) {
            const m = re.exec(text);
            if (m && m.index < cut) cut = m.index;
        }

        text = text.slice(0, cut).replace(/\s+/g, ' ').trim();

        // Metadane czasu/lokalizacji z nagłówka nie mogą wejść do nazwy.
        text = text
            .replace(/\s*[|•]\s*\d+\s+(?:sekund(?:y|ę)?|minut(?:y|ę)?|godzin(?:y|ę)?)\s+temu.*$/i, '')
            .replace(/\s*\(?(?:Dziś|Dzis|Wczoraj)\s+o\s+\d{1,2}:\d{2}\)?\s*$/i, '')
            .trim();

        if (!text || isMissionNameNoise(text)) return '';
        return text;
    }

    function getMissionName(infoBlock) {
        const exactTitle = exactMissionTitleFromGame();
        if (exactTitle) return exactTitle;

        // v0.42: ciemny nagłówek otwartej misji jest pierwszym fallbackiem.
        // Dzięki temu długie tytuły łamane na dwie linie nie są mylone z
        // dodatkowymi etykietami z żółtej karty (np. „Centrum handlowe”).
        const openedHeader = findOpenedMissionHeader();
        const openedTitle = findMissionTitleElement(openedHeader);
        if (openedTitle) {
            const name = sanitizeMissionName(openedTitle.textContent);
            if (name && !isMissionNameNoise(name)) return name;
        }

        // Fallback: tytuł z żółtej karty.
        if (infoBlock) {
            const headings = infoBlock.querySelectorAll(
                'h1,h2,h3,h4,h5,.panel-title,.modal-title,[class*="mission"][class*="title"],strong'
            );

            for (const h of headings) {
                const raw = (h.textContent || '').replace(/\s+/g, ' ').trim();
                if (isMissionNameNoise(raw)) continue;

                const name = sanitizeMissionName(raw);
                const n = normalize(name);

                if (!name) continue;
                if (['pojazdy', 'pacjenci', 'woda', 'piana'].includes(n)) continue;
                if (/^\d+\s+/.test(name)) continue;

                return name;
            }

            // Ostatni fallback dla żółtej karty: wszystko przed „Pojazdy”.
            const compact = (infoBlock.innerText || infoBlock.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const m = compact.match(/^(.+?)\s+Pojazdy\b/i);
            if (m) {
                const name = sanitizeMissionName(m[1]);
                if (name && !isMissionNameNoise(name)) return name;
            }
        }

        // Ostatni fallback - starsza metoda wyszukania nagłówka.
        const header = findMissionHeader();
        const title = findMissionTitleElement(header);
        if (title) {
            const name = sanitizeMissionName(title.textContent);
            if (name && !isMissionNameNoise(name)) return name;
        }

        return 'Misja bez nazwy';
    }

    function parseChanceFromLabel(label) {
        const m = String(label).match(/\((\d+)\s*%\)\s*$/);
        return m ? Number.parseInt(m[1], 10) : null;
    }

    function cleanVehicleLabel(label) {
        return String(label)
            .replace(/\s*\(\d+\s*%\)\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function looksLikeVehicleLabel(label) {
        const raw = String(label || '').trim();
        const n = normalize(raw);

        if (!n || n.length < 2 || n.length > 150) return false;

        // v3.15.06: nazwa wymagania pojazdu musi zawierać co najmniej jedną
        // literę. Wcześniej techniczny fragment DOM typu `10` mógł przejść
        // walidację i pojawić się jako wymaganie `10` z przypadkową ilością.
        if (!/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(raw)) return false;

        const bad = [
            'minut',
            'kredyt',
            'pacjent',
            'posterunk',
            'dostepne jednostki',
            'alarmowo',
            'moze sie rozwinac',
            'woda',
            'piana',
            'inne informacje',
            'wartosc maks',
            'wartosc',
            'srednie kredyty',
            'rodzaj misji',
            // v3.15.13: wymaganie posiadania WRD jest warunkiem uruchomienia
            // misji, a nie pojazdem do wysłania. Nigdy nie może trafić do ZR.
            'wydzial ruchu drogowego',
            'wydzialy ruchu drogowego'
        ];

        if (bad.some(x => n.includes(x))) return false;

        // Czasy dojazdu z listy dostępnych pojazdów: "min 50 s", "02 min 05 s".
        if (/\b(?:\d+\s+)?min\s+\d+\s*s\b/i.test(raw)) return false;

        // Nazwy jednostek/pojazdów użytkownika zawierające kody typu [R09], [S16], [K04].
        // Takie ciągi nie są nazwami wymagań misji.
        if (/\[[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]*\d+[^\]]*\]/.test(raw)) return false;

        // Typowy format nazw własnych pojazdów użytkownika, np.
        // "P[07-R09]01-01 ..." / "SRWys[06-S16]..."
        if (/^[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{1,12}\[[^\]]+\]/.test(raw)) return false;

        return true;
    }

    function addVehicle(result, map, label, count, chance = null) {
        label = cleanVehicleLabel(label);
        if (!count || !looksLikeVehicleLabel(label)) return;

        const key = normalize(label);
        const prev = map.get(key);

        if (prev) {
            prev.count = Math.max(prev.count, count);
            if (prev.chance == null && chance != null) prev.chance = chance;
            return;
        }

        const item = {
            kind: 'vehicle',
            label,
            count,
            chance
        };

        map.set(key, item);
        result.push(item);
    }

    function extractVehiclesFromDom(block) {
        const result = [];
        const map = new Map();

        if (!block) return result;

        // Najpierw próbujemy czytać najmniejsze elementy DOM.
        const nodes = block.querySelectorAll(
            'li,p,span,div,td,dd,strong,b,[class*="vehicle"],[class*="require"]'
        );

        for (const el of nodes) {
            const text = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!text || text.length > 180) continue;

            // Jeżeli potomny element ma dokładnie ten sam tekst, użyjemy potomka,
            // żeby nie dublować wyniku.
            const sameChild = [...el.children].some(ch => {
                const ct = (ch.innerText || ch.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                return ct === text;
            });
            if (sameChild) continue;

            const m = text.match(/^(\d+)\s+(.+?)$/);
            if (!m) continue;

            const count = Number.parseInt(m[1], 10);
            const rawLabel = m[2].trim();
            const chance = parseChanceFromLabel(rawLabel);

            addVehicle(result, map, rawLabel, count, chance);
        }

        return result;
    }

    function getVehiclesTextSegment(block) {
        const text = getMissionCardText(block)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const start = text.search(/\bPojazdy\b/i);
        if (start < 0) return '';

        let segment = text.slice(start).replace(/^\s*Pojazdy\s*/i, '');

        // Kończymy przed kolejną sekcją.
        const stops = [
            /\s+Może się rozwinąć\b/i,
            /\s+Moze sie rozwinac\b/i,
            /\s+Pacjenci\b/i,
            /\s+Personel\b/i,
            /\s+Potrzebna woda\b/i,
            /\s+Wymagana woda\b/i,
            /\s+Woda\b/i,
            /\s+Wymagana piana\b/i,
            /\s+Piana\b/i,
            /\s+Dostępne jednostki\b/i,
            /\s+Dostepne jednostki\b/i
        ];

        let cut = segment.length;

        for (const re of stops) {
            const m = re.exec(segment);
            if (m && m.index < cut) cut = m.index;
        }

        return segment.slice(0, cut).trim();
    }

    function getMissionCardLines(block) {
        if (!block) return [];

        let raw = (block.innerText || block.textContent || '')
            .replace(/\u00a0/g, ' ')
            .trim();

        if (!raw) return [];

        // Jeżeli kontener jest szerszy niż sama karta, odcinamy wszystko od
        // sekcji dostępnych jednostek w dół, zachowując znaki nowych linii.
        const stop = /(?:^|\n)\s*(?:Dostępne jednostki|Dostepne jednostki|Alarmowo)\b/i.exec(raw);
        if (stop) raw = raw.slice(0, stop.index);

        return cleanLines(raw);
    }

    function getMissionCardLeafTexts(block) {
        if (!block) return [];

        const items = [];
        const selectors = 'h1,h2,h3,h4,h5,h6,p,li,span,strong,b,dt,dd,td,th,div';

        for (const el of block.querySelectorAll(selectors)) {
            if (!isVisible(el)) continue;

            const text = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!text || text.length > 180) continue;

            // Pomijamy szerokich rodziców powtarzających dokładnie tekst dziecka.
            const sameChild = [...el.children].some(child => {
                const childText = (child.innerText || child.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                return childText === text;
            });
            if (sameChild) continue;

            if (items[items.length - 1] !== text) items.push(text);
        }

        return items;
    }

    function extractVehiclesFromCardLines(block) {
        const result = [];
        const map = new Map();

        // v3.15.06: czytamy WYŁĄCZNIE prawdziwe linie innerText żółtej karty.
        // Nie składamy już listy z przypadkowych najmniejszych span/div, bo na
        // części misji elementy techniczne formularza dawały fałszywe pary
        // typu `2` + `10`, co kończyło się wymaganiem `10`.
        const lines = getMissionCardLines(block);
        if (!lines.length) return result;

        let start = lines.findIndex(line => normalize(line) === 'pojazdy');
        if (start < 0) start = lines.findIndex(line => /^pojazdy\b/i.test(line));
        if (start < 0) return result;

        const isStop = line => {
            const n = normalize(line);
            return (
                n === 'pacjenci' ||
                n === 'personel' ||
                n.includes('wiezniow') ||
                n.startsWith('specjalne wymagania') ||
                n.startsWith('moze sie rozwinac') ||
                n.startsWith('potrzebna woda') ||
                n.startsWith('wymagana woda') ||
                n === 'woda' ||
                n.startsWith('wymagana piana') ||
                n.startsWith('potrzebna piana') ||
                n === 'piana' ||
                n.startsWith('dostepne jednostki') ||
                n.startsWith('alarmowo')
            );
        };

        let ambiguous = false;

        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (isStop(line)) break;

            let count = null;
            let rawLabel = '';

            const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
            if (m) {
                count = Number.parseInt(m[1], 10);
                rawLabel = m[2].trim();

                // Jeśli jedna linia zawiera kilka pozycji, np.
                // `1 OPI 1 WRD 1 radiowozy WRD lub radiowozy`, nie traktujemy
                // całego ogona jako jednej nazwy. Zwracamy pustą listę, aby
                // extractAuthoritativeVisibleVehicles użył parsera płaskiego,
                // który rozdziela kolejne pary ilość+nazwa.
                if (/\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(rawLabel)) {
                    ambiguous = true;
                    break;
                }
            } else if (/^\s*\d+\s*$/.test(line) && lines[i + 1] && !isStop(lines[i + 1])) {
                const next = lines[i + 1].trim();
                // Liczba i etykieta mogą być rozbite na dwie linie, ale druga
                // linia musi wyglądać jak rzeczywista nazwa pojazdu.
                if (!/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(next) || /^\d+$/.test(next)) continue;
                count = Number.parseInt(line, 10);
                rawLabel = next;
                i++;
            }

            if (!count || !rawLabel) continue;
            if (!looksLikeVehicleLabel(rawLabel)) continue;

            const chance = parseChanceFromLabel(rawLabel);
            addVehicle(result, map, rawLabel, count, chance);
        }

        return ambiguous ? [] : result;
    }

    function extractVehiclesFromFlatText(block) {
        const result = [];
        const map = new Map();
        const segment = getVehiclesTextSegment(block);

        if (!segment) return result;

        log('Segment Pojazdy:', segment);

        // Przykład:
        // "1 SLOP/SLRr (35%) 2 Samochody pożarnicze"
        const re = /(?:^|\s)(\d+)\s+(.+?)(?=\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]|$)/g;
        let m;

        while ((m = re.exec(segment)) !== null) {
            const count = Number.parseInt(m[1], 10);
            const rawLabel = m[2].trim();
            const chance = parseChanceFromLabel(rawLabel);

            addVehicle(result, map, rawLabel, count, chance);
        }

        return result;
    }

    function mergeVehicles(a, b) {
        const result = [];
        const map = new Map();

        for (const item of [...a, ...b]) {
            addVehicle(result, map, item.label, item.count, item.chance);
        }

        return result;
    }

    function extractResourceFromText(text, type) {
        const compact = String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // v0.31: liczba musi znajdować się BEZPOŚREDNIO przy nazwie zasobu.
        // Nie dopuszczamy już wzorca "Woda ... dowolna późniejsza liczba",
        // bo mógł złapać np. 25 z innego elementu strony.
        const patterns = type === 'water'
            ? [
                /\b([\d][\d\s.]*)\s+Woda\b/i,
                /\bPotrzebna\s+woda\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i,
                /\bWymagana\s+woda\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i,
                /\bWoda\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i
            ]
            : [
                /\b([\d][\d\s.]*)\s+Piana(?:\s+gaśnicza)?\b/i,
                /\bPotrzebna\s+piana(?:\s+gaśnicza)?\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i,
                /\bWymagana\s+piana(?:\s+gaśnicza)?\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i,
                /\bPiana(?:\s+gaśnicza)?\s*:\s*([\d][\d\s.]*)\s*(?:l\b|litr(?:ów|y)?\b|$)/i
            ];

        for (const re of patterns) {
            const m = compact.match(re);
            if (!m) continue;

            const digits = m[1].replace(/[^\d]/g, '');
            const value = digits ? Number.parseInt(digits, 10) : 0;
            if (value > 0) return value;
        }

        return 0;
    }

    function extractResource(block, type) {
        // v0.26: wyłącznie żółta karta AKTUALNEJ misji.
        // Nie przeszukujemy całej strony, bo znajdują się tam przyciski/teksty
        // dotyczące innych pojazdów i reguł.
        return extractResourceFromText(
            getMissionCardText(block),
            type
        ) || 0;
    }

    function extractMaxPatientsFromText(text) {
        const compact = String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Operator pokazuje to m.in. jako:
        // "2 Maksimum pacjentów"
        // albo na stronie szczegółów: "Maks. Pacjenci | 2".
        //
        // Celowo NIE bierzemy żadnej innej liczby z sekcji Pacjenci.
        const patterns = [
            /\b(\d+)\s+Maksimum\s+pacjent(?:ów|ow)\b/i,
            /\bMaksimum\s+pacjent(?:ów|ow)\s*:?\s*(\d+)\b/i,
            /\bMaks\.?\s*Pacjenci\s*:?\s*(\d+)\b/i,
            /\bMaksymalna\s+liczba\s+pacjent(?:ów|ow)\s*:?\s*(\d+)\b/i,
            /\bMaksymalnie\s+pacjent(?:ów|ow)\s*:?\s*(\d+)\b/i,
            /\bPacjenci\s*\(maks\.?\)\s*:?\s*(\d+)\b/i,
            /\bDokładnie\s+(\d+)\s+pacjent(?:ów|ow|a)?\b/i,
            /\bDokladnie\s+(\d+)\s+pacjent(?:ów|ow|a)?\b/i
        ];

        for (const re of patterns) {
            const m = compact.match(re);
            if (!m) continue;

            const value = Number.parseInt(m[1], 10);
            if (Number.isFinite(value) && value >= 0) return value;
        }

        return 0;
    }

    function extractMaxPatients(block) {
        // 1. Najpierw szukamy NAJMNIEJSZEGO elementu DOM zawierającego dokładnie
        //    frazę "Maksimum pacjentów". Nie korzystamy już z szerokich kontenerów,
        //    które zawierają Minimum, procent transportu i LPR jednocześnie.
        const root = block || document;

        const nodes = [
            ...root.querySelectorAll?.('tr,li,p,span,div,dt,dd,td,th,strong,b') || []
        ];

        const candidates = [];

        for (const el of nodes) {
            const text = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!text || text.length > 180) continue;

            const n = normalize(text);

            if (
                !n.includes('maksimum pacjent') &&
                !n.includes('maks pacjent') &&
                !n.includes('maksymalna liczba pacjent') &&
                !n.includes('dokladnie')
            ) {
                continue;
            }

            const value = extractMaxPatientsFromText(text);
            if (value <= 0) continue;

            // Preferujemy najmniejszy element, czyli dokładnie pojedynczy wiersz/linijkę.
            candidates.push({
                value,
                textLength: text.length,
                childCount: el.children?.length || 0
            });
        }

        if (candidates.length) {
            candidates.sort((a, b) =>
                a.textLength - b.textLength ||
                a.childCount - b.childCount
            );

            return candidates[0].value;
        }

        // 2. Tekst samej żółtej karty.
        let value = extractMaxPatientsFromText(
            getMissionCardText(block)
        );

        if (value > 0) return value;

        // v0.26: nie szukamy pacjentów w całym ekranie. Wartość musi pochodzić
        // z żółtej karty bieżącej misji, aby nie przechwycić danych z innej sekcji.
        return 0;
    }

    function findMissionDetailsLink(block) {
        const roots = [block, block?.parentElement, document].filter(Boolean);

        for (const root of roots) {
            const links = root.querySelectorAll?.('a[href*="/einsaetze/"]') || [];

            for (const a of links) {
                const href = a.href || a.getAttribute('href') || '';
                if (/\/einsaetze\/\d+(?:[/?#]|$)/.test(href)) return href;
            }
        }

        return null;
    }

    function xhrText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 20000,
                onload: r => {
                    if (r.status >= 200 && r.status < 400) resolve(r.responseText);
                    else reject(new Error(`HTTP ${r.status}`));
                },
                onerror: () => reject(new Error('Błąd połączenia')),
                ontimeout: () => reject(new Error('Przekroczono czas połączenia'))
            });
        });
    }

    function parsePublicMissionDetails(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const vehicles = [];
        const byName = new Map();
        const chances = [];
        let water = 0;
        let foam = 0;
        let maxPatients = 0;

        for (const tr of doc.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('th,td')];
            if (cells.length < 2) continue;

            const label = cells[0].textContent.replace(/\s+/g, ' ').trim();
            const valueText = cells[1].textContent.replace(/\s+/g, ' ').trim();
            const value = parseIntLoose(valueText);

            if (!label || value == null) continue;

            const nl = normalize(label);

            if (
                nl === 'maks pacjenci' ||
                nl === 'maksimum pacjentow' ||
                nl === 'maksimum pacjentów' ||
                (nl.includes('pacjent') && nl.includes('maks'))
            ) {
                // W tabeli szczegółów wartość znajduje się w osobnej komórce,
                // np. "Maks. Pacjenci | 2".
                maxPatients = Math.max(maxPatients, value);
                continue;
            }

            if (nl.includes('szanse') || nl.includes('szansa')) {
                chances.push({ label, value });
                continue;
            }

            if (nl.includes('woda')) {
                water = Math.max(water, value);
                continue;
            }

            if (nl.includes('piana')) {
                foam = Math.max(foam, value);
                continue;
            }

            if (!nl.startsWith('wymagane') && !nl.startsWith('wymagany') && !nl.startsWith('wymagana')) {
                continue;
            }

            // Odfiltrowujemy personel, budynki i posterunki.
            if (
                nl.includes('posterunk') ||
                nl.includes('personel') ||
                nl.includes('strazak') ||
                nl.includes('policjant') ||
                nl.includes('ratownik') ||
                nl.includes('rozbudow')
            ) {
                continue;
            }

            let vehicleLabel = label
                .replace(/^Wymagan(?:e|y|a)\s+/i, '')
                .replace(/\s+/g, ' ')
                .trim();

            addVehicle(vehicles, byName, vehicleLabel, value, null);
        }

        // Przypisanie procentów do odpowiadających pojazdów.
        for (const ch of chances) {
            const n = normalize(ch.label);

            let best = null;
            let bestScore = 0;

            for (const v of vehicles) {
                const vn = normalize(v.label);
                let score = 0;

                for (const token of vn.split(' ')) {
                    if (token.length >= 3 && n.includes(token)) score++;
                }

                if (score > bestScore) {
                    best = v;
                    bestScore = score;
                }
            }

            if (best && bestScore > 0) best.chance = ch.value;
        }

        return { vehicles, water, foam, maxPatients };
    }

    function getExactCurrentMissionHelpUrl() {
        // Operator/LSS udostępnia ukryty link #mission_help wskazujący
        // DOKŁADNIE typ aktualnej misji oraz jej mission_id.
        // To nie jest link z sekcji "Może się rozwinąć w...".
        const candidates = [
            document.querySelector('#mission_help[href*="/einsaetze/"]'),
            document.querySelector('a#mission_help'),
            document.querySelector('a[href*="/einsaetze/"][href*="mission_id="]')
        ].filter(Boolean);

        for (const link of candidates) {
            const raw = link.href || link.getAttribute('href') || '';
            if (!raw) continue;

            try {
                const url = new URL(raw, location.origin);
                if (!/^\/einsaetze\/\d+\/?$/i.test(url.pathname)) continue;

                // Preferujemy link zawierający mission_id; dzięki temu nie pomylimy
                // aktualnej misji z wariantem z "Może się rozwinąć w...".
                if (url.searchParams.get('mission_id')) return url.href;

                // #mission_help sam w sobie jest autorytatywnym źródłem nawet wtedy,
                // gdy w danej wersji gry mission_id nie jest jawnie dopisane.
                if (link.id === 'mission_help') return url.href;
            } catch {}
        }

        return '';
    }

    function parseRequirementPair(labelRaw, valueRaw, out) {
        const label = String(labelRaw || '').replace(/\s+/g, ' ').trim();
        const valueText = String(valueRaw || '').replace(/\s+/g, ' ').trim();
        if (!label || !valueText) return;

        const value = parseIntLoose(valueText);
        if (value == null) return;

        const nl = normalize(label);

        if (
            nl === 'maks pacjenci' ||
            nl.includes('maksimum pacjent') ||
            (nl.includes('pacjent') && nl.includes('maks'))
        ) {
            out.maxPatients = Math.max(out.maxPatients, value);
            return;
        }

        if (nl.includes('woda')) {
            out.water = Math.max(out.water, value);
            return;
        }

        if (nl.includes('piana')) {
            out.foam = Math.max(out.foam, value);
            return;
        }

        if (nl.includes('szans') || nl.includes('prawdopodobienstwo')) {
            out.chances.push({ label, value });
            return;
        }

        // v3.15.04: Operator zapisuje K-9 w tabeli mission_help jako
        // `Potrzeba Jednostki K-9 | 1`, a nie jako klasyczne `Wymagane ...`.
        // Dlatego K-9 rozpoznajemy jawnie przed ogólnym filtrowaniem etykiet.
        if (/(?:^|\s)(?:jednostk\S*\s+)?k\s*9(?:\s|$)/.test(nl)) {
            addVehicle(out.vehicles, out.byName, 'K-9', value, null);
            return;
        }

        // v0.32: help misji ma też tabele informacyjne, np.
        // "Inne informacje | Wartość Maks.". To nie są wymagania ZR.
        if (
            nl.includes('inne informacje') ||
            nl.includes('wartosc') ||
            nl.includes('srednie kredyty') ||
            nl.includes('rodzaj misji')
        ) {
            return;
        }

        // Pomiń warunki generowania misji, wymagania budynków/specjalizacji
        // i personel. `Wymagane Wydziały Ruchu Drogowego` jest warunkiem
        // wstępnym misji, a NIE pojazdem do wpisania do ZR.
        if (
            nl.includes('posterunk') ||
            nl.includes('rozbudow') ||
            nl.includes('wydzial ruchu drogowego') ||
            nl.includes('wydzialy ruchu drogowego') ||
            nl.includes('minimalna liczba') ||
            nl.includes('minimum ') ||
            nl.includes('personel') ||
            nl.includes('strazak') ||
            nl.includes('policjant') ||
            nl.includes('ratownik')
        ) {
            return;
        }

        if (
            nl.startsWith('wymagane') ||
            nl.startsWith('wymagany') ||
            nl.startsWith('wymagana') ||
            nl.startsWith('potrzebne') ||
            nl.startsWith('potrzebny') ||
            nl.startsWith('potrzebna') ||
            nl.startsWith('potrzeba')
        ) {
            const vehicleLabel = label
                .replace(/^(?:Wymagan(?:e|y|a)|Potrzebn(?:e|y|a)|Potrzeba)\s+/i, '')
                .replace(/\s+/g, ' ')
                .trim();

            addVehicle(out.vehicles, out.byName, vehicleLabel, value, null);
        }
    }

    function parseExactMissionHelpHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const out = {
            vehicles: [],
            byName: new Map(),
            chances: [],
            water: 0,
            foam: 0,
            maxPatients: 0
        };

        // 1. Najpierw strukturalne tabele - najpewniejsze źródło.
        for (const tr of doc.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll(':scope > th, :scope > td')];
            if (cells.length < 2) continue;

            const a = cells[0].textContent.replace(/\s+/g, ' ').trim();
            const b = cells[1].textContent.replace(/\s+/g, ' ').trim();

            // Obsługujemy oba układy: "etykieta | liczba" i "liczba | etykieta".
            if (/^\s*\d[\d\s.]*\s*$/.test(a) && !/^\s*\d[\d\s.]*\s*$/.test(b)) {
                parseRequirementPair(b, a, out);
            } else {
                parseRequirementPair(a, b, out);
            }
        }

        // 2. Fallback tekstowy dla wariantów helpa bez klasycznej tabeli.
        const bodyText = String(doc.body?.innerText || doc.body?.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .trim();

        if (bodyText) {
            // v3.06: fallback tekstowy dla POJAZDÓW uruchamiamy tylko wtedy,
            // gdy tabele strukturalne nie zwróciły żadnego pojazdu. W przeciwnym
            // razie help potrafił dodać drugi zestaw wierszy typu `Wymagane ...`.
            if (!out.vehicles.length) {
                const textVehicles = extractVehiclesFromCardText(bodyText);
                for (const item of textVehicles) {
                    addVehicle(out.vehicles, out.byName, item.label, item.count, item.chance);
                }
            }

            out.water = Math.max(out.water, extractResourceFromText(bodyText, 'water') || 0);
            out.foam = Math.max(out.foam, extractResourceFromText(bodyText, 'foam') || 0);
            out.maxPatients = Math.max(out.maxPatients, extractMaxPatientsFromText(bodyText) || 0);
        }

        // Dopasuj procenty do pojazdów, jeśli help podał je w osobnych wierszach.
        for (const chance of out.chances) {
            const cn = normalize(chance.label);
            let best = null;
            let bestScore = 0;

            for (const vehicle of out.vehicles) {
                const vn = normalize(vehicle.label);
                let score = 0;
                for (const token of vn.split(' ')) {
                    if (token.length >= 2 && cn.includes(token)) score++;
                }
                if (score > bestScore) {
                    best = vehicle;
                    bestScore = score;
                }
            }

            if (best && bestScore > 0 && best.chance == null) {
                best.chance = chance.value;
            }
        }

        return {
            vehicles: out.vehicles,
            water: out.water,
            foam: out.foam,
            maxPatients: out.maxPatients
        };
    }

    function visiblePageText() {
        return String(document.body?.innerText || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .trim();
    }

    function findCurrentMissionCardText(missionName) {
        const pageText = visiblePageText();
        if (!pageText) return '';

        const cleanName = sanitizeMissionName(missionName || getOpenedMissionName());
        if (!cleanName) return '';

        const lower = pageText.toLocaleLowerCase('pl-PL');
        const nameLower = cleanName.toLocaleLowerCase('pl-PL');

        // Zbieramy wszystkie wystąpienia nazwy. Zwykle pierwsze jest w ciemnym
        // nagłówku, a drugie bezpośrednio na żółtej karcie.
        const namePositions = [];
        let from = 0;
        while (from < lower.length) {
            const p = lower.indexOf(nameLower, from);
            if (p < 0) break;
            namePositions.push(p);
            from = p + Math.max(1, nameLower.length);
        }

        // Szukamy wszystkich "Pojazdy" i wybieramy to, przed którym najbliżej
        // występuje nazwa aktualnej misji. To nie zależy od struktury DOM.
        const vehiclePositions = [];
        const re = /\bPojazdy\b/gi;
        let m;
        while ((m = re.exec(pageText)) !== null) vehiclePositions.push(m.index);

        let best = null;

        for (const vp of vehiclePositions) {
            let np = -1;
            for (const p of namePositions) {
                if (p <= vp && p > np) np = p;
            }
            if (np < 0) continue;

            const distance = vp - np;
            // Na karcie tytuł jest bezpośrednio przed sekcją Pojazdy.
            // Duży dystans oznacza najpewniej nazwę z górnego nagłówka.
            if (distance > 5000) continue;

            const score = 10000 - distance;
            if (!best || score > best.score) best = { start: np, vehicles: vp, score };
        }

        if (!best) return '';

        let end = pageText.length;
        const tail = pageText.slice(best.vehicles);
        const stopPatterns = [
            /(?:^|\n)\s*Dostępne jednostki\b/i,
            /(?:^|\n)\s*Dostepne jednostki\b/i,
            /(?:^|\n)\s*Alarmowo\b/i
        ];

        for (const stop of stopPatterns) {
            const sm = stop.exec(tail);
            if (sm) end = Math.min(end, best.vehicles + sm.index);
        }

        // Ograniczenie ochronne przed pobraniem połowy strony, jeśli Operator
        // zmieni układ. Typowa karta jest wielokrotnie krótsza.
        end = Math.min(end, best.start + 12000);

        const slice = pageText.slice(best.start, end).trim();
        if (!/\bPojazdy\b/i.test(slice)) return '';

        log('Tekst bieżącej karty znaleziony niezależnie od DOM:', slice);
        return slice;
    }

    function getVehiclesTextSegmentFromCardText(cardText) {
        const compact = String(cardText || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const start = compact.search(/\bPojazdy\b/i);
        if (start < 0) return '';

        let segment = compact.slice(start).replace(/^.*?\bPojazdy\b\s*/i, '');

        const stops = [
            /\s+Pacjenci\b/i,
            /\s+Personel\b/i,
            /\s+Może się rozwinąć\b/i,
            /\s+Moze sie rozwinac\b/i,
            /\s+Dostępne jednostki\b/i,
            /\s+Dostepne jednostki\b/i,
            /\s+Alarmowo\b/i,
            /\s+Inne informacje\b/i,
            /\s+Wartość(?:\s+Maks\.?)?\b/i,
            /\s+Wartosc(?:\s+Maks\.?)?\b/i,
            /\s+Średnie kredyty\b/i,
            /\s+Srednie kredyty\b/i
        ];

        let cut = segment.length;
        for (const stop of stops) {
            const sm = stop.exec(segment);
            if (sm && sm.index < cut) cut = sm.index;
        }

        return segment.slice(0, cut).trim();
    }

    function extractVehiclesFromCardText(cardText) {
        const result = [];
        const map = new Map();
        const segment = getVehiclesTextSegmentFromCardText(cardText);
        if (!segment) return result;

        // Działa zarówno dla tekstu z nowymi liniami, jak i dla jednego ciągu.
        // Ilość musi zaczynać się na początku segmentu albo po białym znaku.
        // Dzięki temu `9` w nazwie `K-9` NIE może zostać uznane za ilość.
        // Przykład: `1 K-9 4 OPI` -> `1 K-9` + `4 OPI`.
        const re = /(?:^|\s)(\d+)\s+(.+?)(?=\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]|$)/g;
        let m;
        while ((m = re.exec(segment)) !== null) {
            const count = Number.parseInt(m[1], 10);
            const rawLabel = m[2].trim();
            const chance = parseChanceFromLabel(rawLabel);
            addVehicle(result, map, rawLabel, count, chance);
        }

        return result;
    }

    function normalizeK9Dashes(text) {
        // Operator może używać różnych znaków łącznika, które wizualnie wyglądają
        // jak zwykły minus: -, ‐, ‑, – itd. Dla K-9 wszystkie traktujemy jednakowo.
        return String(text || '')
            .replace(/[\u058A\u05BE\u1400\u1806\u2010-\u2015\u2E17\u2E1A\u2E3A-\u2E3B\u2E40\u301C\u3030\u30A0\uFE31-\uFE32\uFE58\uFE63\uFF0D\u2212]/g, '-')
            .replace(/\u00a0/g, ' ');
    }

    function k9CountFromText(text) {
        const raw = normalizeK9Dashes(text);
        if (!raw) return 0;

        // Akceptujemy K-9, K 9 i K9, ale ilość MUSI stać przed nazwą pojazdu.
        // Dzięki temu sama cyfra 9 w nazwie nigdy nie staje się ilością.
        const patterns = [
            /(?:^|\s)(\d+)\s+K\s*-\s*9(?=\s|$)/i,
            /(?:^|\s)(\d+)\s+K\s+9(?=\s|$)/i,
            /(?:^|\s)(\d+)\s+K9(?=\s|$)/i
        ];

        for (const re of patterns) {
            const m = raw.match(re);
            if (!m) continue;
            const count = Number.parseInt(m[1], 10);
            if (Number.isFinite(count) && count > 0) return count;
        }
        return 0;
    }

    function sccnCountFromText(text) {
        const raw = String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!raw) return 0;

        // SCCn = cysterna/samochód-cysterna z wodą.
        // Ilość musi stać bezpośrednio przed skrótem.
        const m = raw.match(/(?:^|\s)(\d+)\s+SCCn(?=\s|$)/i);
        if (!m) return 0;
        const count = Number.parseInt(m[1], 10);
        return Number.isFinite(count) && count > 0 ? count : 0;
    }

    function extractExplicitSCCnCountFromVisibleCard(preferredBlock = null) {
        const candidates = [];
        const seen = new Set();
        const add = el => {
            if (!el || !el.isConnected || seen.has(el)) return;
            seen.add(el);
            candidates.push(el);
        };

        add(preferredBlock);
        add(findMissionCardFromVehiclesHeading());
        add(findExactMissionCardByTitle());
        add(findMissionInfoBlock());

        for (const block of candidates) {
            const raw = String(block.innerText || block.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || !/\bPojazdy\b/i.test(raw)) continue;
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(raw)) continue;

            const segment = getVehiclesTextSegmentFromCardText(raw);
            const count = sccnCountFromText(segment || raw);
            if (count > 0) return count;
        }

        const missionName = currentMissionNameForAutoSelect() || exactMissionTitleFromGame() || '';
        const cardText = findCurrentMissionCardText(missionName);
        return sccnCountFromText(getVehiclesTextSegmentFromCardText(cardText));
    }

    function extractExplicitK9CountFromVisibleCard(preferredBlock = null) {
        // v3.15.03: K-9 czytamy niezależną ścieżką bez polegania na mission_help
        // ani na ogólnym parserze pojazdów. Obsługujemy też nierozdzielającą
        // kreskę U+2011 i inne znaki łącznika używane przez przeglądarkę/grę.
        const candidates = [];
        const seen = new Set();

        const addCandidate = el => {
            if (!el || !el.isConnected || seen.has(el)) return;
            seen.add(el);
            candidates.push(el);
        };

        addCandidate(preferredBlock);
        addCandidate(findMissionCardFromVehiclesHeading());
        addCandidate(findExactMissionCardByTitle());

        // 1. Najpierw czytamy pełny tekst kandydatów żółtej karty.
        for (const block of candidates) {
            const raw = (block.innerText || block.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || !/\bPojazdy\b/i.test(raw)) continue;
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(raw)) continue;

            // Najpierw wycinek sekcji Pojazdy, potem cały tekst karty jako fallback.
            const segment = getVehiclesTextSegmentFromCardText(raw);
            let count = k9CountFromText(segment);
            if (!count) count = k9CountFromText(raw);
            if (count) return count;
        }

        // 2. Awaryjnie szukamy bezpośrednio widocznego WIERSZA „1 K-9”.
        // To omija problemy, gdy liczba i etykieta są w osobnych spanach.
        const selectors = 'li,p,span,div,td,dd,strong,b';
        for (const el of document.querySelectorAll(selectors)) {
            if (!isVisible(el)) continue;

            const text = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!text || text.length > 80) continue;

            const count = k9CountFromText(text);
            if (!count) continue;

            // Wiersz musi należeć do lokalnego kontenera misji zawierającego
            // sekcję „Pojazdy”, ale nie listę „Dostępne jednostki”.
            let parent = el;
            for (let depth = 0; depth < 8 && parent; depth++, parent = parent.parentElement) {
                const parentText = (parent.innerText || parent.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .trim();
                if (!/\bPojazdy\b/i.test(parentText)) continue;
                if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(parentText)) break;
                return count;
            }
        }

        // 3. Ostatni fallback: tekst aktualnej karty znaleziony po nazwie misji.
        // Nadal ograniczamy się do sekcji Pojazdy, więc K-9 z listy jednostek
        // użytkownika nie może tu wejść.
        const missionName = currentMissionNameForAutoSelect() || exactMissionTitleFromGame() || '';
        const cardText = findCurrentMissionCardText(missionName);
        if (cardText) {
            const segment = getVehiclesTextSegmentFromCardText(cardText);
            const count = k9CountFromText(segment);
            if (count) return count;
        }

        return 0;
    }

    function hasContaminatedVehicleList(vehicles) {
        if (!Array.isArray(vehicles) || !vehicles.length) return false;

        return vehicles.some(v => {
            const label = String(v?.label || '');
            return (
                /\b(?:\d+\s+)?min\s+\d+\s*s\b/i.test(label) ||
                /\[[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]*\d+[^\]]*\]/.test(label) ||
                /posterunek/i.test(label) ||
                /dostępne jednostki|dostepne jednostki|alarmowo/i.test(label)
            );
        });
    }

    function extractVehiclesDirectlyFromVisiblePojazdyHeading() {
        // v3.15.14: najbardziej bezpośredni odczyt tego, co użytkownik widzi
        // pod nagłówkiem `Pojazdy` na żółtej karcie. Nie używamy tu nazwy misji
        // ani mission_help, dzięki czemu np. `1 OPI` nie może zniknąć przez
        // błędne rozpoznanie tytułu lub warunku aktywacji misji.
        const heading = findVisibleVehiclesHeading();
        if (!heading) return [];

        const candidates = [];
        let cur = heading;

        for (let depth = 0; depth < 10 && cur; depth++, cur = cur.parentElement) {
            if (!cur.isConnected) continue;

            const raw = String(cur.innerText || cur.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || !/\bPojazdy\b/i.test(raw)) continue;

            // Po wejściu do kontenera obejmującego `Dostępne jednostki`
            // jesteśmy już poza właściwą kartą misji.
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(raw)) {
                continue;
            }

            const vehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);
            if (!vehicles.length) continue;

            candidates.push({ vehicles, len: raw.length, depth });
        }

        // Najmniejszy kontener zawierający nagłówek + listę jest najbliżej
        // właściwej żółtej karty i najmniej narażony na obce dane strony.
        candidates.sort((a, b) => a.len - b.len || a.depth - b.depth);
        return candidates[0]?.vehicles || [];
    }

    function extractStrictVisibleVehicleSection(missionName = '') {
        // v3.15.13: niezależny, prosty odczyt WYŁĄCZNIE sekcji `Pojazdy`
        // z widocznej żółtej karty. Jest to ostatnia warstwa ochronna przed
        // danymi technicznymi z mission_help (np. `Wydziały Ruchu Drogowego`).
        const candidates = [];
        const seen = new Set();
        const add = el => {
            if (!el || !el.isConnected || seen.has(el)) return;
            seen.add(el);
            candidates.push(el);
        };

        add(findMissionCardFromVehiclesHeading());
        add(findExactMissionCardByTitle());
        add(findMissionInfoBlock());

        const wantedName = exactMissionNameKey(missionName || currentMissionNameForAutoSelect() || '');
        const resultFromText = raw => {
            const result = [];
            const map = new Map();
            if (!raw) return result;

            const normalizedRaw = String(raw).replace(/\u00a0/g, ' ').replace(/\r/g, '').trim();
            if (!normalizedRaw || !/\bPojazdy\b/i.test(normalizedRaw)) return result;

            // Najpierw zachowujemy linie — to najwierniej odpowiada temu, co
            // użytkownik widzi na żółtej karcie.
            const lines = cleanLines(normalizedRaw);
            let start = lines.findIndex(line => normalize(line) === 'pojazdy');
            if (start < 0) start = lines.findIndex(line => /^pojazdy\b/i.test(line));

            const stopLine = line => {
                const n = normalize(line);
                return n === 'pacjenci' || n === 'personel' || n.includes('wiezniow') ||
                    n.startsWith('specjalne wymagania') || n.startsWith('moze sie rozwinac') ||
                    n.startsWith('potrzebna woda') || n.startsWith('wymagana woda') || n === 'woda' ||
                    n.startsWith('potrzebna piana') || n.startsWith('wymagana piana') || n === 'piana' ||
                    n.startsWith('dostepne jednostki') || n.startsWith('alarmowo');
            };

            if (start >= 0) {
                for (let i = start + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (stopLine(line)) break;

                    // Jedna linia może zawierać kilka pozycji. Regex rozcina ją
                    // na kolejne pary `ilość + nazwa`.
                    const re = /(?:^|\s)(\d+)\s+(.+?)(?=\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]|$)/g;
                    let m;
                    let foundInLine = false;
                    while ((m = re.exec(line)) !== null) {
                        foundInLine = true;
                        const count = Number.parseInt(m[1], 10);
                        const label = m[2].trim();
                        if (!count || !looksLikeVehicleLabel(label)) continue;
                        addVehicle(result, map, label, count, parseChanceFromLabel(label));
                    }

                    // Wariant DOM: liczba i nazwa w osobnych liniach.
                    if (!foundInLine && /^\d+$/.test(line) && lines[i + 1] && !stopLine(lines[i + 1])) {
                        const count = Number.parseInt(line, 10);
                        const label = lines[++i].trim();
                        if (count && looksLikeVehicleLabel(label)) {
                            addVehicle(result, map, label, count, parseChanceFromLabel(label));
                        }
                    }
                }
            }

            if (result.length) return result;

            // Fallback dla kart, których innerText został spłaszczony do jednego ciągu.
            const segment = getVehiclesTextSegmentFromCardText(normalizedRaw);
            const re = /(?:^|\s)(\d+)\s+(.+?)(?=\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]|$)/g;
            let m;
            while ((m = re.exec(segment)) !== null) {
                const count = Number.parseInt(m[1], 10);
                const label = m[2].trim();
                if (!count || !looksLikeVehicleLabel(label)) continue;
                addVehicle(result, map, label, count, parseChanceFromLabel(label));
            }
            return result;
        };

        for (const block of candidates) {
            const raw = String(block.innerText || block.textContent || '').replace(/\u00a0/g, ' ').trim();
            if (!raw || !/\bPojazdy\b/i.test(raw)) continue;
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(raw)) continue;
            if (wantedName) {
                const blockName = exactMissionNameKey(getMissionName(block) || '');
                // Nie odrzucamy bloku bez rozpoznanej nazwy, ale jeśli rozpoznano
                // inną nazwę, nie wolno pobrać z niego pojazdów.
                if (blockName && blockName !== 'misja bez nazwy' && blockName !== wantedName) continue;
            }
            const parsed = resultFromText(raw);
            if (parsed.length) return parsed;
        }

        const cardText = findCurrentMissionCardText(missionName);
        return resultFromText(cardText);
    }

    function extractAuthoritativeVisibleVehicles(preferredBlock = null, missionName = '') {
        // v3.15.14: najpierw czytamy bezpośrednio kartę wskazaną przez widoczny
        // nagłówek `Pojazdy`. To omija błędne rozpoznanie nazwy/kontenera i
        // gwarantuje zachowanie pozycji widocznych na ekranie, np. `1 OPI`.
        const headingVisible = extractVehiclesDirectlyFromVisiblePojazdyHeading();
        if (headingVisible.length) return headingVisible;

        // Następny fallback: ścisła lista z widocznej sekcji `Pojazdy`.
        const strictVisible = extractStrictVisibleVehicleSection(missionName);
        if (strictVisible.length) return strictVisible;

        // v3.15.06: lista `Pojazdy` widoczna na żółtej karcie jest źródłem
        // prawdy dla ZR. Nie uzależniamy jej od `findCurrentMissionCardText()`,
        // bo ten fallback potrafi nie znaleźć karty mimo że blok DOM jest już
        // poprawnie wyrenderowany.
        const candidates = [];
        const seen = new Set();
        const add = el => {
            if (!el || !el.isConnected || seen.has(el)) return;
            seen.add(el);
            candidates.push(el);
        };

        add(preferredBlock);
        add(findMissionCardFromVehiclesHeading());
        add(findExactMissionCardByTitle());

        for (const block of candidates) {
            const raw = getMissionCardText(block, missionName) ||
                String(block.innerText || block.textContent || '').replace(/\u00a0/g, ' ').trim();
            if (!raw || !/\bPojazdy\b/i.test(raw)) continue;
            if (/\bDostępne jednostki\b|\bDostepne jednostki\b|\bAlarmowo\b/i.test(raw)) continue;

            const lineVehicles = extractVehiclesFromCardLines(block)
                .filter(v => Number(v?.count) > 0);
            if (lineVehicles.length) return lineVehicles;

            const flatVehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);
            if (flatVehicles.length) return flatVehicles;
        }

        // Ostatni fallback: tekst karty odnaleziony po nazwie misji.
        const cardText = findCurrentMissionCardText(missionName);
        if (cardText && /\bPojazdy\b/i.test(cardText)) {
            return extractVehiclesFromCardText(cardText)
                .filter(v => Number(v?.count) > 0);
        }
        return [];
    }

    async function captureMission() {
        const block = findMissionInfoBlock();
        const cardName = getMissionName(block);
        const openedName = sanitizeMissionName(getOpenedMissionName());
        const name = (cardName && cardName !== 'Misja bez nazwy' ? cardName : openedName) || 'Misja bez nazwy';

        let vehicles = [];
        let water = 0;
        let foam = 0;
        let maxPatients = 0;
        let source = '';
        let helpK9Count = 0;
        let helpSCCnCount = 0;

        // v0.31: pierwszym źródłem jest ukryty #mission_help aktualnej misji.
        // Link zawiera /einsaetze/<typ> + mission_id, więc nie może wskazać
        // wariantu z sekcji "Może się rozwinąć w...".
        const helpUrl = getExactCurrentMissionHelpUrl();

        if (helpUrl) {
            try {
                const html = await xhrText(helpUrl);
                const parsed = parseExactMissionHelpHtml(html);

                vehicles = parsed.vehicles || [];
                water = parsed.water || 0;
                foam = parsed.foam || 0;
                maxPatients = parsed.maxPatients || 0;
                source = 'mission_help';

                // v3.15.04: zapamiętujemy K-9 z mission_help osobno. Widoczna
                // karta bywa parsowana częściowo (np. tylko OPI) i może później
                // zastąpić listę pojazdów. Tego wymagania nie wolno wtedy zgubić.
                const helpK9 = (Array.isArray(parsed.vehicles) ? parsed.vehicles : []).find(v => {
                    const n = normalize(v?.label || '');
                    return /(?:^|\s)(?:jednostk\S*\s+)?k\s*9(?:\s|$)/.test(n);
                });
                helpK9Count = Number(helpK9?.count) || 0;

                const helpSCCn = (Array.isArray(parsed.vehicles) ? parsed.vehicles : []).find(v =>
                    normalize(v?.label || '') === 'sccn'
                );
                helpSCCnCount = Number(helpSCCn?.count) || 0;

                log('Odczyt z dokładnego #mission_help:', helpUrl, parsed);
            } catch (error) {
                console.warn(TAG, 'Odczyt #mission_help nie powiódł się:', error);
            }
        }

        // v3.15.05: widoczna sekcja `Pojazdy` ma bezwzględne pierwszeństwo
        // nad mission_help. Czytamy ją bezpośrednio z prawdziwego bloku DOM,
        // a dopiero potem z tekstowego fallbacku. Dzięki temu dla np.
        // `Jazda bez tablic rejestracyjnych` zachowujemy dokładnie:
        // 1 OPI + 1 WRD + 1 radiowozy WRD lub radiowozy, bez dodawania
        // warunku wstępnego `Wydziały Ruchu Drogowego` jako pojazdu.
        const visibleVehicles = extractAuthoritativeVisibleVehicles(block, name);
        if (visibleVehicles.length) {
            vehicles = visibleVehicles;
            source = source ? `${source}+visible_card` : 'visible_card';
        }

        const cardText = getMissionCardText(block, name) || findCurrentMissionCardText(name);
        if (cardText) {
            // Dla zasobów/pacjentów help nadal może być źródłem pierwszym,
            // a karta uzupełnia brakujące wartości.
            if (!water) water = extractResourceFromText(cardText, 'water') || 0;
            if (!foam) foam = extractResourceFromText(cardText, 'foam') || 0;
            if (!maxPatients) maxPatients = extractMaxPatientsFromText(cardText) || 0;
        }

        // v3.15.04: jeśli mission_help podał K-9, przywracamy je po ewentualnym
        // nadpisaniu listy przez częściowo odczytaną widoczną kartę. Dodajemy tylko
        // K-9, więc nie wraca wcześniejszy problem dublowania OPI/radiowozów.
        if (helpK9Count > 0) {
            const repairedVehicles = [];
            const repairedMap = new Map();
            for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
                addVehicle(repairedVehicles, repairedMap, vehicle.label, vehicle.count, vehicle.chance);
            }
            addVehicle(repairedVehicles, repairedMap, 'K-9', helpK9Count, null);
            vehicles = repairedVehicles;
            source = source ? `${source}+help_k9` : 'help_k9';
        }

        // v3.15.02: bezwarunkowy bezpiecznik dla K-9. Nawet jeśli ogólny parser
        // lub mission_help pominie tę pozycję, dokładny wpis z widocznej karty
        // zostanie dołączony do listy pojazdów.
        const explicitK9Count = extractExplicitK9CountFromVisibleCard(block);
        if (explicitK9Count > 0) {
            const repairedVehicles = [];
            const repairedMap = new Map();
            for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
                addVehicle(repairedVehicles, repairedMap, vehicle.label, vehicle.count, vehicle.chance);
            }
            addVehicle(repairedVehicles, repairedMap, 'K-9', explicitK9Count, null);
            vehicles = repairedVehicles;
            source = source ? `${source}+explicit_k9` : 'explicit_k9';
            log(`Wymuszone wymaganie K-9 z widocznej karty: ${explicitK9Count}`);
        }

        // v3.15.16: SCCn ma osobny bezpiecznik. W części misji (np. Pożar bloku)
        // ogólny parser potrafił pominąć `1 SCCn`, mimo że wpis był widoczny.
        const explicitSCCnCount = extractExplicitSCCnCountFromVisibleCard(block);
        const sccnCount = explicitSCCnCount || helpSCCnCount;
        if (sccnCount > 0) {
            const repairedVehicles = [];
            const repairedMap = new Map();
            for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
                addVehicle(repairedVehicles, repairedMap, vehicle.label, vehicle.count, vehicle.chance);
            }
            addVehicle(repairedVehicles, repairedMap, 'SCCn', sccnCount, null);
            vehicles = repairedVehicles;
            source = source ? `${source}+sccn` : 'sccn';
            log(`Wymuszone wymaganie SCCn: ${sccnCount}`);
        }

        // v3.15.13: końcowy filtr bezpieczeństwa. Nawet jeśli starszy format
        // mission_help poda warunek aktywacji jako pojazd, nie może on trafić
        // do panelu ZR.
        vehicles = (Array.isArray(vehicles) ? vehicles : []).filter(vehicle => {
            const n = normalize(vehicle?.label || '');
            return !n.includes('wydzial ruchu drogowego') &&
                   !n.includes('wydzialy ruchu drogowego');
        });

        if (hasContaminatedVehicleList(vehicles)) {
            console.warn(TAG, 'Odrzucono zanieczyszczoną listę pojazdów:', vehicles);
            vehicles = [];
        }

        const data = {
            name,
            vehicles,
            water,
            foam,
            maxPatients,
            sourceUrl: location.href,
            capturedAt: Date.now(),
            readSource: source
        };

        if (!vehicles.length && !water && !foam && !maxPatients) {
            data.readError = 'Nie udało się odczytać wymagań z dokładnego mission_help ani z widocznej karty.';
        }

        state.capture = data;
        saveJSON(CAPTURE_KEY, data);
        log('Odczyt misji:', data);

        return data;
    }

    // ------------------------------------------------------------------
    // AUTOMATYCZNY WYBÓR ISTNIEJĄCEGO ZR
    // ------------------------------------------------------------------

    function stripFalseAlarmSuffix(value) {
        let text = sanitizeMissionName(value);
        if (!text) return '';

        // Część misji ma techniczny dopisek w nagłówku, np.
        // "Płonąca maszyna (możliwy alarm fałszywy)".
        // W AZR użytkownik przechowuje ZR pod właściwą nazwą misji bez tego dopisku.
        // Usuwamy WYŁĄCZNIE ten końcowy nawias - innych nawiasów w nazwach nie ruszamy.
        text = text
            .replace(/\s*\(\s*możliwy\s+alarm\s+fałszywy\s*\)\s*$/i, '')
            .replace(/\s*\(\s*mozliwy\s+alarm\s+falszywy\s*\)\s*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        return text;
    }

    function exactMissionNameKey(value) {
        return sanitizeMissionName(value)
            .normalize('NFC')
            .toLocaleLowerCase('pl-PL')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function zrNameCandidates(value) {
        const full = sanitizeMissionName(value);
        if (!full) return [];

        const list = [full];
        // Pole nazwy ZR w grze ma limit 60 znaków. Dla długich nazw misji
        // próbujemy również dokładnie takiej wersji, jaką da się zapisać w ZR.
        const limited = full.length > 60 ? full.slice(0, 60).trimEnd() : full;
        if (limited && exactMissionNameKey(limited) !== exactMissionNameKey(full)) {
            list.push(limited);
        }
        return list;
    }

    function zrNameForEditor(value) {
        const full = sanitizeMissionName(value);
        if (!full) return '';
        return full.length > 60 ? full.slice(0, 60).trimEnd() : full;
    }

    function unwrapAAOList(data) {
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.result)) return data.result;
        if (Array.isArray(data?.aaos)) return data.aaos;
        return [];
    }

    function loadAAOsForAutoSelect(force = false) {
        const maxAge = 10000;

        if (
            !force &&
            state.aaosPromise &&
            state.aaosLoadedAt &&
            Date.now() - state.aaosLoadedAt < maxAge
        ) {
            return state.aaosPromise;
        }

        state.aaosLoadedAt = Date.now();
        state.aaosPromise = fetch('/api/v1/aaos', {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(unwrapAAOList)
            .catch(error => {
                state.aaosPromise = null;
                state.aaosLoadedAt = 0;
                console.warn(TAG, 'Nie udało się pobrać listy ZR do auto-wyboru:', error);
                return [];
            });

        return state.aaosPromise;
    }

    function unwrapAAOCategories(data) {
        const raw = data?.result ?? data;
        const result = [];

        if (Array.isArray(raw)) {
            for (const item of raw) {
                const id = item?.id ?? item?.aao_category_id ?? item?.category_id;
                const name = item?.caption ?? item?.name ?? item?.title ?? item?.label;
                if (id == null || !name) continue;
                result.push({ id: String(id), name: String(name) });
            }
            return result;
        }

        if (raw && typeof raw === 'object') {
            for (const [id, value] of Object.entries(raw)) {
                if (value && typeof value === 'object') {
                    const name = value.caption ?? value.name ?? value.title ?? value.label;
                    if (name) result.push({ id: String(value.id ?? id), name: String(name) });
                } else if (value != null) {
                    result.push({ id: String(id), name: String(value) });
                }
            }
        }

        return result;
    }

    function loadAZRCategoryId(force = false) {
        const maxAge = 10000;

        if (
            !force &&
            state.aaoCategoriesPromise &&
            state.aaoCategoriesLoadedAt &&
            Date.now() - state.aaoCategoriesLoadedAt < maxAge
        ) {
            return state.aaoCategoriesPromise;
        }

        state.aaoCategoriesLoadedAt = Date.now();
        state.aaoCategoriesPromise = fetch('/api/v1/aao_categories', {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(unwrapAAOCategories)
            .then(categories => {
                const azr = categories.find(category =>
                    exactMissionNameKey(category?.name || '') === 'azr'
                );
                state.azrCategoryId = azr?.id ?? null;
                return state.azrCategoryId;
            })
            .catch(error => {
                state.aaoCategoriesPromise = null;
                state.aaoCategoriesLoadedAt = 0;
                state.azrCategoryId = null;
                console.warn(TAG, 'Nie udało się znaleźć kategorii AZR:', error);
                return null;
            });

        return state.aaoCategoriesPromise;
    }

    function aaoBelongsToCategory(aao, categoryId) {
        if (!aao || categoryId == null) return false;
        const id = aao.aao_category_id ?? aao.category_id ?? aao.aaoCategoryId;
        return String(id ?? '') === String(categoryId);
    }

    function findAZRCategoryControl(group, categoryId = null) {
        const id = String(categoryId ?? '').trim();

        // Własne kategorie AAO/ZR w Operatorze są zakładkami w postaci:
        // <a href="#aao_category_<ID>">Nazwa kategorii</a>
        // To jest najpewniejszy sposób znalezienia kategorii użytkownika.
        const directSelectors = [
            `a[href*="aao_category_"]`,
            '.nav-tabs a',
            '.nav-pills a',
            '[role="tab"]',
            'a[data-toggle="tab"]',
            'button[data-toggle="tab"]',
            'a[data-bs-toggle="tab"]',
            'button[data-bs-toggle="tab"]'
        ];

        const seen = new Set();

        for (const selector of directSelectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (seen.has(el)) continue;
                seen.add(el);

                if (exactMissionNameKey(el.textContent || '') !== 'azr') continue;

                if (id) {
                    const href = String(el.getAttribute('href') || '');
                    const target = String(
                        el.getAttribute('data-target') ||
                        el.getAttribute('data-bs-target') ||
                        ''
                    );
                    const dataId = String(
                        el.getAttribute('data-aao-category-id') ||
                        el.getAttribute('aao_category_id') ||
                        el.getAttribute('data-category-id') ||
                        ''
                    );

                    const idMatches =
                        dataId === id ||
                        href.includes(`aao_category_${id}`) ||
                        target.includes(`aao_category_${id}`);

                    // Jeśli znaleźliśmy dokładne "AZR", ale ID z API ma inny format,
                    // nie odrzucamy zakładki. Nazwa kategorii jest ważniejsza.
                    if (!idMatches) {
                        log(`AZR znalezione po nazwie; ID zakładki różni się od API (${id}). Używam zakładki po nazwie.`);
                    }
                }

                return el;
            }
        }

        // Fallback po ID z API – może pomóc, jeśli nazwa zakładki została
        // wyrenderowana w nietypowym elemencie.
        if (id) {
            const escaped = CSS.escape(id);
            const selectors = [
                `a[href="#aao_category_${escaped}"]`,
                `a[href*="aao_category_${escaped}"]`,
                `[data-target="#aao_category_${escaped}"]`,
                `[data-bs-target="#aao_category_${escaped}"]`,
                `[data-aao-category-id="${escaped}"]`,
                `[aao_category_id="${escaped}"]`,
                `[data-category-id="${escaped}"]`
            ];

            for (const selector of selectors) {
                try {
                    const el = document.querySelector(selector);
                    if (el) return el;
                } catch {}
            }
        }

        return null;
    }

    function categoryControlIsActive(control) {
        if (!control) return false;

        const pane = paneForCategoryControl(control);

        return (
            control.classList.contains('active') ||
            control.parentElement?.classList.contains('active') ||
            control.getAttribute('aria-selected') === 'true' ||
            pane?.classList.contains('active') ||
            pane?.classList.contains('show') ||
            pane?.classList.contains('in')
        );
    }

    function showAZRCategory(control) {
        if (!control) return false;
        if (categoryControlIsActive(control)) return true;

        // Własne kategorie Operatora mają także własny handler click, który
        // potrafi załadować / podmienić listę ZR. Samo jQuery.tab('show') zmienia
        // tylko zakładkę Bootstrapa i w części układów NIE uruchamia tego handlera.
        // Dlatego natywny click jest zawsze pierwszy.
        try {
            control.click();
        } catch {
            try {
                control.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, view: window
                }));
            } catch {}
        }

        // Dodatkowe wymuszenie stanu zakładki Bootstrap, jeśli gra go używa.
        try {
            const jq = window.jQuery || window.$;
            if (jq && typeof jq(control).tab === 'function') jq(control).tab('show');
        } catch (error) {
            console.warn(TAG, 'Nie udało się dodatkowo aktywować AZR przez tab(show):', error);
        }
        return true;
    }

    function ensureAZRCategoryActive(group, categoryId) {
        const control = findAZRCategoryControl(group, categoryId);
        if (!control) return false;
        return showAZRCategory(control);
    }

    function waitMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isSingleFireVehicleRequirement(vehicle) {
        if (!vehicle || Number(vehicle.count) !== 1) return false;
        const label = normalize(vehicle.label || '');
        return (
            label.includes('samochod pozarniczy') ||
            label.includes('samochody pozarnicze') ||
            label.includes('pojazd strazacki') ||
            label.includes('woz strazacki') ||
            label.includes('wozy strazackie')
        );
    }

    function hasVisibleOnlyOneOPIRaw() {
        // v3.05: najprostsza, niezależna ścieżka dla dokładnego układu:
        // Pojazdy -> 1 OPI. Nie wymaga nazwy misji ani mission_help.
        // Dzięki temu reguła Radiowóz działa nawet gdy tytuł/karta ładuje się
        // w innej kolejności niż pozostałe dane.
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected) continue;

            let hidden = false;
            let node = el;
            while (node && node !== document.body) {
                const cs = getComputedStyle(node);
                if (cs.display === 'none' || cs.visibility === 'hidden') {
                    hidden = true;
                    break;
                }
                node = node.parentElement;
            }
            if (hidden) continue;

            const raw = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || raw.length > 6000) continue;
            if (!/\bPojazdy\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const segment = getVehiclesTextSegmentFromCardText(raw);
            if (!segment) continue;

            const compact = segment
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // Akceptujemy dokładnie jedną pozycję: "1 OPI".
            if (!/^1\s+OPI\s*$/i.test(compact)) continue;

            candidates.push(raw.length);
        }

        return candidates.length > 0;
    }

    function hasVisibleOnlyOneFireVehicleRaw() {
        // v3.09: ścisły skrót `Straż` czytany bezpośrednio z widocznej karty.
        // Działa TYLKO, gdy sekcja Pojazdy zawiera dokładnie jeden samochód/wóz
        // pożarniczy i karta nie ma pacjentów, wody ani piany.
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected) continue;

            let hidden = false;
            let node = el;
            while (node && node !== document.body) {
                const cs = getComputedStyle(node);
                if (cs.display === 'none' || cs.visibility === 'hidden') {
                    hidden = true;
                    break;
                }
                node = node.parentElement;
            }
            if (hidden) continue;

            const raw = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || raw.length > 6000) continue;
            if (!/\bPojazdy\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const vehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);
            if (vehicles.length !== 1 || !isSingleFireVehicleRequirement(vehicles[0])) continue;

            const maxPatients = extractMaxPatientsFromText(raw) || 0;
            const water = extractResourceFromText(raw, 'water') || 0;
            const foam = extractResourceFromText(raw, 'foam') || 0;
            if (maxPatients > 0 || water > 0 || foam > 0) continue;

            // Sama obecność nagłówka Pacjenci bez liczby nie wystarcza, ale każda
            // rzeczywista liczba pacjentów wyłącza skrót Straż.
            if (/\b(?:Dokładnie|Minimum|Maksimum)\s+\d+\s+pacjent/i.test(raw)) continue;

            candidates.push(raw.length);
        }

        return candidates.length > 0;
    }

    function getVisibleOnlyOPIRequirement() {
        // v3.02: bezpośredni odczyt z widocznej żółtej karty misji.
        // Nie zależy od mission_help ani od poprawnego rozpoznania nazwy misji.
        // Reguła ma zadziałać tylko dla sekcji Pojazdy zawierającej dokładnie: 1 OPI.
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected) continue;

            let hidden = false;
            let node = el;
            while (node && node !== document.body) {
                const cs = getComputedStyle(node);
                if (cs.display === 'none' || cs.visibility === 'hidden') {
                    hidden = true;
                    break;
                }
                node = node.parentElement;
            }
            if (hidden) continue;

            const raw = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();
            if (!raw || raw.length > 5000) continue;
            if (!/(^|\n)\s*Pojazdy\s*(\n|$)/i.test(raw) && !/\bPojazdy\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const vehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);

            if (vehicles.length !== 1 || !isSingleOPIRequirement(vehicles[0])) continue;

            // Preferujemy najmniejszy kontener - najczęściej jest to dokładna żółta karta.
            candidates.push({ vehicle: vehicles[0], len: raw.length });
        }

        candidates.sort((a, b) => a.len - b.len);
        return candidates[0]?.vehicle || null;
    }

    function getVisibleSingleAmbulancePatientRequirement() {
        // v3.03: bezpośredni odczyt wariantu widocznego na karcie:
        // Pojazdy -> 1 Ambulans, Pacjenci -> Dokładnie 1 pacjent.
        // Ten skrót nie zależy od mission_help, które dla części misji zwraca
        // dodatkowe/techniczne wymagania i blokowało auto-wybór ZR „Ambulans”.
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected) continue;

            let hidden = false;
            let node = el;
            while (node && node !== document.body) {
                const cs = getComputedStyle(node);
                if (cs.display === 'none' || cs.visibility === 'hidden') {
                    hidden = true;
                    break;
                }
                node = node.parentElement;
            }
            if (hidden) continue;

            const raw = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();

            if (!raw || raw.length > 5000) continue;
            if (!/(^|\n)\s*Pojazdy\s*(\n|$)/i.test(raw) && !/\bPojazdy\b/i.test(raw)) continue;
            if (!/\bPacjenci\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const maxPatients = extractMaxPatientsFromText(raw) || 0;
            if (maxPatients !== 1) continue;

            const water = extractResourceFromText(raw, 'water') || 0;
            const foam = extractResourceFromText(raw, 'foam') || 0;
            if (water > 0 || foam > 0) continue;

            const vehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);

            if (
                vehicles.length !== 1 ||
                !isSinglePlainAmbulanceRequirement(vehicles[0])
            ) continue;

            candidates.push({ len: raw.length });
        }

        candidates.sort((a, b) => a.len - b.len);
        return candidates.length > 0;
    }

    function isSingleOPIRequirement(vehicle) {
        if (!vehicle || Number(vehicle.count) !== 1) return false;

        let label = normalize(vehicle.label || '')
            .replace(/^(?:wymagane|wymagany|wymagana|potrzebne|potrzebny|potrzebna)\s+/, '')
            .trim();

        // Operator potrafi zwrócić tę samą pozycję jako samo „OPI” albo
        // z technicznym opisem dookoła. Dla reguły skrótowej wystarczy,
        // że OPI jest samodzielnym tokenem i nie ma drugiego typu pojazdu.
        return (
            label === 'opi' ||
            /^(?:radiowoz\s+)?opi(?:\s+radiowoz)?$/.test(label) ||
            /(?:^|\s)opi(?:\s|$)/.test(label)
        );
    }

    function isSinglePlainAmbulanceRequirement(vehicle) {
        if (!vehicle || Number(vehicle.count) !== 1) return false;

        const label = normalize(vehicle.label || '')
            .replace(/^(?:wymagane|wymagany|wymagana|potrzebne|potrzebny|potrzebna)\s+/, '')
            .trim();

        return label === 'ambulans';
    }

    function getVisibleMissionRequirementSnapshot() {
        // v3.04: jeden wspólny snapshot widocznej żółtej karty misji.
        // Specjalne reguły (Ambulans / Radiowóz / Straż) nie powinny zależeć
        // od chwili, w której mission_help lub reszta DOM zdąży się załadować.
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected) continue;

            let hidden = false;
            let node = el;
            while (node && node !== document.body) {
                const cs = getComputedStyle(node);
                if (cs.display === 'none' || cs.visibility === 'hidden') {
                    hidden = true;
                    break;
                }
                node = node.parentElement;
            }
            if (hidden) continue;

            const raw = (el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();

            if (!raw || raw.length > 6000) continue;
            if (!/\b(?:Pojazdy|Pacjenci)\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const vehicles = /\bPojazdy\b/i.test(raw)
                ? extractVehiclesFromCardText(raw).filter(v => Number(v?.count) > 0)
                : [];
            const maxPatients = extractMaxPatientsFromText(raw) || 0;
            const water = extractResourceFromText(raw, 'water') || 0;
            const foam = extractResourceFromText(raw, 'foam') || 0;

            // Karta jest gotowa, jeśli widać już choć jedną rzeczywistą informację
            // o wymaganiu. To celowo nie wymaga nazwy misji.
            const ready =
                vehicles.length > 0 ||
                maxPatients > 0 ||
                water > 0 ||
                foam > 0 ||
                /\bDokładnie\s+\d+\s+pacjent/i.test(raw) ||
                /\bMaksimum\s+pacjent/i.test(raw);

            if (!ready) continue;

            candidates.push({
                raw,
                vehicles,
                maxPatients,
                water,
                foam,
                len: raw.length
            });
        }

        // v3.06: gdy na ekranie istnieje sekcja `Pojazdy`, snapshot musi
        // pochodzić z kontenera, który ją zawiera. Wcześniej najmniejszy kontener
        // `Pacjenci` mógł wygrać i błędnie uruchomić skrót `Ambulans`, mimo że
        // misja wymagała też OPI/SLOp/samochodu pożarniczego.
        const withVehiclesSection = candidates.filter(c => /\bPojazdy\b/i.test(c.raw));
        const pool = withVehiclesSection.length ? withVehiclesSection : candidates;
        pool.sort((a, b) => a.len - b.len);
        return pool[0] || null;
    }

    function specialAutoSelectTargetFromSnapshot(snapshot) {
        if (!snapshot) return null;

        const requiredVehicles = Array.isArray(snapshot.vehicles)
            ? snapshot.vehicles.filter(v => Number(v?.count) > 0)
            : [];
        const maxPatients = Number(snapshot.maxPatients) || 0;
        const water = Number(snapshot.water) || 0;
        const foam = Number(snapshot.foam) || 0;

        // Dokładnie 1 pacjent + brak innych wymagań pojazdowych albo jedyne
        // wymaganie 1 Ambulans -> gotowa ZR `Ambulans`.
        if (
            maxPatients === 1 &&
            water === 0 &&
            foam === 0 &&
            (
                requiredVehicles.length === 0 ||
                (
                    requiredVehicles.length === 1 &&
                    isSinglePlainAmbulanceRequirement(requiredVehicles[0])
                )
            )
        ) {
            return 'Ambulans';
        }

        // Jedynym pojazdem jest dokładnie 1 OPI -> `Radiowóz`.
        if (
            requiredVehicles.length === 1 &&
            isSingleOPIRequirement(requiredVehicles[0]) &&
            maxPatients === 0 && water === 0 && foam === 0
        ) {
            return 'Radiowóz';
        }

        // `Straż` wyłącznie wtedy, gdy naprawdę nie ma nic poza 1 samochodem
        // pożarniczym. Pacjent, woda, piana lub inny pojazd wyłącza skrót.
        if (
            requiredVehicles.length === 1 &&
            isSingleFireVehicleRequirement(requiredVehicles[0]) &&
            maxPatients === 0 && water === 0 && foam === 0
        ) {
            return 'Straż';
        }

        return null;
    }

    async function autoSelectTargetName(missionName) {
        // Dla auto-zaznaczania ignorujemy techniczny dopisek
        // "(możliwy alarm fałszywy)" na końcu nazwy.
        const matchMissionName = stripFalseAlarmSuffix(missionName) || missionName;
        const missionKey = exactMissionNameKey(matchMissionName);

        // Reguły specjalne nazw misji.
        // Są sprawdzane przed analizą wymagań i dotyczą tylko auto-zaznaczania.
        if (missionKey === exactMissionNameKey('Transport pacjenta')) return 'Ambulans T';
        if (missionKey.startsWith(exactMissionNameKey('Transport krytyczny'))) return 'A TK';

        // v3.12: skróty są uznawane tylko wtedy, gdy pełna widoczna karta
        // bieżącej misji jednoznacznie potwierdza ich warunki.
        const visibleSpecialTarget = visibleSpecialAutoSelectTarget(missionName);
        if (visibleSpecialTarget) return visibleSpecialTarget;

        let vehicles = [];
        let maxPatients = 0;
        let water = 0;
        let foam = 0;
        let cardText = '';

        // Najpewniejsze źródło: dokładny mission_help bieżącej misji.
        const helpUrl = getExactCurrentMissionHelpUrl();
        if (helpUrl) {
            try {
                const html = await xhrText(helpUrl);
                const parsed = parseExactMissionHelpHtml(html);
                vehicles = parsed?.vehicles || [];
                maxPatients = Number.parseInt(parsed?.maxPatients, 10) || 0;
                water = Number.parseInt(parsed?.water, 10) || 0;
                foam = Number.parseInt(parsed?.foam, 10) || 0;
            } catch (error) {
                console.warn(TAG, 'Nie udało się sprawdzić reguł skrótowych auto-wyboru:', error);
            }
        }

        // Tekst aktualnej karty służy jako fallback i dodatkowe zabezpieczenie
        // dla reguły „Straż”, żeby nie pominąć pacjentów/wody/piany.
        cardText = findCurrentMissionCardText(missionName) || '';
        if (cardText) {
            const visibleVehicles = extractVehiclesFromCardText(cardText)
                .filter(v => Number(v?.count) > 0);
            if (visibleVehicles.length) vehicles = visibleVehicles;
            if (!maxPatients) maxPatients = extractMaxPatientsFromText(cardText) || 0;
            if (!water) water = extractResourceFromText(cardText, 'water') || 0;
            if (!foam) foam = extractResourceFromText(cardText, 'foam') || 0;

            const strictVisibleTarget = strictSpecialAutoSelectTargetFromCardText(cardText);
            return strictVisibleTarget || matchMissionName;
        }

        const requiredVehicles = Array.isArray(vehicles)
            ? vehicles.filter(v => Number(v?.count) > 0)
            : [];

        // Dokładnie 1 pacjent:
        // - bez sekcji Pojazdy, albo
        // - z jedynym wymaganiem „1 Ambulans”
        // -> zaznacz gotową ZR „Ambulans”.
        // Woda/piana lub inny pojazd wyłączają ten skrót.
        if (
            maxPatients === 1 &&
            water === 0 &&
            foam === 0 &&
            (
                requiredVehicles.length === 0 ||
                (
                    requiredVehicles.length === 1 &&
                    isSinglePlainAmbulanceRequirement(requiredVehicles[0])
                )
            )
        ) {
            return 'Ambulans';
        }

        // OPI: dodatkowo sprawdzamy bezpośrednio widoczną kartę misji.
        // To omija różnice w opisie zwracanym przez mission_help.
        const visibleVehicles = cardText
            ? extractVehiclesFromCardText(cardText).filter(v => Number(v?.count) > 0)
            : [];

        if (
            (
                visibleVehicles.length === 1 &&
                isSingleOPIRequirement(visibleVehicles[0])
            ) ||
            (
                requiredVehicles.length === 1 &&
                isSingleOPIRequirement(requiredVehicles[0])
            )
        ) {
            return 'Radiowóz';
        }

        // ZR „Straż” TYLKO gdy jedynym wymaganiem misji jest dokładnie 1
        // samochód/wóz pożarniczy. Jeśli są pacjenci, woda, piana lub jakikolwiek
        // inny wymagany pojazd, wracamy do normalnego wyszukiwania po nazwie misji.
        const onlyOneFireVehicle =
            requiredVehicles.length === 1 &&
            isSingleFireVehicleRequirement(requiredVehicles[0]);

        const patientSectionPresent = /\bPacjenci\b/i.test(cardText) && maxPatients > 0;
        const hasAnythingElse =
            maxPatients > 0 ||
            water > 0 ||
            foam > 0 ||
            patientSectionPresent ||
            requiredVehicles.length !== 1;

        if (onlyOneFireVehicle && !hasAnythingElse) return 'Straż';

        return matchMissionName;
    }

    function scheduleAutoSelectRetry(delay = 500) {
        if (state.autoSelectAttempts >= 12) return;
        clearTimeout(state.autoSelectRetryTimer);
        state.autoSelectRetryTimer = setTimeout(() => autoSelectMatchingAAO(), delay);
    }

    function ensureAutoSelectStyle() {
        if (document.getElementById('orzr-auto-select-style')) return;

        const style = document.createElement('style');
        style.id = 'orzr-auto-select-style';
        style.textContent = `
            .aao.orzr-auto-selected-aao, .aao_btn.orzr-auto-selected-aao, [id^="aao_"].orzr-auto-selected-aao {
                outline: 3px solid #8e44ad !important;
                outline-offset: 1px !important;
                box-shadow: 0 0 8px rgba(142, 68, 173, .78) !important;
            }
            #orzr-auto-select-status {
                display: inline-flex !important;
                align-items: center !important;
                height: 30px !important;
                padding: 0 10px !important;
                border: 1px solid #9b59b6 !important;
                border-radius: 4px !important;
                background: #8e44ad !important;
                color: #fff !important;
                font: 700 12px/28px Arial,sans-serif !important;
                box-shadow: 0 1px 4px rgba(0,0,0,.35) !important;
                white-space: nowrap !important;
            }
        `;
        document.head.appendChild(style);
    }

    function showAutoSelectStatus(aaoName) {
        const header = findOpenedMissionHeader();
        if (!header || !aaoName) return;

        ensureAutoSelectStyle();

        let status = document.getElementById('orzr-auto-select-status');

        // v3.15.07: status jest zwykle dzieckiem #orzr-header-actions, a nie
        // bezpośrednim dzieckiem nagłówka. Poprzedni test parentElement !== header
        // usuwał poprawny status przy kolejnych skanach MutationObservera.
        if (status && !header.contains(status)) {
            status.remove();
            status = null;
        }

        if (!status) {
            status = document.createElement('span');
            status.id = 'orzr-auto-select-status';

            const actions = document.getElementById('orzr-header-actions');
            if (actions && header.contains(actions)) {
                actions.appendChild(status);
            } else {
                header.appendChild(status);
            }
        }

        status.textContent = `✓ Zaznaczono ZR: ${aaoName}`;
        status.title = `Menedżer ZR automatycznie zaznaczył ZR „${aaoName}”`;
    }

    function removeAutoSelectStatus() {
        document.getElementById('orzr-auto-select-status')?.remove();
    }

    function currentMissionNameForAutoSelect() {
        // Do auto-wyboru NIE zgadujemy nazwy z DOM. Operator przechowuje ją
        // w data-mission-title na #mission_general_info.
        const exactTitle = exactMissionTitleFromGame();
        if (exactTitle) return exactTitle;

        const header = findOpenedMissionHeader();
        if (!header) return '';

        const block = findMissionInfoBlock();
        let name = getMissionName(block);
        if (!name || name === 'Misja bez nazwy' || isMissionNameNoise(name)) {
            const title = findMissionTitleElement(header);
            name = sanitizeMissionName(title?.textContent || '');
        }
        if (!name || name === 'Misja bez nazwy' || isMissionNameNoise(name)) return '';
        return name;
    }

    function isAAOAvailable(aaoElement) {
        if (!aaoElement) return false;
        if (aaoElement.classList.contains('disabled')) return false;
        if (aaoElement.getAttribute('aria-disabled') === 'true') return false;
        if (aaoElement.hasAttribute('disabled')) return false;
        return true;
    }

    function findAZRControlDirect(group) {
        // Najpierw klasyczne zakładki Bootstrap/Operatora.
        const selectors = [
            'a[href*="aao_category_"]',
            '.nav-tabs a', '.nav-pills a', '[role="tab"]',
            'a[data-toggle="tab"]', 'button[data-toggle="tab"]',
            'a[data-bs-toggle="tab"]', 'button[data-bs-toggle="tab"]',
            '.aao-category', '.aao_category'
        ];

        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (exactMissionNameKey(el.textContent || '') === 'azr') return el;
            }
        }

        // Fallback: przycisk/link o dokładnym tekście AZR, ale nie sam przycisk ZR.
        for (const el of document.querySelectorAll('a,button')) {
            if (el.classList.contains('aao')) continue;
            if (el.closest('.aao')) continue;
            if (exactMissionNameKey(el.textContent || '') !== 'azr') continue;

            const parent = el.parentElement;
            if (
                el.matches('[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"]') ||
                parent?.closest('.nav-tabs,.nav-pills,[role="tablist"]')
            ) {
                return el;
            }
        }

        return null;
    }

    function paneForCategoryControl(control) {
        if (!control) return null;
        const raw =
            control.getAttribute('data-target') ||
            control.getAttribute('data-bs-target') ||
            control.getAttribute('href') || '';

        if (!raw || !raw.startsWith('#') || raw.length < 2) return null;
        try { return document.querySelector(raw); } catch { return null; }
    }

    function isRenderedInActiveCategory(el) {
        if (!el || !el.isConnected) return false;
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;

        const pane = el.closest('.tab-pane,[role="tabpanel"]');
        if (pane) {
            if (pane.hidden || pane.getAttribute('aria-hidden') === 'true') return false;
            if (
                pane.classList.contains('tab-pane') &&
                !pane.classList.contains('active') &&
                !pane.classList.contains('show') &&
                !pane.classList.contains('in')
            ) return false;
        }

        let node = el;
        while (node && node !== document.body) {
            const cs = getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            node = node.parentElement;
        }
        return true;
    }

    function aaoCaptionFromElement(el) {
        if (!el) return '';

        // W Operatorze/LSS przyciski ZR występują m.in. jako a.aao_btn.
        // Tekst przycisku jest najpewniejszą nazwą; title może zawierać opis/tool-tip.
        const visibleText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const explicit =
            el.getAttribute('data-caption') ||
            el.getAttribute('data-name') ||
            el.getAttribute('title') || '';

        return sanitizeMissionName(visibleText || explicit);
    }

    function getAAOCandidates(root) {
        if (!root?.querySelectorAll) return [];
        return root.querySelectorAll(
            'a.aao_btn,button.aao_btn,.aao_btn,a.aao,button.aao,.aao,' +
            '[aao_id],[data-aao-id],a[id^="aao_"],button[id^="aao_"],[id^="aao_"]'
        );
    }

    function findAAOInActiveAZR(group, control, caption) {
        const wantedKeys = new Set(
            zrNameCandidates(caption).map(exactMissionNameKey).filter(Boolean)
        );
        if (!wantedKeys.size) return null;

        const pane = paneForCategoryControl(control);

        // Jeśli Operator ma osobny panel kategorii, wolno przeszukiwać WYŁĄCZNIE go.
        if (pane) {
            for (const el of getAAOCandidates(pane)) {
                if (!isRenderedInActiveCategory(el)) continue;
                if (wantedKeys.has(exactMissionNameKey(aaoCaptionFromElement(el)))) return el;
            }
            return null;
        }

        // W wariancie, w którym gra podmienia zawartość #mission-aao-group,
        // przeszukujemy grupę tylko po aktywowaniu AZR. Nie używamy document.
        if (group?.querySelectorAll && categoryControlIsActive(control)) {
            for (const el of getAAOCandidates(group)) {
                if (!isRenderedInActiveCategory(el)) continue;
                if (wantedKeys.has(exactMissionNameKey(aaoCaptionFromElement(el)))) return el;
            }
        }

        return null;
    }

    function findAAOButtonById(group, control, id) {
        if (id == null || id === '') return null;

        const escapedId = CSS.escape(String(id));
        const selectors = [
            `#aao_${escapedId}`,
            `.aao_btn[aao_id="${escapedId}"]`,
            `.aao_btn[data-aao-id="${escapedId}"]`,
            `.aao[aao_id="${escapedId}"]`,
            `.aao[data-aao-id="${escapedId}"]`,
            `[aao_id="${escapedId}"]`,
            `[data-aao-id="${escapedId}"]`
        ];

        const pane = paneForCategoryControl(control);
        const roots = pane ? [pane] : [group].filter(Boolean);

        for (const root of roots) {
            for (const selector of selectors) {
                try {
                    const target = root.querySelector(selector);
                    if (target && isRenderedInActiveCategory(target)) return target;
                } catch {}
            }
        }
        return null;
    }

    function findAAOButtonByExactCaption(group, control, caption) {
        return findAAOInActiveAZR(group, control, caption);
    }

    function activateAAOTabForTarget(target) {
        if (!target) return false;
        const pane = target.closest('.tab-pane');
        if (!pane || pane.classList.contains('active') || !pane.id) return false;

        const id = CSS.escape(pane.id);
        const selectors = [
            `[href="#${id}"]`,
            `[data-target="#${id}"]`,
            `[data-bs-target="#${id}"]`
        ];

        for (const selector of selectors) {
            const tab = document.querySelector(selector);
            if (tab) {
                tab.click();
                return true;
            }
        }
        return false;
    }

    function containerHasDispatchedVehicles(container) {
        if (!container) return false;

        // NIE wymagamy widoczności w aktualnym viewportcie. Przy długiej misji
        // tabela pojazdów może być daleko niżej, a misja nadal już trwa.
        if (container.querySelector(
            'tr[id^="vehicle_row"], [id^="vehicle_"][vehicle_id], [data-vehicle-id], [vehicle_id], .mission_vehicle'
        )) {
            return true;
        }

        const text = (container.innerText || container.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text || text.length < 3) return false;

        return /\b(?:dojazd|na miejscu|przybył|przybyl|wraca|pojazd|jednostk)\b/i.test(text) &&
               /\b\d+\b/.test(text);
    }

    function isMissionAlreadyRunning() {
        // v0.40: misja jest „trwająca” wyłącznie wtedy, gdy faktycznie istnieje
        // co najmniej jeden pojazd wysłany / jadący / na miejscu.
        // Nie używamy pasków wody/piany ani globalnych alertów, bo te elementy
        // mogą istnieć również przed pierwszym alarmowaniem albo pochodzić z
        // poprzedniego widoku i blokowały auto-wybór także na świeżej misji.
        const selectors = [
            '#mission_vehicle_driving tr[id^="vehicle_row"]',
            '#mission_vehicle_at_mission tr[id^="vehicle_row"]',
            '#mission-vehicle-driving tr[id^="vehicle_row"]',
            '#mission-vehicle-at-mission tr[id^="vehicle_row"]',
            '#mission_vehicle_driving .vehicle_select_table_tr',
            '#mission_vehicle_at_mission .vehicle_select_table_tr',
            '#mission-vehicle-driving .vehicle_select_table_tr',
            '#mission-vehicle-at-mission .vehicle_select_table_tr',
            '[id*="mission_vehicle_driving"] tr[data-vehicle-id]',
            '[id*="mission_vehicle_at_mission"] tr[data-vehicle-id]'
        ];

        for (const selector of selectors) {
            try {
                const rows = [...document.querySelectorAll(selector)];
                if (rows.some(row => {
                    const id = String(row.id || '');
                    const vehicleId = row.getAttribute('vehicle_id') || row.getAttribute('data-vehicle-id');
                    return id.startsWith('vehicle_row') || vehicleId;
                })) return true;
            } catch {}
        }
        return false;
    }

    async function findTargetAAOInCustomAZR(targetName) {
        const targetKey = exactMissionNameKey(targetName);
        if (!targetKey) return { categoryId: null, aao: null };

        // AZR jest własną kategorią użytkownika. Dlatego nie próbujemy już
        // rozpoznawać jej po zakładkach widocznych w ekranie misji.
        // Najpierw znajdujemy ID kategorii po dokładnej nazwie przez API,
        // a następnie przeszukujemy WYŁĄCZNIE ZR przypisane do tego ID.
        const [categoryId, aaos] = await Promise.all([
            loadAZRCategoryId(false),
            loadAAOsForAutoSelect(false)
        ]);

        if (categoryId == null) {
            return { categoryId: null, aao: null };
        }

        const match = (Array.isArray(aaos) ? aaos : []).find(aao => {
            if (!aaoBelongsToCategory(aao, categoryId)) return false;
            const caption = aao?.caption ?? aao?.name ?? aao?.title ?? '';
            return exactMissionNameKey(caption) === targetKey;
        }) || null;

        return { categoryId, aao: match };
    }

    function categoryIdFromControl(control) {
        if (!control) return null;
        const raw = String(
            control.getAttribute('href') ||
            control.getAttribute('data-target') ||
            control.getAttribute('data-bs-target') ||
            ''
        );
        const m = raw.match(/aao_category_([^#?&\s]+)/i);
        return m ? m[1] : null;
    }

    async function apiAAOForAZR(targetName, categoryId) {
        // v0.42: bez poprawnego ID kategorii AZR nie szukamy nigdzie indziej.
        if (categoryId == null || categoryId === '') return null;

        const wantedKeys = new Set(
            zrNameCandidates(targetName)
                .map(exactMissionNameKey)
                .filter(Boolean)
        );
        if (!wantedKeys.size) return null;

        const aaos = await loadAAOsForAutoSelect(false);
        return (Array.isArray(aaos) ? aaos : []).find(aao => {
            const cat = aao?.aao_category_id ?? aao?.category_id ?? aao?.aaoCategoryId;
            if (String(cat ?? '') !== String(categoryId)) return false;

            const caption = aao?.caption ?? aao?.name ?? aao?.title ?? '';
            return wantedKeys.has(exactMissionNameKey(caption));
        }) || null;
    }

    function findAAOSearchInput(group) {
        const roots = [group, document].filter(Boolean);
        for (const root of roots) {
            const selectors = [
                'input.search_input',
                'input.aao_search',
                'input[id*="aao"][type="search"]',
                'input[id*="aao"][type="text"]'
            ];
            for (const selector of selectors) {
                try {
                    const el = root.querySelector(selector);
                    if (el) return el;
                } catch {}
            }
        }
        return null;
    }

    function setAAOSearch(group, value) {
        const input = findAAOSearchInput(group);
        if (!input) return false;
        input.value = String(value || '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
        return true;
    }

    async function waitUntilAZRIsActive(control, timeoutMs = 1800) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            if (categoryControlIsActive(control)) return true;
            await waitMs(60);
        }
        return categoryControlIsActive(control);
    }

    async function waitForAAOAfterAZRSwitch(group, control, targetName, aaoId = null) {
        await waitUntilAZRIsActive(control, 1800);
        setAAOSearch(group, '');

        for (let i = 0; i < 35; i++) {
            // ID z API kategorii AZR jest źródłem prawdy. Dzięki temu nawet jeśli
            // w innych kategoriach istnieje ZR o tej samej nazwie, nie może wygrać.
            let target = aaoId != null ? findAAOButtonById(group, control, aaoId) : null;

            // Caption fallback jest dozwolony tylko wewnątrz aktywnego panelu AZR.
            if (!target) target = findAAOInActiveAZR(group, control, targetName);
            if (target) return target;

            if (i === 6) setAAOSearch(group, zrNameForEditor(targetName) || targetName);
            await waitMs(80);
        }
        return null;
    }

    function findPozaryCategoryControl(group) {
        const wanted = exactMissionNameKey('Pożary');
        const roots = [group, document].filter(Boolean);
        const selectors = [
            '.nav-tabs a', '.nav-tabs button',
            '.nav-pills a', '.nav-pills button',
            '[role="tab"]',
            'a[data-toggle="tab"]', 'button[data-toggle="tab"]',
            'a[data-bs-toggle="tab"]', 'button[data-bs-toggle="tab"]'
        ];

        for (const root of roots) {
            for (const selector of selectors) {
                let elements = [];
                try { elements = [...root.querySelectorAll(selector)]; } catch {}
                for (const el of elements) {
                    if (exactMissionNameKey(el.textContent || '') === wanted) return el;
                }
            }
        }
        return null;
    }

    function returnToPozaryCategory(group) {
        // Jeśli ZR nie istnieje w AZR, interfejs ma zostać na pierwszej
        // kategorii „Pożary”, a nie na technicznej kategorii AZR.
        setAAOSearch(group, '');
        const control = findPozaryCategoryControl(group);
        if (!control) {
            log('Nie znaleziono zakładki Pożary do przywrócenia po braku ZR w AZR.');
            return false;
        }

        try {
            control.click();
        } catch {}

        try {
            const jq = window.jQuery || window.$;
            if (jq && typeof jq(control).tab === 'function') jq(control).tab('show');
        } catch {}

        return true;
    }

    function currentMissionIdentityForAutoSelect(missionName = '', specialTarget = '') {
        // Preferujemy ID konkretnej instancji misji, żeby specjalna reguła mogła
        // zadziałać nawet wtedy, gdy nazwa misji nie jest jeszcze dostępna.
        const helpUrl = getExactCurrentMissionHelpUrl();
        if (helpUrl) {
            try {
                const url = new URL(helpUrl, location.origin);
                const missionId = url.searchParams.get('mission_id');
                if (missionId) return `id:${missionId}`;
            } catch {}
        }

        const info = document.querySelector('#mission_general_info');
        if (info) {
            const attrs = [
                info.getAttribute('data-mission-id'),
                info.getAttribute('mission_id'),
                info.getAttribute('data-id'),
                info.dataset?.missionId
            ].filter(Boolean);
            if (attrs.length) return `id:${attrs[0]}`;
        }

        const nameKey = exactMissionNameKey(missionName);
        if (nameKey) return `name:${nameKey}`;

        // Ostateczny fallback tylko dla specjalnej reguły. Łączymy z adresem
        // aktualnego okna, aby nie blokować kolejnych misji o tym samym skrócie.
        const specialKey = exactMissionNameKey(specialTarget);
        if (specialKey) return `special:${specialKey}:${location.pathname}:${location.hash}`;

        return '';
    }

    function visibleMissionCardTextForSpecialRules(missionName = '') {
        const liveName = sanitizeMissionName(missionName || currentMissionNameForAutoSelect());

        // v3.13: dla skrótów Ambulans/Radiowóz/Straż najpierw czytamy
        // rzeczywisty, widoczny blok żółtej karty. Wcześniej tekstowy skan całej
        // strony potrafił znaleźć fragment Pacjenci bez pełnej sekcji Pojazdy i
        // błędnie uznać złożoną misję za przypadek `Ambulans`.
        const block = findMissionInfoBlock();
        if (block) {
            const blockText = getMissionCardText(block, liveName)
                .replace(/\u00a0/g, ' ')
                .trim();
            if (blockText && /\b(?:Pojazdy|Pacjenci)\b/i.test(blockText)) {
                return blockText;
            }
        }

        return findCurrentMissionCardText(liveName) || '';
    }

    function strictSpecialAutoSelectTargetFromCardText(cardText) {
        const raw = String(cardText || '').replace(/\u00a0/g, ' ').trim();
        if (!raw) return null;

        const maxPatients = extractMaxPatientsFromText(raw) || 0;
        const water = extractResourceFromText(raw, 'water') || 0;
        const foam = extractResourceFromText(raw, 'foam') || 0;
        const hasVehiclesSection = /\bPojazdy\b/i.test(raw);
        const vehicleSegment = hasVehiclesSection
            ? getVehiclesTextSegmentFromCardText(raw)
            : '';
        const vehicleSegmentKey = normalize(vehicleSegment);

        // v3.13: skróty są celowo rozpoznawane po CAŁYM segmencie Pojazdy,
        // a nie po częściowo sparsowanej tablicy. Jeśli segment zawiera np.
        // `2 OPI 1 SLOP/SLRr 1 Samochód pożarniczy ...`, nie ma żadnej drogi,
        // żeby reguła jednego pacjenta zwróciła `Ambulans`.
        if (
            maxPatients === 1 &&
            water === 0 &&
            foam === 0 &&
            (
                !hasVehiclesSection ||
                vehicleSegmentKey === '' ||
                vehicleSegmentKey === '1 ambulans'
            )
        ) {
            return 'Ambulans';
        }

        if (
            vehicleSegmentKey === '1 opi' &&
            maxPatients === 0 && water === 0 && foam === 0
        ) {
            return 'Radiowóz';
        }

        const fireOnlyKeys = new Set([
            '1 samochod pozarniczy',
            '1 samochody pozarnicze',
            '1 pojazd strazacki',
            '1 woz strazacki',
            '1 wozy strazackie'
        ]);

        if (
            fireOnlyKeys.has(vehicleSegmentKey) &&
            maxPatients === 0 && water === 0 && foam === 0
        ) {
            return 'Straż';
        }

        return null;
    }

    function strictVisibleSpecialSnapshot(missionName = '') {
        // v3.15.07: reguły Ambulans/Radiowóz/Straż czytamy z JEDNEJ, pełnej
        // żółtej karty. To eliminuje przypadki, w których parser widział tylko
        // podkontener „Pojazdy” (bez „Pacjenci”) albo tylko „Pacjenci”.
        const liveName = sanitizeMissionName(missionName || currentMissionNameForAutoSelect());
        const block =
            findMissionCardFromVehiclesHeading() ||
            findExactMissionCardByTitle() ||
            findMissionInfoBlock();

        if (!block) return null;

        const raw = (
            getMissionCardText(block, liveName) ||
            String(block.innerText || block.textContent || '')
        )
            .replace(/\u00a0/g, ' ')
            .trim();

        if (!raw || !/\b(?:Pojazdy|Pacjent|Pacjenci)\b/i.test(raw)) return null;

        let vehicles = extractVehiclesFromCardLines(block)
            .filter(v => Number(v?.count) > 0);

        if (!vehicles.length && /\bPojazdy\b/i.test(raw)) {
            vehicles = extractVehiclesFromCardText(raw)
                .filter(v => Number(v?.count) > 0);
        }

        const maxPatients = Math.max(
            extractMaxPatients(block) || 0,
            extractMaxPatientsFromText(raw) || 0
        );

        return {
            raw,
            vehicles,
            maxPatients,
            water: extractResourceFromText(raw, 'water') || 0,
            foam: extractResourceFromText(raw, 'foam') || 0,
            vehicleSegment: getVehiclesTextSegmentFromCardText(raw)
        };
    }

    function specialTargetFromStrictVisibleSnapshot(snapshot) {
        if (!snapshot) return null;

        const vehicles = Array.isArray(snapshot.vehicles)
            ? snapshot.vehicles.filter(v => Number(v?.count) > 0)
            : [];
        const maxPatients = Number(snapshot.maxPatients) || 0;
        const water = Number(snapshot.water) || 0;
        const foam = Number(snapshot.foam) || 0;
        const vehicleKey = normalize(snapshot.vehicleSegment || '');

        // Dokładnie 1 pacjent i albo brak pojazdów, albo dokładnie 1 Ambulans.
        // Jeśli parser tablicy nie zwrócił pojazdu, ale tekst sekcji Pojazdy
        // istnieje, wolno uznać skrót tylko dla dokładnego „1 Ambulans”.
        const ambulanceOnly =
            (vehicles.length === 1 && isSinglePlainAmbulanceRequirement(vehicles[0])) ||
            (vehicles.length === 0 && vehicleKey === '1 ambulans');
        const noVehicleRequirement = vehicles.length === 0 && !vehicleKey;

        if (
            maxPatients === 1 &&
            water === 0 &&
            foam === 0 &&
            (noVehicleRequirement || ambulanceOnly)
        ) {
            return 'Ambulans';
        }

        const opiOnly =
            (vehicles.length === 1 && isSingleOPIRequirement(vehicles[0])) ||
            (vehicles.length === 0 && vehicleKey === '1 opi');

        if (opiOnly && maxPatients === 0 && water === 0 && foam === 0) {
            return 'Radiowóz';
        }

        const fireOnly =
            (vehicles.length === 1 && isSingleFireVehicleRequirement(vehicles[0])) ||
            [
                '1 samochod pozarniczy',
                '1 samochody pozarnicze',
                '1 pojazd strazacki',
                '1 woz strazacki',
                '1 wozy strazackie'
            ].includes(vehicleKey);

        if (fireOnly && maxPatients === 0 && water === 0 && foam === 0) {
            return 'Straż';
        }

        return null;
    }

    function directLiteralSpecialTargetFromVisibleCard(missionName = '') {
        // v3.15.08: niezależny, prosty bezpiecznik dla trzech skrótów.
        // Nie polega na parserze tabel/mission_help. Czyta dosłownie sekcję
        // `Pojazdy` z małego widocznego kontenera żółtej karty.
        const liveName = sanitizeMissionName(missionName || currentMissionNameForAutoSelect());
        const liveKey = exactMissionNameKey(liveName);
        const candidates = [];

        for (const el of document.querySelectorAll('div,section,article,aside')) {
            if (!el || !el.isConnected || !isDisplayedInInterface(el)) continue;

            const raw = String(el.innerText || el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();

            if (!raw || raw.length > 4500) continue;
            if (!/\bPojazdy\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            // Jeżeli kontener zawiera tytuł, musi to być tytuł bieżącej misji.
            // Kontenery bez tytułu nadal są dozwolone (lista Pojazdy bywa osobnym
            // podkontenerem), ale dostają niższy priorytet.
            const nraw = exactMissionNameKey(raw);
            const hasCurrentTitle = liveKey && nraw.includes(liveKey);

            const segment = getVehiclesTextSegmentFromCardText(raw);
            const vehicleKey = normalize(segment);
            if (!vehicleKey) continue;

            const maxPatients = extractMaxPatientsFromText(raw) || 0;
            const water = extractResourceFromText(raw, 'water') || 0;
            const foam = extractResourceFromText(raw, 'foam') || 0;

            let target = null;
            if (vehicleKey === '1 ambulans' && maxPatients === 1 && water === 0 && foam === 0) {
                target = 'Ambulans';
            } else if (vehicleKey === '1 opi' && maxPatients === 0 && water === 0 && foam === 0) {
                target = 'Radiowóz';
            } else if (
                [
                    '1 samochod pozarniczy',
                    '1 samochody pozarnicze',
                    '1 pojazd strazacki',
                    '1 woz strazacki',
                    '1 wozy strazackie'
                ].includes(vehicleKey) &&
                maxPatients === 0 && water === 0 && foam === 0 &&
                !/\bPacjenci\b/i.test(raw)
            ) {
                target = 'Straż';
            }

            if (!target) continue;

            let score = 0;
            if (hasCurrentTitle) score += 100;
            if (isPaleMissionCardBackground(el)) score += 40;
            score += Math.max(0, 30 - Math.floor(raw.length / 100));
            candidates.push({ target, score, len: raw.length, vehicleKey, raw });
        }

        candidates.sort((a, b) => b.score - a.score || a.len - b.len);
        const best = candidates[0] || null;
        if (best) {
            log(`Bezpośrednia reguła skrótowa: ${best.target}; Pojazdy = ${best.vehicleKey}`);
            return best.target;
        }
        return null;
    }

    function completeVisibleMissionCardForShortcutRules(missionName = '') {
        // v3.15.11: dla reguł skrótowych nie wolno brać samego małego
        // podkontenera `Pojazdy`. W misjach medycznych sekcja `Pacjenci`
        // bywa rodzeństwem, więc trzeba wejść do wspólnego żółtego kontenera.
        const heading = findVisibleVehiclesHeading();
        if (!heading) return null;

        const liveName = sanitizeMissionName(missionName || currentMissionNameForAutoSelect());
        const liveKey = exactMissionNameKey(liveName);
        const candidates = [];

        let cur = heading;
        for (let depth = 0; depth < 12 && cur; depth++, cur = cur.parentElement) {
            if (!cur.isConnected || !isDisplayedInInterface(cur)) continue;

            const raw = String(cur.innerText || cur.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();

            if (!raw || raw.length > 7000) continue;
            if (!/\bPojazdy\b/i.test(raw)) continue;
            if (/Dostępne jednostki|Dostepne jednostki|Alarmowo/i.test(raw)) continue;

            const compact = raw.replace(/\s+/g, ' ').trim();
            const vehicleSegment = getVehiclesTextSegmentFromCardText(raw);
            if (!vehicleSegment) continue;

            let score = 0;
            const normalizedRaw = exactMissionNameKey(compact);
            if (liveKey && normalizedRaw.includes(liveKey)) score += 120;
            if (isPaleMissionCardBackground(cur)) score += 60;
            if (/\bPacjent(?:ci)?\b/i.test(raw)) score += 30;
            if (/\bDokładnie\s+1\s+pacjent\b/i.test(raw) || /\bDokladnie\s+1\s+pacjent\b/i.test(raw)) score += 40;
            score -= depth * 2;
            score -= Math.floor(raw.length / 500);

            candidates.push({ el: cur, raw, vehicleSegment, score, len: raw.length });
        }

        // Jeśli istnieje kandydat z sekcją Pacjenci, preferujemy go. To jest
        // kluczowe dla `1 Ambulans + Dokładnie 1 pacjent`.
        const withPatients = candidates.filter(c => /\bPacjent(?:ci)?\b/i.test(c.raw));
        const pool = withPatients.length ? withPatients : candidates;
        pool.sort((a, b) => b.score - a.score || a.len - b.len);
        return pool[0] || null;
    }

    function universalShortcutTargetFromCompleteCard(missionName = '') {
        const card = completeVisibleMissionCardForShortcutRules(missionName);
        if (!card) return null;

        const raw = card.raw;
        const vehicleKey = normalize(card.vehicleSegment || '');
        const water = extractResourceFromText(raw, 'water') || 0;
        const foam = extractResourceFromText(raw, 'foam') || 0;
        const maxPatients = extractMaxPatientsFromText(raw) || 0;
        const exactOnePatient =
            /\bDokładnie\s+1\s+pacjent\b/i.test(raw) ||
            /\bDokladnie\s+1\s+pacjent\b/i.test(raw) ||
            maxPatients === 1;

        if (
            vehicleKey === '1 ambulans' &&
            exactOnePatient &&
            water === 0 && foam === 0
        ) {
            log('Pełna karta: wymuszam skrót Ambulans (1 Ambulans + dokładnie 1 pacjent).');
            return 'Ambulans';
        }

        if (vehicleKey === '1 opi' && maxPatients === 0 && water === 0 && foam === 0) {
            return 'Radiowóz';
        }

        if (
            [
                '1 samochod pozarniczy',
                '1 samochody pozarnicze',
                '1 pojazd strazacki',
                '1 woz strazacki',
                '1 wozy strazackie'
            ].includes(vehicleKey) &&
            maxPatients === 0 && water === 0 && foam === 0 &&
            !/\bPacjent(?:ci)?\b/i.test(raw)
        ) {
            return 'Straż';
        }

        return null;
    }

    function visibleSpecialAutoSelectTarget(missionName = '') {
        const completeCardTarget = universalShortcutTargetFromCompleteCard(missionName);
        if (completeCardTarget) return completeCardTarget;

        const directTarget = directLiteralSpecialTargetFromVisibleCard(missionName);
        if (directTarget) return directTarget;

        const snapshot = strictVisibleSpecialSnapshot(missionName);
        const strictTarget = specialTargetFromStrictVisibleSnapshot(snapshot);
        if (strictTarget) return strictTarget;

        // Fallback dla starszych układów DOM, ale nadal na pełnym tekście karty.
        const cardText = snapshot?.raw || visibleMissionCardTextForSpecialRules(missionName);
        return strictSpecialAutoSelectTargetFromCardText(cardText);
    }

    function setHeaderAZRLookupState(stateName, targetName = '') {
        state.azrLookupState = stateName;
        state.azrLookupTargetName = targetName || '';

        const wrap = document.getElementById('orzr-header-actions');
        if (!wrap) return;

        const create = wrap.querySelector('[data-orzr-action="create"]');
        const save = wrap.querySelector('[data-orzr-action="save"]');
        const edit = wrap.querySelector('[data-orzr-action="edit"]');

        // AZR jest pierwszym krokiem. Dopóki trwa sprawdzanie, nie pokazujemy
        // akcji, które mogłyby utworzyć duplikat lub zapisać niepotrzebny capture.
        const canCreate = stateName === 'notfound';
        if (create) create.style.setProperty('display', canCreate ? 'inline-block' : 'none', 'important');
        if (save) save.style.setProperty('display', canCreate ? 'inline-block' : 'none', 'important');
        if (edit) edit.style.setProperty('display', 'inline-block', 'important');

        if (stateName === 'found' && targetName) {
            wrap.dataset.orzrAzrFound = '1';
            wrap.dataset.orzrAzrTarget = targetName;
        } else {
            delete wrap.dataset.orzrAzrFound;
            delete wrap.dataset.orzrAzrTarget;
        }
    }

    function findAAOButtonAnywhereById(id) {
        if (id == null || id === '') return null;
        const escaped = CSS.escape(String(id));
        const selectors = [
            `#aao_${escaped}`,
            `.aao_btn[aao_id="${escaped}"]`,
            `.aao_btn[data-aao-id="${escaped}"]`,
            `.aao[aao_id="${escaped}"]`,
            `.aao[data-aao-id="${escaped}"]`,
            `[aao_id="${escaped}"]`,
            `[data-aao-id="${escaped}"]`
        ];
        for (const selector of selectors) {
            try {
                const el = document.querySelector(selector);
                if (el) return el;
            } catch {}
        }
        return null;
    }

    function activeAAOCategoryControl(group) {
        const root = group || document;
        const controls = [
            ...root.querySelectorAll?.('.nav-tabs li.active a, .nav-pills li.active a, a.active[data-toggle="tab"], a.active[data-bs-toggle="tab"], [role="tab"][aria-selected="true"]') || [],
            ...document.querySelectorAll('.nav-tabs li.active a, .nav-pills li.active a, a.active[data-toggle="tab"], a.active[data-bs-toggle="tab"], [role="tab"][aria-selected="true"]')
        ];
        return controls.find(Boolean) || null;
    }

    function markAutoSelectCompleted(missionKey, aaoId, targetName, group = null, resultState = 'found') {
        state.autoSelectCompletedMissionKey = missionKey || '';
        state.autoSelectCompletedAAOId = aaoId ?? null;
        state.autoSelectCompletedTargetName = targetName || '';
        state.autoSelectCompletedState = resultState || 'found';
        clearTimeout(state.autoSelectRetryTimer);
        state.autoSelectRetryTimer = null;

        if (group?.dataset && missionKey) {
            group.dataset.orzrAutoSelectedMission = missionKey;
            group.dataset.orzrAutoSelectedAao = aaoId == null ? '' : String(aaoId);
        }
    }

    function clearAutoSelectCompleted() {
        state.autoSelectCompletedMissionKey = '';
        state.autoSelectCompletedAAOId = null;
        state.autoSelectCompletedTargetName = '';
        state.autoSelectCompletedState = '';
    }

    async function clickAAOFromVisibleAZR(group, aaoId, targetName, categoryId, control = null) {
        const azrControl = control || findAZRCategoryControl(group, categoryId) || findAZRControlDirect(group);
        if (!azrControl || !isDisplayedInInterface(azrControl)) {
            return { ok: false, reason: 'azr-hidden' };
        }

        const previous = activeAAOCategoryControl(group);

        try {
            showAZRCategory(azrControl);
            const target = await waitForAAOAfterAZRSwitch(group, azrControl, targetName, aaoId);
            if (!target) return { ok: false, reason: 'not-rendered' };
            if (!isAAOAvailable(target)) return { ok: false, reason: 'unavailable' };

            ensureAutoSelectStyle();
            target.classList.add('orzr-auto-selected-aao');
            target.title = `${target.title ? target.title + ' | ' : ''}Automatycznie wybrane przez Menedżer ZR z kategorii AZR`;
            target.click();
            await waitMs(120);
            return { ok: true, target };
        } finally {
            if (previous && previous !== azrControl && isDisplayedInInterface(previous)) {
                try { previous.click(); } catch {}
            }
        }
    }

    async function autoSelectMatchingAAO() {
        if (isAAOEditor() || state.autoSelectBusy) return;

        const earlySpecialTarget = visibleSpecialAutoSelectTarget();
        const missionName = currentMissionNameForAutoSelect();
        if (!missionName && !earlySpecialTarget) return;

        const missionKey = currentMissionIdentityForAutoSelect(missionName, earlySpecialTarget);
        if (!missionKey) return;

        // Najważniejsza poprawka v3.11: ta sama misja + ta sama już wybrana ZR
        // kończy się NATYCHMIAST. MutationObserver nie może ponownie klikać AAO.
        if (state.autoSelectCompletedMissionKey === missionKey) {
            const completedState = state.autoSelectCompletedState || state.azrLookupState || 'found';
            const headerState = completedState === 'selected' ? 'found' : completedState;
            setHeaderAZRLookupState(headerState, state.autoSelectCompletedTargetName || '');

            // v3.15.07: jeżeli ZR została faktycznie kliknięta, MutationObserver
            // ma również odtworzyć fioletowy status, gdy nagłówek został chwilowo
            // przebudowany przez grę. Nie klikamy ZR ponownie.
            if (completedState === 'selected' && state.autoSelectCompletedTargetName) {
                showAutoSelectStatus(state.autoSelectCompletedTargetName);
            }
            return;
        }

        // Nowa misja = czyścimy blokadę poprzedniej i od razu chowamy UTWÓRZ/ZAPISZ. Najpierw musi zakończyć się
        // sprawdzenie AZR. To zapobiega tworzeniu duplikatów.
        if (state.autoSelectMissionKey !== missionKey) {
            clearAutoSelectCompleted();
            state.autoSelectMissionKey = missionKey;
            state.autoSelectFirstSeenAt = Date.now();
            state.autoSelectAttempts = 0;
            state.azrLookupMissionKey = missionKey;
            state.azrLookupState = 'checking';
            state.azrLookupTargetName = '';
            state.azrLookupTargetId = null;
            setHeaderAZRLookupState('checking');
            clearTimeout(state.autoSelectRetryTimer);
            state.autoSelectRetryTimer = setTimeout(() => autoSelectMatchingAAO(), 300);
            return;
        }

        if (state.azrLookupMissionKey !== missionKey) {
            state.azrLookupMissionKey = missionKey;
            state.azrLookupState = 'checking';
            setHeaderAZRLookupState('checking');
        }

        if (Date.now() - state.autoSelectFirstSeenAt < 250) return;
        state.autoSelectAttempts += 1;

        const group = document.getElementById('mission-aao-group') || document.body;
        if (!group) return;

        state.autoSelectBusy = true;

        try {
            let categoryId = await loadAZRCategoryId(false);
            if (categoryId == null || categoryId === '') {
                await loadAZRCategoryId(true);
                categoryId = state.azrCategoryId;
            }

            const azrControl = findAZRCategoryControl(group, categoryId) || findAZRControlDirect(group);
            if (!azrControl || !isDisplayedInInterface(azrControl)) {
                log('Auto-wybór: kategoria AZR jest ukryta lub niedostępna w interfejsie — auto-zaznaczanie pominięte.');
                setHeaderAZRLookupState('notfound');
                removeAutoSelectStatus();
                markAutoSelectCompleted(missionKey, null, '', group, 'notfound');
                return;
            }

            if (categoryId == null || categoryId === '') {
                log('Auto-wybór: nie znaleziono ID widocznej kategorii AZR.');
                setHeaderAZRLookupState('notfound');
                markAutoSelectCompleted(missionKey, null, '', group, 'notfound');
                return;
            }

            const matchMissionName = stripFalseAlarmSuffix(missionName) || missionName;
            const missionNameKey = exactMissionNameKey(matchMissionName);
            const namedSpecialTarget =
                missionNameKey === exactMissionNameKey('Transport pacjenta')
                    ? 'Ambulans T'
                    : (missionNameKey.startsWith(exactMissionNameKey('Transport krytyczny')) ? 'A TK' : null);

            let exactMissionAAO = await apiAAOForAZR(matchMissionName, categoryId);
            if (!exactMissionAAO && state.autoSelectAttempts === 1) {
                await loadAAOsForAutoSelect(true);
                exactMissionAAO = await apiAAOForAZR(matchMissionName, categoryId);
            }

            let liveSpecialTarget = visibleSpecialAutoSelectTarget(missionName) || earlySpecialTarget;

            // v3.13: dodatkowy bezpiecznik dla najczęstszego fałszywego skrótu.
            // Gdy w AZR istnieje ZR o dokładnej nazwie misji, `Ambulans` może ją
            // zastąpić tylko wtedy, gdy pełna widoczna karta naprawdę ma pustą
            // sekcję Pojazdy albo dokładnie `1 Ambulans`.
            if (liveSpecialTarget === 'Ambulans' && exactMissionAAO) {
                const strictCardText = visibleMissionCardTextForSpecialRules(missionName);
                const strictVehicleSegment = getVehiclesTextSegmentFromCardText(strictCardText);
                const strictVehicleKey = normalize(strictVehicleSegment);
                if (strictVehicleKey && strictVehicleKey !== '1 ambulans') {
                    log('Odrzucono fałszywy skrót Ambulans — pełna karta zawiera inne wymagania pojazdów:', strictVehicleSegment);
                    liveSpecialTarget = null;
                }
            }

            let targetName;
            if (namedSpecialTarget) {
                targetName = namedSpecialTarget;
            } else if (liveSpecialTarget) {
                targetName = liveSpecialTarget;
            } else if (exactMissionAAO) {
                targetName = matchMissionName;
            } else {
                targetName = await autoSelectTargetName(missionName);
            }

            if (!exactMissionNameKey(targetName)) {
                if (state.autoSelectAttempts <= 8) {
                    setHeaderAZRLookupState('checking');
                    scheduleAutoSelectRetry(150);
                }
                return;
            }

            let apiAAO = exactMissionAAO && exactMissionNameKey(targetName) === exactMissionNameKey(matchMissionName)
                ? exactMissionAAO
                : await apiAAOForAZR(targetName, categoryId);
            if (!apiAAO && (state.autoSelectAttempts === 1 || state.autoSelectAttempts === 3)) {
                await loadAAOsForAutoSelect(true);
                apiAAO = await apiAAOForAZR(targetName, categoryId);
            }

            if (!apiAAO) {
                // v3.15.11: gdy nie znaleziono ZR o nazwie misji, nie kończymy
                // od razu tej misji. Żółta karta (zwłaszcza sekcja Pacjenci)
                // potrafi doładować się chwilę później. Bez tego skrypt zapisywał
                // stan `notfound` zanim zdążył rozpoznać `Ambulans`/`Straż`.
                if (
                    !namedSpecialTarget &&
                    !liveSpecialTarget &&
                    exactMissionNameKey(targetName) === exactMissionNameKey(matchMissionName) &&
                    state.autoSelectAttempts < 5
                ) {
                    setHeaderAZRLookupState('checking');
                    scheduleAutoSelectRetry(180);
                    return;
                }

                // v3.15.08: dla skrótów Ambulans/Radiowóz/Straż nie kończymy
                // sprawdzania po pierwszym odczycie API. Lista ZR i żółta karta
                // potrafią pojawić się w różnej kolejności. Dajemy kilka krótkich
                // prób, zanim uznamy, że skrótowej ZR naprawdę nie ma w AZR.
                if (['Ambulans', 'Radiowóz', 'Straż'].includes(targetName) && state.autoSelectAttempts < 4) {
                    setHeaderAZRLookupState('checking');
                    await loadAAOsForAutoSelect(true);
                    scheduleAutoSelectRetry(140);
                    return;
                }

                if (!getVisibleMissionRequirementSnapshot() && state.autoSelectAttempts <= 8) {
                    setHeaderAZRLookupState('checking');
                    scheduleAutoSelectRetry(150);
                    return;
                }

                // Nie ma ZR w AZR: dopiero TERAZ można udostępnić UTWÓRZ/ZAPISZ.
                log(`Auto-wybór: w AZR nie ma ZR „${targetName}”. Udostępniam tworzenie.`);
                state.azrLookupTargetId = null;
                setHeaderAZRLookupState('notfound');
                returnToPozaryCategory(group);
                removeAutoSelectStatus();
                markAutoSelectCompleted(missionKey, null, targetName, group, 'notfound');
                return;
            }

            const aaoId = apiAAO?.id ?? apiAAO?.aao_id ?? null;
            state.azrLookupTargetId = aaoId;
            setHeaderAZRLookupState('found', targetName);

            // AZR istnieje -> nie wolno pokazywać UTWÓRZ/ZAPISZ, nawet jeśli sama
            // misja już trwa albo przycisk AAO jest chwilowo niewyrenderowany.
            // Użytkownik ma wtedy tylko EDYTUJ ZR.
            if (aaoId == null || aaoId === '') {
                log(`ZR „${targetName}” istnieje w AZR, ale API nie zwróciło ID.`);
                markAutoSelectCompleted(missionKey, null, targetName, group, 'found');
                showAutoSelectStatus(targetName);
                return;
            }

            if (isMissionAlreadyRunning()) {
                removeAutoSelectStatus();
                // Misja już trwa: świadomie kończymy auto-wybór dla tej instancji,
                // żeby obserwator nie próbował ponownie po każdej zmianie DOM.
                markAutoSelectCompleted(missionKey, aaoId, targetName, group, 'found');
                return;
            }

            // Krok 3: zaznaczamy wyłącznie przez prawdziwy przycisk w widocznej
            // kategorii AZR, aby natywny handler gry zbudował listę do wysyłki.
            const clicked = await clickAAOFromVisibleAZR(group, aaoId, targetName, categoryId, azrControl);

            if (!clicked.ok) {
                // Nie tworzymy duplikatu — AZR została potwierdzona przez API.
                // Przy leniwym DOM próbujemy jeszcze kilka razy.
                log(`ZR „${targetName}” istnieje w AZR, ale nie udało się jeszcze kliknąć przycisku (${clicked.reason}).`);
                if (clicked.reason !== 'unavailable' && state.autoSelectAttempts < 8) {
                    scheduleAutoSelectRetry(160);
                    return;
                }
                // Po wyczerpaniu prób kończymy tę misję zamiast wejść w pętlę.
                markAutoSelectCompleted(missionKey, aaoId, targetName, group, 'found');
                return;
            }

            // Zablokuj kolejne wywołania ZANIM pokażemy status i zanim
            // MutationObserver zobaczy zmiany DOM wywołane kliknięciem.
            markAutoSelectCompleted(missionKey, aaoId, targetName, group, 'selected');
            setTimeout(() => setAAOSearch(group, ''), 120);
            showAutoSelectStatus(targetName);
            log(`Automatycznie wybrano ZR „${targetName}” przez widoczną kategorię AZR.`);
        } catch (error) {
            console.warn(TAG, 'Automatyczny wybór ZR z AZR nie powiódł się:', error);
            if (state.autoSelectAttempts < 8) {
                setHeaderAZRLookupState('checking');
                scheduleAutoSelectRetry(200);
            } else {
                // Nie wolno pozostawić nieskończonej pętli po błędzie.
                const terminalState = state.azrLookupState === 'found' ? 'found' : 'notfound';
                setHeaderAZRLookupState(terminalState, state.azrLookupTargetName || '');
                markAutoSelectCompleted(missionKey, state.azrLookupTargetId, state.azrLookupTargetName || '', group, terminalState);
            }
        } finally {
            state.autoSelectBusy = false;
        }
    }

    // ------------------------------------------------------------------
    // RĘCZNE PRZEJŚCIE DO EDYCJI ISTNIEJĄCEGO ZR
    // ------------------------------------------------------------------

    function aaoCategoryValue(aao) {
        return aao?.aao_category_id ?? aao?.category_id ?? aao?.aaoCategoryId ?? null;
    }

    function isUncategorizedAAO(aao) {
        const value = aaoCategoryValue(aao);
        return value === null || value === undefined || value === '' || String(value) === '0';
    }

    async function editTargetNameCandidates(missionName) {
        const cleanMissionName = stripFalseAlarmSuffix(missionName) || sanitizeMissionName(missionName);
        const missionKey = exactMissionNameKey(cleanMissionName);
        if (!missionKey) return [];

        // Te dwie reguły nazwane są celowymi aliasami używanymi także przez
        // auto-zaznaczanie. Dla edycji otwieramy właśnie używaną ZR.
        if (missionKey === exactMissionNameKey('Transport pacjenta')) {
            return ['Ambulans T'];
        }
        if (missionKey.startsWith(exactMissionNameKey('Transport krytyczny'))) {
            return ['A TK'];
        }

        const candidates = [cleanMissionName];

        // Dla ogólnych skrótów (Ambulans/Radiowóz/Straż) najpierw próbujemy
        // znaleźć ZR o pełnej nazwie misji poza AZR. Dopiero gdy jej nie ma,
        // można otworzyć gotową ZR skrótową.
        try {
            const special = visibleSpecialAutoSelectTarget() || await autoSelectTargetName(missionName);
            if (special && exactMissionNameKey(special) !== missionKey) {
                candidates.push(special);
            }
        } catch (error) {
            console.warn(TAG, 'Nie udało się ustalić dodatkowej nazwy ZR do edycji:', error);
        }

        return [...new Set(candidates.map(sanitizeMissionName).filter(Boolean))];
    }

    async function findEditableAAOOutsideAZR(targetNames) {
        const names = Array.isArray(targetNames) ? targetNames : [targetNames];
        const wantedGroups = names
            .map(name => ({
                name,
                keys: new Set(zrNameCandidates(name).map(exactMissionNameKey).filter(Boolean))
            }))
            .filter(group => group.keys.size);

        if (!wantedGroups.length) return null;

        const [aaos, azrCategoryId] = await Promise.all([
            loadAAOsForAutoSelect(true),
            loadAZRCategoryId(false)
        ]);

        // Jeśli nie umiemy jednoznacznie zidentyfikować AZR, nie ryzykujemy
        // otwarcia technicznej kopii zamiast właściwej ZR użytkownika.
        if (azrCategoryId == null || azrCategoryId === '') {
            throw new Error('Nie udało się rozpoznać własnej kategorii AZR.');
        }

        const list = Array.isArray(aaos) ? aaos : [];

        for (const group of wantedGroups) {
            const matches = list.filter(aao => {
                if (!aao || isUncategorizedAAO(aao)) return false;

                const categoryId = aaoCategoryValue(aao);
                if (String(categoryId ?? '') === String(azrCategoryId)) return false;

                const caption = aao?.caption ?? aao?.name ?? aao?.title ?? '';
                return group.keys.has(exactMissionNameKey(caption));
            });

            if (matches.length) {
                if (matches.length > 1) {
                    log(`EDYTUJ ZR: znaleziono ${matches.length} pasujące ZR „${group.name}” poza AZR/Bez kategorii; otwieram pierwszą.`);
                }
                return matches[0];
            }
        }

        return null;
    }

    async function openMatchingAAOEditor(currentCapture = null) {
        const liveMissionName = currentMissionNameForAutoSelect() || exactMissionTitleFromGame();
        const capturedMissionName = currentCapture?.name || '';
        const missionName = liveMissionName || capturedMissionName;
        const cleanMissionName = stripFalseAlarmSuffix(missionName) || sanitizeMissionName(missionName);

        if (!exactMissionNameKey(cleanMissionName)) {
            alert('Menedżer ZR: nie udało się odczytać nazwy aktualnej misji.');
            return false;
        }

        // EDYTUJ ZR musi przenieść do edytora wymagania BIEŻĄCEJ misji,
        // a nie poprzednio zapamiętanej. Jeśli capture podał inną/pustą nazwę,
        // wymuszamy nazwę odczytaną bezpośrednio z aktualnego okna misji.
        if (currentCapture) {
            const captureKey = exactMissionNameKey(stripFalseAlarmSuffix(currentCapture.name) || sanitizeMissionName(currentCapture.name));
            const liveKey = exactMissionNameKey(cleanMissionName);
            if (!captureKey || captureKey !== liveKey) {
                currentCapture.name = cleanMissionName;
            }
            state.capture = currentCapture;
            saveJSON(CAPTURE_KEY, currentCapture);
        }

        const targetNames = await editTargetNameCandidates(cleanMissionName);
        const aao = await findEditableAAOOutsideAZR(targetNames);

        if (!aao) {
            alert(
                'Menedżer ZR: nie znaleziono pasującej ZR do edycji.\n\n' +
                'Przeszukano wszystkie kategorie z wyjątkiem:\n' +
                '- AZR\n' +
                '- Bez kategorii\n\n' +
                'Misja: ' + cleanMissionName
            );
            return false;
        }

        const id = aao?.id ?? aao?.aao_id;
        if (id == null || id === '') {
            alert('Menedżer ZR: znaleziono ZR, ale nie udało się odczytać jej ID.');
            return false;
        }

        const url = new URL(`/aaos/${id}/edit`, location.origin);
        url.searchParams.set('orzr_edit_from_mission', '1');
        url.searchParams.set('orzr_mission_name', cleanMissionName);
        try {
            GM_openInTab(url.href, { active: true, insert: true });
        } catch {
            window.open(url.href, '_blank');
        }

        return true;
    }

    // ------------------------------------------------------------------
    // PRZYCISKI W NAGŁÓWKU
    // ------------------------------------------------------------------

    function removeHeaderButtons() {
        document.getElementById('orzr-header-actions')?.remove();
        removeAutoSelectStatus();
        state.azrLookupState = 'idle';
        state.azrLookupMissionKey = '';
        state.azrLookupTargetName = '';
        state.azrLookupTargetId = null;
        // Nie czyścimy blokady zakończonego auto-wyboru przy chwilowym zniknięciu
        // nagłówka. Operator przebudowuje DOM po kliknięciu ZR i to właśnie
        // wcześniej uruchamiało ponowne zaznaczanie w pętli.
    }

    function ensureHeaderButtons() {
        if (/^\/aaos\//.test(location.pathname)) {
            removeHeaderButtons();
            return;
        }

        const header = findOpenedMissionHeader();

        // Jeżeli nie ma OTWARTEGO okna misji, przycisku nie może być nigdzie.
        if (!header) {
            removeHeaderButtons();
            return;
        }

        // Jeśli przycisk istnieje, ale został w starym/innym nagłówku, przenieś go.
        const existing = document.getElementById('orzr-header-actions');
        if (existing && existing.parentElement !== header) {
            existing.remove();
        } else if (existing) {
            setHeaderAZRLookupState(state.azrLookupState || 'checking', state.azrLookupTargetName || '');
            return;
        }

        const title = findMissionTitleElement(header);

        // Header musi być pozycjonowany, aby przycisk został w jego obrębie.
        const cs = getComputedStyle(header);
        if (cs.position === 'static') header.style.position = 'relative';

        const wrap = document.createElement('div');
        wrap.id = 'orzr-header-actions';

        let left = 360;

        if (title) {
            const hr = header.getBoundingClientRect();
            const tr = title.getBoundingClientRect();
            left = Math.round(tr.right - hr.left + 18);
        }

        // Bezpieczny zakres.
        left = Math.max(330, Math.min(left, 720));

        wrap.style.cssText = [
            'position:absolute',
            `left:${left}px`,
            'top:5px',
            'z-index:99999',
            'display:flex',
            'gap:7px',
            'align-items:center'
        ].join(';');

        const create = document.createElement('button');
        create.type = 'button';
        create.dataset.orzrAction = 'create';
        create.textContent = '➕ UTWÓRZ ZR';
        create.title = 'Utwórz ZR na podstawie aktualnej misji';
        create.style.cssText = [
            'display:inline-block !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'height:34px !important',
            'padding:0 14px !important',
            'border:1px solid #3e8f3e !important',
            'border-radius:4px !important',
            'background:#5cb85c !important',
            'background-image:none !important',
            'color:#ffffff !important',
            'font:700 13px/32px Arial,sans-serif !important',
            'text-shadow:none !important',
            'box-shadow:0 1px 3px rgba(0,0,0,.35) !important',
            'cursor:pointer !important'
        ].join(';');

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.dataset.orzrAction = 'edit';
        edit.textContent = '✎ EDYTUJ ZR';
        edit.title = 'Znajdź ZR dla tej misji poza AZR i Bez kategorii i otwórz jej pełną edycję';
        edit.style.cssText = [
            'display:inline-block !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'height:34px !important',
            'padding:0 14px !important',
            'border:1px solid #2e6da4 !important',
            'border-radius:4px !important',
            'background:#337ab7 !important',
            'background-image:none !important',
            'color:#ffffff !important',
            'font:700 13px/32px Arial,sans-serif !important',
            'text-shadow:none !important',
            'box-shadow:0 1px 3px rgba(0,0,0,.35) !important',
            'cursor:pointer !important'
        ].join(';');

        const save = document.createElement('button');
        save.type = 'button';
        save.dataset.orzrAction = 'save';
        save.textContent = '💾';
        save.title = 'Zapamiętaj dane aktualnej misji';
        save.style.cssText = [
            'display:inline-block !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'width:36px !important',
            'height:34px !important',
            'padding:0 !important',
            'border:1px solid #aaa !important',
            'border-radius:4px !important',
            'background:#f5f5f5 !important',
            'background-image:none !important',
            'color:#222 !important',
            'font:700 15px/32px Arial,sans-serif !important',
            'text-shadow:none !important',
            'cursor:pointer !important'
        ].join(';');

        create.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (state.azrLookupState === 'found') {
                alert('Menedżer ZR: pasująca ZR już istnieje w kategorii AZR. Tworzenie nowej ZR jest zablokowane.');
                return;
            }

            const data = await captureMission();

            if (!data.vehicles.length && !data.water && !data.foam && !data.maxPatients) {
                alert(
                    'Menedżer ZR: nie udało się bezpiecznie odczytać wymagań tej misji.\n\n' +
                    (data.readError ? data.readError + '\n\n' : '') +
                    'Skrypt NIE pobierze wymagań z misji z sekcji „Może się rozwinąć w…”.\n\n' +
                    'Nazwa: ' + data.name
                );
                return;
            }

            const url = new URL('/aaos/new', location.origin);
            url.searchParams.set('orzr_from_mission', '1');
            if (data?.name) url.searchParams.set('orzr_mission_name', data.name);

            try {
                GM_openInTab(url.href, { active: true, insert: true });
            } catch {
                window.open(url.href, '_blank');
            }
        });

        edit.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const oldText = edit.textContent;
            edit.disabled = true;
            edit.textContent = 'SZUKAM…';

            try {
                // Zapisz aktualną misję tuż przed przejściem do edycji.
                // Dzięki temu panel edytora nie może odziedziczyć wymagań poprzedniej misji.
                const currentCapture = await captureMission();
                await openMatchingAAOEditor(currentCapture);
            } catch (error) {
                console.warn(TAG, 'Nie udało się otworzyć ZR do edycji:', error);
                alert('Menedżer ZR: ' + (error?.message || String(error)));
            } finally {
                if (document.contains(edit)) {
                    edit.disabled = false;
                    edit.textContent = oldText;
                }
            }
        });

        save.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (state.azrLookupState === 'found') return;

            const data = await captureMission();
            save.textContent = '✓';

            setTimeout(() => {
                if (document.contains(save)) save.textContent = '💾';
            }, 1400);
        });

        wrap.append(create, edit, save);
        header.appendChild(wrap);

        // AZR zawsze jest sprawdzane przed pokazaniem UTWÓRZ/ZAPISZ.
        setHeaderAZRLookupState(state.azrLookupState === 'notfound' ? 'notfound' : (state.azrLookupState === 'found' ? 'found' : 'checking'), state.azrLookupTargetName || '');

        log('Dodano przyciski do nagłówka misji.', header);
        // Auto-wybór uruchamia wyłącznie główny skaner. Wcześniej był wywoływany
        // tutaj i drugi raz w scan(), co powodowało równoległe próby i miganie.
    }

    // ------------------------------------------------------------------
    // EDYTOR ZR
    // ------------------------------------------------------------------

    function isAAOEditor() {
        return /^\/aaos\/(?:new|\d+\/(?:edit|copy))\/?$/.test(location.pathname);
    }

    function isExistingAAOEdit() {
        return /^\/aaos\/\d+\/edit\/?$/.test(location.pathname);
    }

    function dispatchFormControlEvents(control) {
        if (!control) return;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function applyAAOEditorAppearanceDefaults() {
        // v3.15.15: przy edycji istniejącej ZR NIE zmieniamy koloru tła.
        // Zachowujemy dokładnie wartość zapisaną w edytowanej ZR.
        // Jedyną zmianą wyglądu jest włączenie automatycznego koloru tekstu.
        // Nie dotyczy to tworzenia nowej ZR (/aaos/new).
        if (!isExistingAAOEdit()) return;

        const named = [...document.querySelectorAll('input[name], select[name]')];

        // W API gry za automatyczny dobór koloru odpowiada `automatic_text_color`.
        // Rails może generować hidden + checkbox o tej samej nazwie, dlatego
        // ustawiamy przede wszystkim checkbox, a hidden zostawiamy bez zmian.
        const autoCandidates = named.filter(control => {
            const key = `${control.name || ''} ${control.id || ''}`.toLowerCase();
            return key.includes('automatic_text_color') || key.includes('automatic-text-color');
        });

        const autoCheckbox = autoCandidates.find(control => String(control.type || '').toLowerCase() === 'checkbox');
        if (autoCheckbox) {
            autoCheckbox.checked = true;
            dispatchFormControlEvents(autoCheckbox);
        } else {
            const autoControl = autoCandidates.find(control => String(control.type || '').toLowerCase() !== 'hidden');
            if (autoControl) {
                if (autoControl.tagName === 'SELECT') {
                    const option = [...autoControl.options].find(opt => {
                        const text = normalize(opt.textContent || '');
                        return text.includes('automat') || String(opt.value).toLowerCase() === 'true' || String(opt.value) === '1';
                    });
                    if (option) autoControl.value = option.value;
                } else {
                    autoControl.value = '1';
                }
                dispatchFormControlEvents(autoControl);
            }
        }

        log('Edycja ZR: pozostawiono kolor tła bez zmian; włączono automatyczny kolor tekstu.');
    }

    function labelFor(input) {
        if (input.id) {
            try {
                const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                if (label) return label.textContent.replace(/\s+/g, ' ').trim();
            } catch {}
        }

        return input.closest('.form-group,.control-group,.row')?.querySelector('label')?.textContent
            ?.replace(/\s+/g, ' ').trim() || '';
    }

    function isAAOAppearanceField(input, label = '', name = '') {
        const rawName = String(name || input?.name || '');
        const rawLabel = String(label || '');
        const nn = normalize(rawName);
        const nl = normalize(rawLabel);
        const idn = normalize(input?.id || '');
        const cls = normalize(input?.className || '');
        const type = String(input?.type || '').toLowerCase();

        // Pola wyglądu ZR NIE są wymaganiami pojazdów. Wcześniej ogólna reguła
        // `aao[...]` mogła potraktować m.in. kolor tła i kolor tekstu jak pole ZR,
        // a `Zastąp ZR` zerowało je lub wpisywało do nich liczbę pojazdów.
        if (type === 'color') return true;

        const text = `${nn} ${nl} ${idn} ${cls}`;
        return (
            /(?:^|\s)(?:color|colour|kolor)(?:\s|$)/.test(text) ||
            /background|background color|bg color|kolor tla|tlo/.test(text) ||
            /text color|font color|foreground|kolor tekstu|kolor czcionki/.test(text) ||
            /aao color|aao text color|aao background/.test(text)
        );
    }

    function collectFields() {
        const result = [];

        for (const input of document.querySelectorAll('input[name]')) {
            if (input.disabled) continue;
            if (['hidden', 'button', 'submit', 'checkbox', 'radio'].includes(input.type)) continue;

            const label = labelFor(input);
            const name = input.name || '';

            // v3.15.09: całkowicie wykluczamy ustawienia wyglądu z Menedżera ZR.
            // Ani Uzupełnij ZR, ani Zastąp ZR nie może dotknąć kolorów.
            if (isAAOAppearanceField(input, label, name)) continue;

            const nl = normalize(label);
            const nn = normalize(name);

            let kind = 'other';

            if (nn.includes('caption') || nl === 'nazwa' || nl.includes('nazwa zr') || nl.includes('nazwa reguly')) {
                kind = 'caption';
            } else if (nl.includes('wod') || nn.includes('water')) {
                kind = 'water';
            } else if (nl.includes('pian') || nn.includes('foam')) {
                kind = 'foam';
            } else if (/^(aao\[|vehicle_type_ids\[|vehicle_type_caption\[)/.test(name) || input.type === 'number') {
                kind = 'vehicle';
            }

            result.push({ input, name, label: label || name, kind });
        }

        state.fields = result;
        return result;
    }

    function expand(text) {
        let n = normalize(text);

        const aliases = [
            [/samochody? pozarnicze/g, ' straz pozarna samochod pozarniczy '],
            [/samochody? ratownictwa technicznego/g, ' technik ratownictwo techniczne '],
            [/pojazdy? ratownictwa technicznego/g, ' technik ratownictwo techniczne '],
            [/samochody? wezowe/g, ' weze wezowy '],
            [/samochody? dowodzenia i lacznosci/g, ' dil dowodzenie lacznosc '],
            [/sp rchem/g, ' rchem '],
            [/samochody? spgaz/g, ' spgaz '],
            [/radiowozy? wrd/g, ' radiowoz wrd '],
            [/radiowozy?/g, ' radiowoz '],
            [/sh lub sd/g, ' drabina sh sd '],
            [/slop lub slrr/g, ' oficer operacyjny slop slrr '],
            [/slop slrr/g, ' oficer operacyjny slop slrr '],
            [/sccn/g, ' sccn cysterna woda '],
            [/cysterny?/g, ' cysterna woda '],
            [/piana gasnicza/g, ' piana '],
            [/(?:^|\s)k\s*9(?:\s|$)/g, ' k9 pies policyjny '],
            [/^opi$/g, ' opi furgonetka policja '],
            [/ambulanse? s lub p/g, ' ambulans s p ratownictwo medyczne '],
            [/ambulanse?/g, ' ambulans s p ratownictwo medyczne ']
        ];

        for (const [re, value] of aliases) n = n.replace(re, value);
        return n.replace(/\s+/g, ' ').trim();
    }

    function words(text) {
        const stop = new Set(['i', 'oraz', 'lub', 'albo', 'do', 'na', 'z', 'ze', 'w', 'pojazd', 'pojazdy']);
        return new Set(expand(text).split(' ').filter(x => x.length > 1 && !stop.has(x)));
    }

    function score(a, b) {
        const na = expand(a);
        const nb = expand(b);

        if (!na || !nb) return 0;
        if (na === nb) return 1;
        if (na.includes(nb) || nb.includes(na)) return .9;

        const aa = words(na);
        const bb = words(nb);
        if (!aa.size || !bb.size) return 0;

        let common = 0;
        for (const w of aa) if (bb.has(w)) common++;

        let s = common / new Set([...aa, ...bb]).size;

        if ([...aa].some(w => w.length >= 3 && w.length <= 7 && bb.has(w))) s += .22;

        return Math.min(1, s);
    }

    function requirementKey(req) {
        return `${req.kind}:${normalize(req.label)}`;
    }

    function bestField(req) {
        const manualName = state.map[requirementKey(req)];
        if (manualName) {
            const f = state.fields.find(x => x.name === manualName);
            if (f) return f;
        }

        // v3.15.16: SCCn mapujemy jawnie do pola cysterny z wodą.
        if (req.kind === 'vehicle' && normalize(req.label).trim() === 'sccn') {
            const vehicleFields = state.fields.filter(x => x.kind === 'vehicle');
            const exactNames = [
                'sccn',
                'cysterna',
                'cysterna z woda',
                'cysterna wody',
                'samochod cysterna',
                'samochod cysterna z woda',
                'samochod cysterna wody'
            ];
            const exact = vehicleFields.find(x => exactNames.includes(normalize(x.label)));
            if (exact) return exact;

            const fallback = vehicleFields.find(x => {
                const n = normalize(x.label);
                return n.includes('cysterna') && !n.includes('piana');
            });
            if (fallback) return fallback;
        }

        // v3.15: K-9 ma cyfrę w nazwie, dlatego obsługujemy go jawnie i nie
        // pozwalamy fuzzy-matchingowi pomylić go z OPI ani innym polem liczbowym.
        if (req.kind === 'vehicle') {
            const rk9 = normalize(req.label)
                .replace(/\s+/g, ' ')
                .trim();
            if (rk9 === 'k 9' || rk9 === 'k9' || rk9 === 'pojazd k 9' || rk9 === 'pojazd k9') {
                const vehicleFields = state.fields.filter(x => x.kind === 'vehicle');
                const k9Field = vehicleFields.find(x => {
                    const n = normalize(x.label).replace(/\s+/g, ' ').trim();
                    return n === 'k 9' || n === 'k9' || n === 'pojazd k 9' || n === 'pojazd k9' ||
                           /(?:^|\s)k\s*9(?:\s|$)/.test(n);
                });
                if (k9Field) return k9Field;
            }
        }

        // v3.15.05: krótkie etykiety z widocznej karty mapujemy jawnie.
        // `WRD` z sekcji Pojazdy oznacza pojazd/radiowóz WRD, a nie wymaganie
        // budynku `Wydział Ruchu Drogowego`.
        if (req.kind === 'vehicle') {
            const rn = normalize(req.label).trim();
            const vehicleFields = state.fields.filter(x => x.kind === 'vehicle');

            if (rn === 'opi') {
                const f = vehicleFields.find(x => {
                    const n = normalize(x.label);
                    return n === 'opi' || n === 'pojazd opi' || n === 'radiowoz opi';
                });
                if (f) return f;
            }

            if (rn === 'wrd') {
                const exactNames = ['wrd', 'pojazd wrd', 'radiowoz wrd', 'radiowozy wrd'];
                const f = vehicleFields.find(x => exactNames.includes(normalize(x.label)));
                if (f) return f;
            }
        }

        // Pacjenci: nie używamy tu fuzzy-matchingu. Szukamy konkretnego pola
        // odpowiadającego ambulansowi S/P. W interfejsie Operatora najczęściej
        // jest ono opisane po prostu jako "Ambulans".
        if (
            req.kind === 'vehicle' &&
            normalize(req.label) === 'ambulans s lub p'
        ) {
            const vehicleFields = state.fields.filter(x => x.kind === 'vehicle');

            const exactLabels = [
                'ambulans s lub p',
                'ambulans p lub s',
                'ambulans',
                'ambulans ratunkowy'
            ];

            for (const wanted of exactLabels) {
                const f = vehicleFields.find(x => normalize(x.label) === wanted);
                if (f) return f;
            }

            // Jeżeli gra używa pełniejszej nazwy, dopuszczamy pole zawierające
            // "ambulans", ale wykluczamy transportowy T.
            const fallback = vehicleFields.find(x => {
                const n = normalize(x.label);
                return n.includes('ambulans') &&
                    !n.includes('ambulans t') &&
                    !n.includes('transport');
            });

            if (fallback) return fallback;
        }

        // Wymagania alternatywne / łączone nie mogą być dopasowywane
        // do przypadkowego pojedynczego typu (np. do "SH lub SD").
        if (req.kind === 'vehicle') {
            const rn = normalize(req.label);
            const vehicleFields = state.fields.filter(x => x.kind === 'vehicle');

            // "wozy strażackie lub pojazdy ratownictwa technicznego"
            if (
                rn.includes('ratownictwa technicznego') &&
                (rn.includes('wozy strazackie') || rn.includes('samochody pozarnicze') || rn.includes('samochod pozarniczy'))
            ) {
                const exactCombo = vehicleFields.find(f => {
                    const fn = normalize(f.label);
                    return fn.includes('ratownictwa technicznego') &&
                        (fn.includes('wozy strazackie') || fn.includes('samochody pozarnicze') || fn.includes('samochod pozarniczy'));
                });
                return exactCombo || null;
            }

            // "pojazdy ratownictwa technicznego, SH lub SD" – wymagamy pola,
            // które rzeczywiście zawiera oba człony. W przeciwnym razie zostawiamy
            // do ręcznego przypisania zamiast wybierać błędne SH/SD.
            if (
                rn.includes('ratownictwa technicznego') &&
                (rn.includes('sh') || rn.includes('sd'))
            ) {
                const exactCombo = vehicleFields.find(f => {
                    const fn = normalize(f.label);
                    return fn.includes('ratownictwa technicznego') &&
                        (fn.includes('sh') || fn.includes('sd'));
                });
                return exactCombo || null;
            }
        }

        if (req.kind === 'water') {
            const f = state.fields.find(x => x.kind === 'water');
            if (f) return f;
        }

        if (req.kind === 'foam') {
            const f = state.fields.find(x => x.kind === 'foam');
            if (f) return f;
        }

        const pool = req.kind === 'vehicle'
            ? state.fields.filter(x => x.kind === 'vehicle')
            : state.fields.filter(x => x.kind !== 'caption');

        let best = null;
        let bestScore = 0;

        for (const f of pool) {
            const s = score(req.label, f.label);
            if (s > bestScore) {
                best = f;
                bestScore = s;
            }
        }

        return bestScore >= .58 ? best : null;
    }

    function setInput(input, value) {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function requirements() {
        if (!state.capture) return [];

        const list = state.capture.vehicles.map(v => ({
            kind: 'vehicle',
            label: v.label,
            value: v.count,
            chance: v.chance
        }));

        if (state.capture.water > 0) list.push({ kind: 'water', label: 'Woda', value: state.capture.water });
        if (state.capture.foam > 0) list.push({ kind: 'foam', label: 'Piana', value: state.capture.foam });

        // Zasada Menedżera ZR OR:
        // maksymalna liczba pacjentów = dokładnie tyle Ambulansów S lub P.
        const maxPatients = Number.parseInt(state.capture.maxPatients, 10);

        if (Number.isFinite(maxPatients) && maxPatients > 0) {
            list.push({
                kind: 'vehicle',
                label: 'Ambulans S lub P',
                value: maxPatients,
                chance: null
            });
        }

        return list;
    }

    function renderEditor() {
        const tbody = document.getElementById('orzr-editor-body');
        if (!tbody) return;

        tbody.innerHTML = '';

        const reqs = requirements();

        if (!reqs.length) {
            tbody.innerHTML = '<tr><td colspan="4">Brak zapisanej misji.</td></tr>';
            return;
        }

        for (const req of reqs) {
            const tr = document.createElement('tr');
            const field = bestField(req);

            const td1 = document.createElement('td');
            td1.textContent = req.label + (req.chance ? ` (${req.chance}%)` : '');

            const td2 = document.createElement('td');
            td2.textContent = req.value;

            const td3 = document.createElement('td');

            const select = document.createElement('select');
            select.className = 'form-control input-sm';

            const none = document.createElement('option');
            none.value = '';
            none.textContent = '— nie przypisano —';
            select.append(none);

            for (const f of state.fields.filter(x => x.kind !== 'caption')) {
                const opt = document.createElement('option');
                opt.value = f.name;
                opt.textContent = f.label;
                if (field?.name === f.name) opt.selected = true;
                select.append(opt);
            }

            select.addEventListener('change', () => {
                if (select.value) state.map[requirementKey(req)] = select.value;
                else delete state.map[requirementKey(req)];

                saveJSON(MAP_KEY, state.map);
                renderEditor();
            });

            td3.append(select);

            const td4 = document.createElement('td');
            td4.textContent = field ? (field.input.value || '0') : '—';

            tr.append(td1, td2, td3, td4);
            tbody.append(tr);
        }
    }

    function applyCapturedMission(replace = false) {
        const reqs = requirements();

        if (replace) {
            // Zerujemy wyłącznie rzeczywiste pola wymagań. Nie używamy już
            // samego prefiksu `aao[...]`, bo pod nim znajdują się też ustawienia
            // wyglądu (np. kolor tła / tekstu).
            for (const f of state.fields.filter(x => ['vehicle', 'water', 'foam'].includes(x.kind))) {
                setInput(f.input, 0);
            }
        }

        for (const req of reqs) {
            const f = bestField(req);
            if (!f) continue;

            const current = Number.parseInt(f.input.value || '0', 10) || 0;
            const isPatientAmbulance =
                req.kind === 'vehicle' &&
                ['ambulans s lub p', 'ambulans p'].includes(normalize(req.label));

            // Dla pacjentów obowiązuje dokładna zasada:
            // Maksimum pacjentów = dokładnie tyle ambulansów S/P.
            // Nie używamy Math.max(), bo poprzednia/błędna wartość pola
            // (np. 1212) nie może zostać zachowana.
            const target = isPatientAmbulance
                ? Number(req.value)
                : (replace ? req.value : Math.max(current, req.value));

            setInput(f.input, target);
        }

        const caption = state.fields.find(x => x.kind === 'caption');
        if (caption && state.capture?.name && !caption.input.value.trim()) {
            const safeName = zrNameForEditor(state.capture.name);
            if (safeName) {
                setInput(caption.input, safeName);
            } else {
                console.warn(TAG, 'Nie wpisuję podejrzanej nazwy ZR:', state.capture.name);
            }
        }

        renderEditor();
    }

    function buildEditorPanel() {
        if (!isAAOEditor()) return;
        if (document.getElementById('orzr-editor')) return;

        // Przy edycji istniejącej ZR nie zmieniamy koloru tła.
        // Ustawiamy wyłącznie automatyczny kolor tekstu.
        applyAAOEditorAppearanceDefaults();
        collectFields();

        // Nie pokazuj wymagań z poprzedniej misji. Przy przejściu z przycisku
        // UTWÓRZ/EDYTUJ przekazujemy nazwę źródłowej misji w URL i sprawdzamy,
        // czy zapisany capture rzeczywiście dotyczy tej samej misji.
        const editorParams = new URLSearchParams(location.search);
        const fromMissionContext =
            editorParams.get('orzr_from_mission') === '1' ||
            editorParams.get('orzr_edit_from_mission') === '1';
        const expectedMissionName = sanitizeMissionName(editorParams.get('orzr_mission_name') || '');

        if (fromMissionContext && expectedMissionName) {
            const expectedKey = exactMissionNameKey(stripFalseAlarmSuffix(expectedMissionName) || expectedMissionName);
            const capturedName = stripFalseAlarmSuffix(state.capture?.name || '') || sanitizeMissionName(state.capture?.name || '');
            const capturedKey = exactMissionNameKey(capturedName);

            if (!state.capture || !capturedKey || capturedKey !== expectedKey) {
                console.warn(TAG, 'Odrzucono nieaktualne wymagania z poprzedniej misji.', {
                    expectedMissionName,
                    capturedName
                });
                state.capture = null;
            }
        }

        const form = document.querySelector('form');
        if (!form) return;

        const panel = document.createElement('div');
        panel.id = 'orzr-editor';
        panel.className = 'panel panel-info';

        panel.innerHTML = `
            <div class="panel-heading">
                <strong>Menedżer ZR v${VERSION}</strong>
                <span style="margin-left:12px;">${state.capture ? state.capture.name : (fromMissionContext ? 'Brak aktualnych danych misji' : 'Brak zapisanej misji')}</span>
                ${state.capture?.maxPatients ? `<span style="margin-left:12px;" class="label label-info">Maks. pacjentów: ${state.capture.maxPatients}</span>` : ''}
            </div>
            <div class="panel-body">
                <div class="table-responsive">
                    <table class="table table-condensed">
                        <thead>
                            <tr>
                                <th>Wymaganie</th>
                                <th>Ilość</th>
                                <th>Pole ZR</th>
                                <th>Obecnie</th>
                            </tr>
                        </thead>
                        <tbody id="orzr-editor-body"></tbody>
                    </table>
                </div>
                <button type="button" id="orzr-fill" class="btn btn-success">Uzupełnij ZR</button>
                <button type="button" id="orzr-replace" class="btn btn-warning">Zastąp ZR</button>
            </div>
        `;

        form.parentNode.insertBefore(panel, form);

        document.getElementById('orzr-fill').addEventListener('click', () => applyCapturedMission(false));
        document.getElementById('orzr-replace').addEventListener('click', () => {
            if (confirm('Wyzerować wymagania i wpisać dane z misji?')) applyCapturedMission(true);
        });

        renderEditor();

        if (new URLSearchParams(location.search).get('orzr_from_mission') === '1' && state.capture) {
            const caption = state.fields.find(x => x.kind === 'caption');
            if (caption && !caption.input.value.trim()) {
                const safeName = zrNameForEditor(state.capture.name);
                if (safeName) {
                    setInput(caption.input, safeName);
                } else {
                    console.warn(TAG, 'Nie wpisuję podejrzanej nazwy ZR:', state.capture.name);
                }
            }
        }
    }

    function init() {
        log(`Start v${VERSION}`, location.href);

        if (isAAOEditor()) {
            buildEditorPanel();
            return;
        }

        const scan = () => {
            ensureHeaderButtons();
            autoSelectMatchingAAO();
        };
        scan();

        const observer = new MutationObserver(() => {
            clearTimeout(window.__orzrScanTimer);
            window.__orzrScanTimer = setTimeout(scan, 80);
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    init();
})();
