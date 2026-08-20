// ==UserScript==
// @name         Menedżer ZR OR
// @namespace    https://www.operatorratunkowy.pl/
// @version      0.28
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
    const VERSION = '0.28';
    const CAPTURE_KEY = 'or_zr_capture_v028';
    const MAP_KEY = 'or_zr_map_v020';

    const state = {
        capture: loadJSON(CAPTURE_KEY, null),
        map: loadJSON(MAP_KEY, {}),
        fields: [],
        aaosPromise: null,
        autoSelectBusy: false
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
            .replace(/\u00a0/g, ' ')
            .replace(/[\/|]/g, ' lub ')
            .replace(/[()[\]{},.:;!?]/g, ' ')
            .replace(/[-–—]/g, ' ')
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

    function findMissionTitleElement(header) {
        if (!header) return null;

        const candidates = [...header.querySelectorAll('h1,h2,h3,h4,strong,span,div')];

        let best = null;
        let bestScore = -999;

        for (const el of candidates) {
            if (!isVisible(el)) continue;

            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length < 4 || text.length > 100) continue;

            const r = el.getBoundingClientRect();
            if (r.height > 50 || r.width < 80) continue;

            let score = 0;

            const fs = Number.parseFloat(getComputedStyle(el).fontSize) || 0;
            score += fs;

            if (/[A-ZĄĆĘŁŃÓŚŹŻ]{4,}/.test(text)) score += 10;
            if (/minut|dzis|wczoraj/i.test(text)) score -= 15;

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

    function findMissionInfoBlock() {
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

        const missionName = getOpenedMissionName();
        if (!missionName) return false;

        const cardText = getMissionCardText(block, missionName);
        if (!cardText || !/\bPojazdy\b/i.test(cardText)) return false;

        const wanted = normalize(missionName);

        // Najpewniejszy wariant: karta zawiera osobny element z dokładnie taką
        // samą nazwą jak ciemny nagłówek misji.
        for (const el of block.querySelectorAll(
            'h1,h2,h3,h4,h5,strong,.panel-title,.modal-title,[class*="mission"][class*="title"],[class*="caption"]'
        )) {
            const title = sanitizeMissionName(el.textContent || '');
            if (normalize(title) === wanted) return true;
        }

        // Fallback dla starszego układu HTML, gdzie tytuł i treść są jednym tekstem.
        return normalize(cardText).includes(wanted);
    }

    function sanitizeMissionName(value) {
        let text = String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/^[*✱✳✽❉🔥🚑🚒🚓\s]+/, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) return '';

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
            /\s+Dostepne jednostki\b/i
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

        return text;
    }

    function getMissionName(infoBlock) {
        // Najpewniejsze źródło to tytuł w ciemnym nagłówku otwartej misji.
        // Jest oddzielony od POI, pojazdów i innych danych żółtej karty.
        const openedHeader = findOpenedMissionHeader();
        const openedTitle = findMissionTitleElement(openedHeader);

        if (openedTitle) {
            const name = sanitizeMissionName(openedTitle.textContent);
            if (name && name.length <= 60) return name;
        }

        // Drugie źródło: nagłówek wewnątrz żółtej karty.
        if (infoBlock) {
            const headings = infoBlock.querySelectorAll(
                'h1,h2,h3,h4,h5,.panel-title,.modal-title,[class*="mission"][class*="title"],strong'
            );

            for (const h of headings) {
                const name = sanitizeMissionName(h.textContent);
                const n = normalize(name);

                if (!name || name.length > 60) continue;
                if (['pojazdy', 'pacjenci', 'woda', 'piana'].includes(n)) continue;
                if (/^\d+\s+/.test(name)) continue;

                return name;
            }

            // Awaryjnie można użyć tekstu przed sekcją Pojazdy,
            // ale zawsze przechodzi on przez sanitizer usuwający POI itp.
            const compact = (infoBlock.innerText || infoBlock.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const m = compact.match(/^(.+?)\s+Pojazdy\b/i);
            if (m) {
                const name = sanitizeMissionName(m[1]);
                if (name && name.length <= 60) return name;
            }
        }

        // Ostatni fallback - zwykły nagłówek znaleziony starszą metodą.
        const header = findMissionHeader();
        const title = findMissionTitleElement(header);
        if (title) {
            const name = sanitizeMissionName(title.textContent);
            if (name && name.length <= 60) return name;
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

        const bad = [
            'minut',
            'kredyt',
            'pacjent',
            'posterunk',
            'dostepne jednostki',
            'alarmowo',
            'moze sie rozwinac',
            'woda',
            'piana'
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

    function extractVehiclesFromCardLines(block) {
        const result = [];
        const map = new Map();
        const lines = getMissionCardLines(block);
        if (!lines.length) return result;

        let start = lines.findIndex(line => normalize(line) === 'pojazdy');
        if (start < 0) {
            start = lines.findIndex(line => /^pojazdy\b/i.test(line));
        }
        if (start < 0) return result;

        const isStop = line => {
            const n = normalize(line);
            return (
                n === 'pacjenci' ||
                n === 'personel' ||
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

        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (isStop(line)) break;

            let count = null;
            let rawLabel = '';

            let m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
            if (m) {
                count = Number.parseInt(m[1], 10);
                rawLabel = m[2].trim();
            } else if (/^\s*\d+\s*$/.test(line) && lines[i + 1] && !isStop(lines[i + 1])) {
                // Niektóre układy HTML rozbijają liczbę i nazwę pojazdu na osobne linie.
                count = Number.parseInt(line, 10);
                rawLabel = lines[++i].trim();
            }

            if (!count || !rawLabel) continue;

            const chance = parseChanceFromLabel(rawLabel);
            addVehicle(result, map, rawLabel, count, chance);
        }

        return result;
    }

    function extractVehiclesFromFlatText(block) {
        const result = [];
        const map = new Map();
        const segment = getVehiclesTextSegment(block);

        if (!segment) return result;

        log('Segment Pojazdy:', segment);

        // Przykład:
        // "1 SLOP/SLRr (35%) 2 Samochody pożarnicze"
        const re = /(\d+)\s+(.+?)(?=\s+\d+\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]|$)/g;
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

        const patterns = type === 'water'
            ? [
                /(?:Potrzebna|Wymagana)?\s*woda(?:\s+gaśnicza)?\s*:?\s*([\d\s.]+)/i,
                /([\d\s.]+)\s*(?:l|litrów|litrow)?\s+(?:potrzebnej|wymaganej)?\s*wody\b/i,
                /\b([\d\s.]+)\s+Woda\b/i
            ]
            : [
                /(?:Wymagana|Potrzebna)?\s*piana(?:\s+gaśnicza)?\s*:?\s*([\d\s.]+)/i,
                /([\d\s.]+)\s*(?:l|litrów|litrow)?\s+(?:potrzebnej|wymaganej)?\s*piany\b/i,
                /\b([\d\s.]+)\s+Piana(?:\s+gaśnicza)?\b/i
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

    async function captureMission() {
        const block = findMissionInfoBlock();
        const name = getMissionName(block);

        // Krytyczne zabezpieczenie v0.26: karta musi być kartą AKTUALNEJ misji.
        // Nie wolno pobierać wymagań z linków "Może się rozwinąć w...".
        if (!missionInfoBlockMatchesCurrentMission(block)) {
            const data = {
                name,
                vehicles: [],
                water: 0,
                foam: 0,
                maxPatients: 0,
                sourceUrl: location.href,
                capturedAt: Date.now(),
                readError: 'Nie udało się powiązać widocznej karty wymagań z aktualną misją.'
            };
            state.capture = data;
            saveJSON(CAPTURE_KEY, data);
            return data;
        }

        // v0.28: najpierw czytamy zachowane linie sekcji "Pojazdy".
        // Dzięki temu misje z sekcją Pacjenci nie gubią wcześniejszych wymagań.
        // Parser płaskiego tekstu zostaje tylko jako bezpieczny fallback.
        const lineVehicles = extractVehiclesFromCardLines(block);
        const flatVehicles = extractVehiclesFromFlatText(block);
        let vehicles = mergeVehicles(lineVehicles, flatVehicles);

        if (hasContaminatedVehicleList(vehicles)) {
            console.warn(TAG, 'Odrzucono zanieczyszczoną listę pojazdów:', vehicles);
            vehicles = [];
        }

        const water = extractResource(block, 'water');
        const foam = extractResource(block, 'foam');
        const maxPatients = extractMaxPatients(block);

        // v0.26: NIE używamy findMissionDetailsLink()/xhr fallbacku.
        // Link w sekcji "Może się rozwinąć w..." prowadzi do INNEJ misji i był
        // przyczyną pobrania cudzych wymagań (np. 2 samochody + piana 800 l).

        const data = {
            name,
            vehicles,
            water,
            foam,
            maxPatients,
            sourceUrl: location.href,
            capturedAt: Date.now()
        };

        state.capture = data;
        saveJSON(CAPTURE_KEY, data);
        log('Odczyt misji:', data);

        return data;
    }

    // ------------------------------------------------------------------
    // AUTOMATYCZNY WYBÓR ISTNIEJĄCEGO ZR
    // ------------------------------------------------------------------

    function exactMissionNameKey(value) {
        return sanitizeMissionName(value)
            .normalize('NFC')
            .toLocaleLowerCase('pl-PL')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function unwrapAAOList(data) {
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.result)) return data.result;
        if (Array.isArray(data?.aaos)) return data.aaos;
        return [];
    }

    function loadAAOsForAutoSelect() {
        if (state.aaosPromise) return state.aaosPromise;

        state.aaosPromise = fetch('/api/v1/aaos', {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(unwrapAAOList)
            .catch(error => {
                state.aaosPromise = null;
                console.warn(TAG, 'Nie udało się pobrać listy ZR do auto-wyboru:', error);
                return [];
            });

        return state.aaosPromise;
    }

    function ensureAutoSelectStyle() {
        if (document.getElementById('orzr-auto-select-style')) return;

        const style = document.createElement('style');
        style.id = 'orzr-auto-select-style';
        style.textContent = `
            #mission-aao-group .aao.orzr-auto-selected-aao {
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
        if (!header) return;

        ensureAutoSelectStyle();

        let status = document.getElementById('orzr-auto-select-status');
        if (status && status.parentElement !== header) status.remove();

        if (!status) {
            status = document.createElement('span');
            status.id = 'orzr-auto-select-status';

            const actions = document.getElementById('orzr-header-actions');
            if (actions?.parentElement === header) {
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
        const header = findOpenedMissionHeader();
        if (!header) return '';

        const title = findMissionTitleElement(header);
        const name = sanitizeMissionName(title?.textContent || '');

        if (!name || name === 'Misja bez nazwy' || name.length > 60) return '';
        return name;
    }

    function isAAOAvailable(aaoElement) {
        if (!aaoElement) return false;
        if (aaoElement.querySelector('.label-danger')) return false;
        if (aaoElement.classList.contains('disabled')) return false;
        if (aaoElement.getAttribute('aria-disabled') === 'true') return false;
        return true;
    }

    function findAAOButtonById(group, id) {
        if (!group || !id) return null;

        const escapedId = CSS.escape(String(id));

        // Operator może renderować ZR na dwa sposoby. W szczególności w pierwszej
        // wyświetlanej kategorii często występuje klasyczne id="aao_<ID>",
        // podczas gdy w innych miejscach dostępny jest atrybut aao_id.
        const selectors = [
            `#aao_${escapedId}`,
            `.aao[aao_id="${escapedId}"]`,
            `.aao[data-aao-id="${escapedId}"]`,
            `[aao_id="${escapedId}"]`,
            `[data-aao-id="${escapedId}"]`
        ];

        for (const selector of selectors) {
            let target = null;
            try {
                target = group.querySelector(selector);
            } catch {}
            if (target) return target;
        }

        // Ostateczny fallback: sprawdzenie identyfikatora/atrybutu na wszystkich
        // przyciskach ZR w aktualnej grupie. Nie wybieramy nic po podobnej nazwie.
        const candidates = group.querySelectorAll('a.aao, button.aao, .aao');
        for (const el of candidates) {
            const elementId = String(el.id || '');
            const aaoId = String(
                el.getAttribute('aao_id') ||
                el.getAttribute('data-aao-id') ||
                ''
            );

            if (elementId === `aao_${id}` || aaoId === String(id)) {
                return el;
            }
        }

        return null;
    }

    async function autoSelectMatchingAAO() {
        if (isAAOEditor() || state.autoSelectBusy) return;

        const missionName = currentMissionNameForAutoSelect();
        if (!missionName) return;

        const group = document.getElementById('mission-aao-group');
        if (!group) return;

        const missionKey = exactMissionNameKey(missionName);
        if (!missionKey) return;

        // Klikamy najwyżej raz na danym ekranie misji. To krytyczne, ponieważ
        // drugie kliknięcie tej samej ZR mogłoby ponownie dodać pojazdy.
        if (group.dataset.orzrAutoSelectedMission === missionKey) return;
        if (group.dataset.orzrAutoCheckedMission === missionKey) return;

        state.autoSelectBusy = true;

        try {
            const aaos = await loadAAOsForAutoSelect();
            if (!aaos.length) return;

            const matches = aaos.filter(aao =>
                exactMissionNameKey(aao?.caption || '') === missionKey
            );

            if (!matches.length) {
                group.dataset.orzrAutoCheckedMission = missionKey;
                return;
            }

            for (const aao of matches) {
                const id = String(aao?.id ?? '').trim();
                if (!id) continue;

                // Obsługa obu wariantów DOM Operatora, w tym pierwszej
                // wyświetlanej kategorii z elementami id="aao_<ID>".
                const target = findAAOButtonById(group, id);

                // ZR może być jeszcze w trakcie doładowywania – MutationObserver
                // wywoła tę funkcję ponownie, gdy pojawi się w DOM.
                if (!target) continue;

                // Czerwona etykieta oznacza niedostępne ZR – takiego nie klikamy.
                if (!isAAOAvailable(target)) {
                    log(`ZR „${missionName}” istnieje, ale nie jest obecnie dostępna.`);
                    group.dataset.orzrAutoCheckedMission = missionKey;
                    return;
                }

                // Znacznik ustawiamy PRZED kliknięciem, żeby zmiany DOM wywołane
                // przez grę nie spowodowały drugiego automatycznego kliknięcia.
                group.dataset.orzrAutoSelectedMission = missionKey;
                group.dataset.orzrAutoSelectedAaoId = id;

                ensureAutoSelectStyle();
                target.classList.add('orzr-auto-selected-aao');
                target.title = `${target.title ? target.title + ' | ' : ''}Automatycznie wybrane przez Menedżer ZR`;
                showAutoSelectStatus(aao?.caption || missionName);

                target.click();
                log(`Automatycznie wybrano ZR „${missionName}” (ID ${id}).`);
                return;
            }
        } catch (error) {
            console.warn(TAG, 'Automatyczny wybór ZR nie powiódł się:', error);
        } finally {
            state.autoSelectBusy = false;
        }
    }

    // ------------------------------------------------------------------
    // PRZYCISKI W NAGŁÓWKU
    // ------------------------------------------------------------------

    function removeHeaderButtons() {
        document.getElementById('orzr-header-actions')?.remove();
        removeAutoSelectStatus();
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

        const save = document.createElement('button');
        save.type = 'button';
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

            try {
                GM_openInTab(url.href, { active: true, insert: true });
            } catch {
                window.open(url.href, '_blank');
            }
        });

        save.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const data = await captureMission();
            save.textContent = '✓';

            setTimeout(() => {
                if (document.contains(save)) save.textContent = '💾';
            }, 1400);
        });

        wrap.append(create, save);
        header.appendChild(wrap);

        log('Dodano przyciski do nagłówka misji.', header);
        autoSelectMatchingAAO();
    }

    // ------------------------------------------------------------------
    // EDYTOR ZR
    // ------------------------------------------------------------------

    function isAAOEditor() {
        return /^\/aaos\/(?:new|\d+\/(?:edit|copy))\/?$/.test(location.pathname);
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

    function collectFields() {
        const result = [];

        for (const input of document.querySelectorAll('input[name]')) {
            if (input.disabled) continue;
            if (['hidden', 'button', 'submit', 'checkbox', 'radio'].includes(input.type)) continue;

            const label = labelFor(input);
            const name = input.name || '';
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
            [/pojazdy? ratownictwa technicznego(?: sh lub sd)?/g, ' technik ratownictwo techniczne drabina sh sd '],
            [/samochody? wezowe/g, ' weze wezowy '],
            [/samochody? dowodzenia i lacznosci/g, ' dil dowodzenie lacznosc '],
            [/sp rchem/g, ' rchem '],
            [/samochody? spgaz/g, ' spgaz '],
            [/radiowozy? wrd/g, ' radiowoz wrd '],
            [/radiowozy?/g, ' radiowoz '],
            [/sh lub sd/g, ' drabina sh sd '],
            [/slop lub slrr/g, ' oficer operacyjny slop slrr '],
            [/slop slrr/g, ' oficer operacyjny slop slrr '],
            [/cysterny?/g, ' cysterna '],
            [/piana gasnicza/g, ' piana '],
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
            for (const f of state.fields.filter(x => x.kind !== 'caption')) {
                if (f.input.type === 'number' || /^(aao\[|vehicle_type_ids\[|vehicle_type_caption\[)/.test(f.name)) {
                    setInput(f.input, 0);
                }
            }
        }

        for (const req of reqs) {
            const f = bestField(req);
            if (!f) continue;

            const current = Number.parseInt(f.input.value || '0', 10) || 0;
            const isPatientAmbulance =
                req.kind === 'vehicle' &&
                normalize(req.label) === 'ambulans s lub p';

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
            const safeName = sanitizeMissionName(state.capture.name);
            if (safeName && safeName.length <= 60) {
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

        collectFields();

        const form = document.querySelector('form');
        if (!form) return;

        const panel = document.createElement('div');
        panel.id = 'orzr-editor';
        panel.className = 'panel panel-info';

        panel.innerHTML = `
            <div class="panel-heading">
                <strong>Menedżer ZR v${VERSION}</strong>
                <span style="margin-left:12px;">${state.capture ? state.capture.name : 'Brak zapisanej misji'}</span>
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
                const safeName = sanitizeMissionName(state.capture.name);
                if (safeName && safeName.length <= 60) {
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
            window.__orzrScanTimer = setTimeout(scan, 120);
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    init();
})();
