// ==UserScript==
// @name         Operator Ratunkowy - Menedzer pojazdow OR
// @namespace    operatorratunkowy.local.fleetmanager
// @version      2.08
// @description  Lista, filtrowanie i masowa zmiana nazw pojazdow w OperatorRatunkowy.pl
// @author       ChatGPT / adaptacja mechanizmu FuxTools (Fuxaro)
// @license      CC BY-NC-SA 4.0
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-pojazdow-or.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-pojazdow-or.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Operator Ratunkowy - Menedzer pojazdow OR
 * Wersja 2.08
 *
 * Funkcje:
 * - pobiera wszystkie pojazdy i jednostki z API gry,
 * - osobna karta Załoga: max, przydzielona i brakujaca obsada pojazdu,
 * - sprawdzanie czy w jednostce jest wystarczajacy wolny personel do pelnej obsady,
 * - przy ocenie personelu uwzgledniane sa wymagane szkolenia/kursy pojazdu,
 * - szczegoly personelu sa pobierane leniwie ze strony jednostki oraz /vehicles/{id}/zuweisung,
 * - v2.01: wolny personel jest liczony niezaleznie od kursow pojazdu referencyjnego,
 * - v2.03: strzalki poprzednia/nastepna jednostka w karcie Zaloga,
 * - v2.03: pojazd z pelna obsada jest podswietlany na zielono,
 * - v2.03: aktualizacje Tampermonkey z GitHub przez @updateURL / @downloadURL,
 * - v2.03: przydzielanie wolnego personelu do maksymalnej obsady bezposrednio z karty Zaloga,
 * - v2.04: poprawione rozpoznawanie kolumn „Przydzielono do” i „Stan” w tabeli personelu,
 * - v2.05: lista wolnego personelu jest czytana ze strony personelu jednostki,
 *   a przy zapisie adresy akcji sa pobierane osobno z /vehicles/{id}/zuweisung,
 * - v2.06: automatyczne wykrywanie strony/tabeli personelu jednostki oraz bardziej odporny parser ID pracownikow,
 * - v2.07: zaznaczanie wielu pojazdow w karcie Zaloga i zbiorcze „Do max”,
 * - v2.07: zbiorczy przydzial wykonywany sekwencyjnie z ponownym odczytem personelu przed kazdym pojazdem,
 * - v2.08: przycisk Menedzera jest wyswietlany tylko na glownej stronie OperatorRatunkowy.pl,
 * - v2.04: przycisk przydzialu nie jest juz mylony z informacja o aktualnym przydziale osoby,
 * - przydzial z karty Zaloga jest dostepny tylko po pozytywnej weryfikacji liczby osob i wymaganych kursow,
 * - wyszukiwanie oraz filtrowanie po typie, jednostce i klasie pojazdu,
 * - klasy pojazdow sa pobierane z formularza AAO gry,
 * - parser obsluguje standardowe pola AAO (fire, rw, dlk, rtw itd.)
 *   oraz bezposrednie vehicle_type_ids[...] / vehicle_type_ids[[...]],
 * - standardowe klasy sa mapowane do typow na podstawie katalogu pojazdow,
 * - dostepny jest eksport diagnostyczny klas AAO do CSV,
 * - jeden typ pojazdu moze nalezec do wielu klas jednoczesnie,
 * - w razie braku danych AAO uzywany jest awaryjny fallback klas,
 * - szybkie przechodzenie po jednostkach przyciskami poprzednia / nastepna,
 * - zmiana jednostki automatycznie czysci zaznaczenie pojazdow,
 * - sortowanie listy m.in. po obecnej nazwie pojazdu A-Z / Z-A,
 * - generator numeruje pojazdy w aktualnie wybranej kolejnosci sortowania,
 * - zwijany panel pomocy z opisem dostepnych znacznikow,
 * - zaznaczanie pojedynczych, widocznych lub wszystkich filtrowanych pojazdow,
 * - reczna edycja przygotowanej nazwy,
 * - generator nazw z polami:
 *   {typ}, {jednostka}, fragmenty {jednostka:...}, {jednostka:[]},
 *   {id}, {stara}, {stara:przed[]}, {stara:koniec:X}, {stara:poczatek:X},
 *   {n}, {n:02}, {n:03},
 *   {n:typ}, {n:typ:02},
 *   {n:jednostka}, {n:jednostka:02},
 *   {n:global}, {n:global:02},
 *   {n:jednostka+typ}, {n:jednostka+typ:02},
 * - numeracja globalna / osobno dla typu / osobno dla jednostki /
 *   osobno dla typu w kazdej jednostce,
 * - zakres numerowania moze byc ustawiony globalnie w polu wyboru
 *   albo bezposrednio w kazdym tokenie {n:...},
 * - tryb kontynuacji numeracji ]xx-zz:
 *   xx = numer typu w jednostce, zz = numer pojazdu w jednostce,
 * - tryb kontynuacji ]xx-zz przelicza cala jednostke wedlug aktualnego sortowania,
 *   dodaje brakujace numery i zmienia istniejace, jesli kolejnosc tego wymaga,
 * - tryb kontynuacji [xx-JEDNOSTKA] przelicza caly typ pojazdu wg aktualnego sortowania,
 *   zachowujac bez zmian wszystko, co znajduje sie po znaku ],
 * - lista gotowych szablonow nazwy z mozliwoscia dalszej recznej edycji,
 * - izolacja zdarzen klawiatury i myszy w oknie menedzera od strony gry,
 * - eksport listy do CSV UTF-8 (wszystkie / filtrowane / zaznaczone),
 * - eksport zachowuje aktualne sortowanie i zawiera obecna oraz przygotowana nazwe,
 * - podglad zmian przed zapisem,
 * - masowy zapis z bezpiecznym, sekwencyjnym wysylaniem formularzy gry,
 * - anulowanie trwajacego zapisu.
 *
 * Zgodnosc wsteczna:
 * - {n}, {n:02}, {n:03} nadal korzystaja z ustawienia "Sposob numeracji".
 * - token z podanym zakresem, np. {n:typ:02}, nadpisuje ustawienie tylko
 *   dla tego konkretnego numeru.
 *
 * Uwaga licencyjna:
 * Mechanizm pobierania /api/v2/vehicles i bezpiecznej zmiany nazwy przez
 * /vehicles/{id}/editName zostal zaadaptowany na podstawie projektu FuxTools
 * autorstwa Fuxaro, udostepnionego na licencji CC BY-NC-SA 4.0.
 * Ta zmodyfikowana praca jest udostepniana na tej samej licencji.
 */

(() => {
  'use strict';

  const APP_ID = 'or-fleet-manager-v01';
  const STORAGE_KEY = 'orFleetManagerV01Settings';
  const PAGE_SIZE = 200;
  const CREW_PAGE_SIZE = 100;
  const CREW_DETAIL_CONCURRENCY = 4;
  const VEHICLE_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/vehicles';

  // Awaryjny zestaw klas z v1.01.
  // W normalnej pracy v1.02 zastepuje go lista odczytana z /aaos/new.
  const FALLBACK_VEHICLE_CLASSES = [
    {
      id: 'fallback_basic_fire',
      label: 'Podstawowe samochody gaśnicze',
      typeIds: ['0', '1', '12', '29', '38', '39'],
    },
    {
      id: 'fallback_technical_fire',
      label: 'Samochody gaśnicze z funkcją techniczną',
      typeIds: ['12', '38', '39'],
    },
    {
      id: 'fallback_powder_fire',
      label: 'Samochody gaśnicze z ładunkiem proszkowym (lub przyczepy)',
      typeIds: ['55', '56', '57', '58', '59', '60'],
    },
  ];

  if (window.top !== window.self) return;

  // Przycisk Menedzera ma byc dostepny wylacznie na glownej stronie gry.
  // Parametry zapytania i hash nie maja znaczenia - liczy sie glowna sciezka '/'.
  if (window.location.pathname !== '/') return;

  if (document.getElementById(`${APP_ID}-button`)) return;

  const state = {
    vehicles: [],
    buildings: [],
    vehicleTypes: {},
    vehicleClasses: FALLBACK_VEHICLE_CLASSES.map(item => ({ ...item, typeIds: [...item.typeIds] })),
    vehicleClassesSource: 'fallback',
    vehicleClassesWarning: '',
    vehicleClassDiagnostics: [],
    loading: false,
    saving: false,
    cancelSave: false,
    page: 1,
    query: '',
    buildingId: '',
    typeId: '',
    classId: '',
    sortMode: null,
    activeTab: 'names',
    crewQuery: '',
    crewBuildingId: '',
    crewTypeId: '',
    crewOnlyMissing: false,
    crewPage: 1,
    crewDetails: new Map(),
    crewLoading: false,
    crewLoadGeneration: 0,
    crewAssigning: new Set(),
    crewSelected: new Set(),
    crewBatchAssigning: false,
    selected: new Set(),
    draftNames: new Map(),
    settings: loadSettings(),
  };

  state.sortMode = state.settings.sortMode || 'default';

  function loadSettings() {
    try {
      return Object.assign({
        pattern: '{typ} {n:02}',
        startNumber: 1,
        numbering: 'type',
        sortMode: 'default',
        continueExistingDualNumbering: false,
        continueExistingBracketNumbering: false,
      }, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_) {
      return {
        pattern: '{typ} {n:02}',
        startNumber: 1,
        numbering: 'type',
        sortMode: 'default',
        continueExistingDualNumbering: false,
        continueExistingBracketNumbering: false,
      };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (_) {}
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeResult(data) {
    const result = data?.result ?? data;
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object') return Object.values(result);
    return [];
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }

  async function fetchAllPages(firstUrl) {
    const items = [];
    let nextUrl = firstUrl;
    let safety = 0;

    while (nextUrl && safety < 200) {
      safety += 1;
      const response = await fetch(nextUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${nextUrl}`);
      const data = await response.json();
      items.push(...normalizeResult(data));
      nextUrl = data?.paging?.next_page || null;
    }

    if (safety >= 200) throw new Error('Przerwano pobieranie: zbyt wiele stron API.');
    return items;
  }

  async function fetchVehicles() {
    try {
      return await fetchAllPages('/api/v2/vehicles?limit=2000');
    } catch (v2Error) {
      console.warn('[OR Fleet Manager] /api/v2/vehicles niedostepne, proba starszego API.', v2Error);
      return normalizeResult(await fetchJson('/api/vehicles'));
    }
  }

  async function fetchBuildings() {
    try {
      return await fetchAllPages('/api/v2/buildings?limit=2000');
    } catch (v2Error) {
      console.warn('[OR Fleet Manager] /api/v2/buildings niedostepne, proba starszego API.', v2Error);
      return normalizeResult(await fetchJson('/api/buildings'));
    }
  }

  async function fetchVehicleCatalog() {
    try {
      const response = await fetch(VEHICLE_CATALOG_URL, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      console.warn('[OR Fleet Manager] Polski katalog typow LSSM jest niedostepny.', error);
      return {};
    }
  }

  function simpleHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function cleanClassLabel(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s*:\s*$/, '')
      .trim();
  }

  function labelForAAOInput(doc, input) {
    const inputId = input.getAttribute('id');

    if (inputId) {
      const exactLabel = doc.querySelector(`label[for="${CSS.escape(inputId)}"]`);
      const exactText = cleanClassLabel(exactLabel?.textContent);
      if (exactText) return exactText;
    }

    const row =
      input.closest('.form-group') ||
      input.closest('.row') ||
      input.closest('tr') ||
      input.parentElement;

    const labels = [...(row?.querySelectorAll('label') || [])]
      .map(label => cleanClassLabel(label.textContent))
      .filter(Boolean);

    if (labels.length) return labels[0];

    return (
      cleanClassLabel(input.getAttribute('aria-label')) ||
      cleanClassLabel(input.getAttribute('title')) ||
      cleanClassLabel(input.getAttribute('placeholder')) ||
      ''
    );
  }

  function catalogEntries(catalog) {
    return Object.entries(catalog || {}).map(([id, data]) => ({
      id: String(id),
      caption: String(data?.caption ?? data?.name ?? ''),
      data: data || {},
    }));
  }

  function catalogIdsByPredicate(catalog, predicate) {
    return catalogEntries(catalog)
      .filter(entry => {
        try { return !!predicate(entry); }
        catch (_) { return false; }
      })
      .map(entry => entry.id);
  }

  function captionMatches(regex) {
    return entry => regex.test(entry.caption);
  }

  function mergeIds(...groups) {
    return [...new Set(groups.flat().map(String))].sort((a, b) => Number(a) - Number(b));
  }

  function semanticAAOTypeIds(key, catalog) {
    const k = String(key || '').trim().toLowerCase();

    const ids = regex => catalogIdsByPredicate(catalog, captionMatches(regex));
    const exact = (...captions) => {
      const wanted = new Set(captions.map(v => v.toLocaleLowerCase('pl')));
      return catalogIdsByPredicate(
        catalog,
        entry => wanted.has(entry.caption.toLocaleLowerCase('pl'))
      );
    };

    // Reguly sa celowo oparte glownie na polskich nazwach katalogu,
    // aby dzialaly takze po dodaniu nowych ID tego samego rodzaju.
    switch (k) {
      case 'fire':
      case 'lf_only':
      case 'tlf_only':
        return mergeIds(
          exact(
            'Ciężki samochód gaśniczy',
            'Średni samochód gaśniczy',
            'Lekki samochód gaśniczy',
            'GBARt',
            'GCBARt',
            'GLBARt'
          )
        );

      case 'hlf_only':
      case 'rw':
      case 'road_rescue_or_fire_engine':
        return mergeIds(
          ids(/(?:^|[\s-])(SRt|SCRt)(?:$|[\s-])/i),
          ids(/(?:GBARt|GCBARt|GLBARt)/i),
          ids(/ratownictwa technicznego/i)
        );

      case 'rw_only':
        return mergeIds(
          exact('SRt', 'SCRt'),
          ids(/ratownictwa technicznego/i)
        );

      case 'hlf_or_rw_and_lf':
        return mergeIds(
          semanticAAOTypeIds('fire', catalog),
          semanticAAOTypeIds('rw', catalog)
        );

      case 'dlk':
      case 'dlk_or_tm50':
        return mergeIds(
          exact('SD', 'SH'),
          ids(/drabin|podnośnik|wysięgnik/i)
        );

      case 'elw':
      case 'elw2':
      case 'elw1_or_elw2':
      case 'elw2_or_ab_elw':
      case 'ab_einsatzleitung_only':
        return mergeIds(
          exact('SLOp', 'SLRr', 'Ruchome Stanowisko Dowodzenia'),
          ids(/dowodzeni|stanowisko dowodzenia/i)
        );

      case 'gwa':
      case 'gw_atemschutz_only':
      case 'ab_atemschutz_only':
        return mergeIds(
          exact('Spgaz'),
          ids(/AODO|aparat.*oddech|sprzętem AODO/i)
        );

      case 'gwoel':
      case 'gw_oel_only':
      case 'ab_oel_only':
        return ids(/olej|ekolog/i);

      case 'gwl2wasser':
      case 'gwl2wasser_only':
      case 'abl2wasser_only':
      case 'gwl2wasser_all':
      case 'hose_trucks':
        return mergeIds(
          exact('SW'),
          ids(/wężow/i)
        );

      case 'gwmesstechnik':
        return mergeIds(
          exact('SDł'),
          ids(/pomiar|łączno/i)
        );

      case 'gwgefahrgut':
      case 'gw_gefahrgut_only':
      case 'ab_gefahrgut_only':
        return mergeIds(
          exact('Srchem'),
          ids(/chemicz|CBRNE|niebezpiecz/i)
        );

      case 'gwhoehenrettung':
        return mergeIds(
          exact('SRWys'),
          ids(/wysokości/i)
        );

      case 'dekon_p':
      case 'only_dekon_p':
      case 'only_ab_dekon_p':
        return ids(/dekontamin/i);

      case 'fwk':
        return mergeIds(
          exact('SCDź'),
          ids(/dźwig|żuraw/i)
        );

      case 'foam':
      case 'foam_amount':
        return catalogIdsByPredicate(
          catalog,
          entry => Number(entry.data?.foamTank ?? entry.data?.ftank ?? 0) > 0
        );

      case 'rtw':
        return mergeIds(
          exact('Ambulans P', 'Ambulans S'),
          ids(/ambulans.*(?:P|S)$/i)
        );

      case 'ktw':
        return mergeIds(
          exact('Ambulans T'),
          ids(/transport.*medycz|ambulans T/i)
        );

      case 'ktw_or_rtw':
        return mergeIds(
          semanticAAOTypeIds('rtw', catalog),
          semanticAAOTypeIds('ktw', catalog)
        );

      case 'nef':
        return mergeIds(
          exact('Samochód Lekarza', 'Śmigłowiec LPR'),
          ids(/lekarz|LPR/i)
        );

      case 'nef_only':
        return mergeIds(
          exact('Samochód Lekarza'),
          ids(/samochód lekarza/i)
        );

      case 'rth_only':
      case 'hems':
        return mergeIds(
          exact('Śmigłowiec LPR'),
          ids(/śmigłowiec.*LPR/i)
        );

      case 'fustw':
        return mergeIds(
          exact('Radiowóz OPI'),
          ids(/^Radiowóz(?! WRD)/i)
        );

      case 'k9':
        return ids(/K-9|pies|przewodnik.*ps/i);

      case 'polizeihubschrauber':
        return ids(/helikopter policyjny/i);

      case 'police_motorcycle':
        return ids(/motocykl.*WRD|motocykl.*polic/i);

      case 'fustw_or_police_motorcycle':
        return mergeIds(
          semanticAAOTypeIds('fustw', catalog),
          semanticAAOTypeIds('police_motorcycle', catalog)
        );

      case 'gw_wasserrettung':
        return mergeIds(
          exact('S.WOPR', 'Samochód SLRw'),
          ids(/WOPR|SLRw|wodn/i)
        );

      case 'boot':
      case 'mzb':
      case 'rescueboat':
        return ids(/Łódź|Ponton|Skuter|łód/i);

      default:
        return [];
    }
  }

  function parseVehicleTypeIdsFieldName(name) {
    const match = String(name || '').match(/^vehicle_type_ids\[(.+)\]$/);
    if (!match) return null;

    const raw = match[1].trim();

    // pojedynczy typ: vehicle_type_ids[12]
    if (/^\d+$/.test(raw)) return [String(Number(raw))];

    // kombinacja OR: vehicle_type_ids[[0, 1, 12]]
    if (/^\[\s*\d+(?:\s*,\s*\d+)*\s*\]$/.test(raw)) {
      return [...new Set([...raw.matchAll(/\d+/g)].map(m => String(Number(m[0]))))];
    }

    return null;
  }

  function semanticKeyForAAOInput(input) {
    const name = String(input.getAttribute('name') || '').trim();
    if (!name) return '';

    if (/^vehicle_type_ids\[/.test(name)) return name;

    // W formularzu AAO standardowe wymagania wystepuja bezposrednio jako
    // nazwy typu fire, rw, dlk, rtw itd. Pomijamy pola techniczne formularza.
    const ignored = new Set([
      'authenticity_token', 'utf8', '_method', 'commit',
      'aao[name]', 'aao[caption]', 'name', 'caption',
      'building_ids', 'custom'
    ]);
    if (ignored.has(name)) return '';

    return name;
  }

  function parseVehicleClassesFromAAOHtml(html, catalog) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const fields = [...doc.querySelectorAll('input[name], select[name], textarea[name]')];

    const classes = [];
    const diagnostics = [];
    const seen = new Set();

    for (const input of fields) {
      const key = semanticKeyForAAOInput(input);
      if (!key) continue;

      const label = labelForAAOInput(doc, input);
      if (!label) continue;

      let typeIds = parseVehicleTypeIdsFieldName(key);
      let mappingSource = '';

      if (typeIds?.length) {
        mappingSource = 'vehicle_type_ids';
      } else {
        typeIds = semanticAAOTypeIds(key, catalog);
        if (typeIds.length) mappingSource = 'reguła standardowa';
      }

      const row =
        input.closest('.form-group') ||
        input.closest('.row') ||
        input.closest('tr') ||
        input.parentElement;

      diagnostics.push({
        label,
        key,
        typeIds: [...(typeIds || [])],
        mappingSource: mappingSource || 'brak mapowania',
        rowClasses: String(row?.className || ''),
      });

      if (!typeIds?.length) continue;

      const signature = `${label.toLocaleLowerCase('pl')}|${[...typeIds].sort().join(',')}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      classes.push({
        id: `aao_${simpleHash(signature)}`,
        label,
        typeIds: [...new Set(typeIds.map(String))].sort((a, b) => Number(a) - Number(b)),
      });
    }

    return {
      classes: classes.sort((a, b) =>
        a.label.localeCompare(b.label, 'pl', { numeric: true, sensitivity: 'base' })
      ),
      diagnostics,
    };
  }

  async function fetchVehicleClassesFromAAO(catalog) {
    try {
      const response = await fetch('/aaos/new', {
        credentials: 'same-origin',
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const parsed = parseVehicleClassesFromAAOHtml(html, catalog);

      if (!parsed.classes.length) {
        throw new Error('Nie znaleziono zadnej zmapowanej klasy w formularzu AAO.');
      }

      return {
        classes: parsed.classes,
        diagnostics: parsed.diagnostics,
        source: 'aao',
        warning: '',
      };
    } catch (error) {
      console.warn('[OR Fleet Manager] Parser klas AAO nie powiodl sie. Uzywam fallbacku.', error);

      return {
        classes: FALLBACK_VEHICLE_CLASSES.map(item => ({
          ...item,
          typeIds: [...item.typeIds],
        })),
        diagnostics: [],
        source: 'fallback',
        warning: error?.message || String(error),
      };
    }
  }

  function exportAAOClassDiagnosticsCsv() {
    const rows = [
      ['Nazwa klasy / pola', 'Klucz AAO', 'ID typow', 'Sposob mapowania', 'Klasy CSS wiersza'],
      ...state.vehicleClassDiagnostics.map(item => [
        item.label,
        item.key,
        item.typeIds.join('|'),
        item.mappingSource,
        item.rowClasses,
      ]),
    ];

    if (rows.length <= 1) {
      alert('Brak danych diagnostycznych AAO. Wczytaj ponownie dane i sprobuj jeszcze raz.');
      return;
    }

    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'operatorratunkowy_klasy_AAO_diagnostyka.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus(`Wyeksportowano diagnostyke ${state.vehicleClassDiagnostics.length} pol AAO.`, 'ok');
  }

  function valueOf(obj, keys, fallback = null) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return fallback;
  }

  function normalizeData(rawVehicles, rawBuildings, catalog) {
    const buildings = rawBuildings.map(b => ({
      id: String(valueOf(b, ['id'], '')),
      name: String(valueOf(b, ['caption', 'name'], `Jednostka ${valueOf(b, ['id'], '')}`)),
      type: valueOf(b, ['building_type', 'type'], null),
      personalCount: Math.max(0, Number(valueOf(b, ['personal_count', 'personnel_count', 'personalCount'], 0)) || 0),
    }));

    const buildingsById = new Map(buildings.map(b => [b.id, b]));

    const vehicles = rawVehicles.map(v => {
      const id = String(valueOf(v, ['id'], ''));
      const typeId = String(valueOf(v, ['vehicle_type', 'vehicle_type_id', 'type'], ''));
      const buildingId = String(valueOf(v, ['building_id', 'building'], ''));
      const catalogEntry = catalog?.[typeId] ?? catalog?.[Number(typeId)] ?? null;
      const typeName = String(
        valueOf(catalogEntry, ['caption', 'name'], null) ??
        valueOf(v, ['vehicle_type_caption', 'type_caption'], null) ??
        `Typ ${typeId || '?'}`
      );
      const name = String(valueOf(v, ['caption', 'name'], `Pojazd ${id}`));
      const buildingName = buildingsById.get(buildingId)?.name || `Jednostka ${buildingId || '?'}`;
      const assignedPersonnelCount = Math.max(
        0,
        Number(valueOf(v, ['assigned_personnel_count', 'assignedPersonnelCount'], 0)) || 0
      );
      const overrideRaw = valueOf(v, ['max_personnel_override', 'maxPersonnelOverride'], null);
      const maxPersonnelOverride = overrideRaw === null || overrideRaw === ''
        ? null
        : Math.max(0, Number(overrideRaw) || 0);
      const catalogMaxRaw =
        catalogEntry?.staff?.max ??
        catalogEntry?.maxPersonnel ??
        catalogEntry?.max_personnel ??
        null;
      const catalogMaxPersonnel = catalogMaxRaw === null || catalogMaxRaw === undefined
        ? null
        : Math.max(0, Number(catalogMaxRaw) || 0);

      return {
        id,
        name,
        typeId,
        typeName,
        buildingId,
        buildingName,
        assignedPersonnelCount,
        maxPersonnelOverride,
        catalogMaxPersonnel,
        catalogEntry,
      };
    }).filter(v => v.id);

    vehicles.sort((a, b) =>
      a.buildingName.localeCompare(b.buildingName, 'pl', { numeric: true }) ||
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true }) ||
      Number(a.id) - Number(b.id)
    );

    state.buildings = buildings.sort((a, b) => a.name.localeCompare(b.name, 'pl', { numeric: true }));
    state.vehicles = vehicles;
    state.vehicleTypes = catalog || {};

    for (const v of vehicles) {
      if (!state.draftNames.has(v.id)) state.draftNames.set(v.id, v.name);
    }
  }

  async function loadData(force = false) {
    if (state.loading) return;
    state.loading = true;
    setStatus('Pobieram pojazdy i jednostki...', 'info');
    setBusy(true);

    try {
      if (force) {
        state.selected.clear();
        state.crewSelected.clear();
        state.draftNames.clear();
        state.crewDetails.clear();
        state.crewLoadGeneration += 1;
      }
      const [vehicles, buildings, catalog] = await Promise.all([
        fetchVehicles(),
        fetchBuildings(),
        fetchVehicleCatalog(),
      ]);

      normalizeData(vehicles, buildings, catalog);

      const classResult = await fetchVehicleClassesFromAAO(catalog);

      state.vehicleClasses = classResult.classes;
      state.vehicleClassesSource = classResult.source;
      state.vehicleClassesWarning = classResult.warning || '';
      state.vehicleClassDiagnostics = classResult.diagnostics || [];

      state.page = 1;
      state.crewPage = 1;
      rebuildFilterOptions();
      rebuildCrewFilterOptions();
      renderTable();
      renderCrewTable();

      const sourceText = state.vehicleClassesSource === 'aao' ? 'AAO gry' : 'fallback';
      const diagCount = state.vehicleClassDiagnostics.length;
      const unmappedCount = state.vehicleClassDiagnostics.filter(d => !d.typeIds.length).length;
      setStatus(
        `Wczytano ${state.vehicles.length} pojazdow, ${state.buildings.length} jednostek i ` +
        `${state.vehicleClasses.length} klas (${sourceText}).` +
        (diagCount ? ` Pola AAO: ${diagCount}, bez mapowania: ${unmappedCount}.` : ''),
        state.vehicleClassesSource === 'aao' ? 'ok' : 'warn'
      );
    } catch (error) {
      console.error('[OR Fleet Manager] Blad ladowania:', error);
      setStatus(`Blad ladowania: ${error.message}`, 'error');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function compareDefault(a, b) {
    return (
      a.buildingName.localeCompare(b.buildingName, 'pl', { numeric: true }) ||
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true }) ||
      Number(a.id) - Number(b.id)
    );
  }

  function compareVehicleName(a, b) {
    return (
      a.name.localeCompare(b.name, 'pl', { numeric: true, sensitivity: 'base' }) ||
      a.buildingName.localeCompare(b.buildingName, 'pl', { numeric: true, sensitivity: 'base' }) ||
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true, sensitivity: 'base' }) ||
      Number(a.id) - Number(b.id)
    );
  }

  function sortVehicles(vehicles) {
    const result = [...vehicles];

    switch (state.sortMode) {
      case 'name_asc':
        result.sort(compareVehicleName);
        break;
      case 'name_desc':
        result.sort((a, b) => compareVehicleName(b, a));
        break;
      case 'default':
      default:
        result.sort(compareDefault);
        break;
    }

    return result;
  }

  function vehicleClassIds(vehicle) {
    const typeId = String(vehicle?.typeId ?? '');
    return state.vehicleClasses
      .filter(definition => definition.typeIds.includes(typeId))
      .map(definition => definition.id);
  }

  function vehicleMatchesClass(vehicle, classId) {
    if (!classId) return true;
    const classes = vehicleClassIds(vehicle);

    if (classId === '__unassigned__') {
      return classes.length === 0;
    }

    return classes.includes(classId);
  }

  function filteredVehicles() {
    const q = state.query.trim().toLocaleLowerCase('pl');
    const filtered = state.vehicles.filter(v => {
      if (state.buildingId && v.buildingId !== state.buildingId) return false;
      if (state.typeId && v.typeId !== state.typeId) return false;
      if (state.classId && !vehicleMatchesClass(v, state.classId)) return false;
      if (q) {
        const hay = `${v.name} ${v.typeName} ${v.buildingName} ${v.id}`.toLocaleLowerCase('pl');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return sortVehicles(filtered);
  }

  function clearSelectionForBuildingChange() {
    if (state.selected.size) {
      state.selected.clear();
    }
  }

  function applyBuildingFilter(buildingId, source = 'list') {
    clearSelectionForBuildingChange();
    state.buildingId = String(buildingId ?? '');
    state.page = 1;

    const buildingSelect = document.getElementById(`${APP_ID}-building-filter`);
    if (buildingSelect) buildingSelect.value = state.buildingId;

    renderTable();

    const currentName = buildingSelect?.selectedOptions?.[0]?.textContent || 'Wszystkie jednostki';
    setStatus(
      source === 'button'
        ? `Jednostka: ${currentName}. Zaznaczenie zostalo wyczyszczone.`
        : `Filtr jednostki: ${currentName}. Zaznaczenie zostalo wyczyszczone.`,
      'info'
    );
  }

  function changeBuildingFilterByStep(step) {
    const buildingSelect = document.getElementById(`${APP_ID}-building-filter`);
    if (!buildingSelect) return;

    const unitOptions = [...buildingSelect.options].filter(option => option.value);
    if (!unitOptions.length) return;

    let currentIndex = unitOptions.findIndex(option => option.value === state.buildingId);

    if (currentIndex < 0) {
      currentIndex = step > 0 ? -1 : 0;
    }

    let nextIndex = currentIndex + step;

    // Zapetlamy tylko rzeczywiste jednostki, bez pozycji "Wszystkie jednostki".
    if (nextIndex < 0) nextIndex = unitOptions.length - 1;
    if (nextIndex >= unitOptions.length) nextIndex = 0;

    applyBuildingFilter(unitOptions[nextIndex].value, 'button');
  }

  function rebuildFilterOptions() {
    const buildingSelect = document.getElementById(`${APP_ID}-building-filter`);
    const typeSelect = document.getElementById(`${APP_ID}-type-filter`);
    const classSelect = document.getElementById(`${APP_ID}-class-filter`);
    if (!buildingSelect || !typeSelect || !classSelect) return;

    const usedBuildings = new Map();
    const usedTypes = new Map();
    for (const v of state.vehicles) {
      usedBuildings.set(v.buildingId, v.buildingName);
      usedTypes.set(v.typeId, v.typeName);
    }

    const buildingOptions = [...usedBuildings.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }))
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');

    const typeOptions = [...usedTypes.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }))
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');

    const classOptions = state.vehicleClasses.map(definition => {
      const count = state.vehicles.filter(v => definition.typeIds.includes(String(v.typeId))).length;
      return `<option value="${esc(definition.id)}">${esc(definition.label)} (${count})</option>`;
    }).join('');

    const unassignedCount = state.vehicles.filter(v => vehicleClassIds(v).length === 0).length;

    buildingSelect.innerHTML = `<option value="">Wszystkie jednostki</option>${buildingOptions}`;
    typeSelect.innerHTML = `<option value="">Wszystkie typy</option>${typeOptions}`;
    classSelect.innerHTML =
      `<option value="">Wszystkie klasy</option>` +
      classOptions +
      `<option value="__unassigned__">Bez przypisanej klasy (${unassignedCount})</option>`;

    buildingSelect.value = state.buildingId;
    typeSelect.value = state.typeId;
    classSelect.value = state.classId;

    const classSource = document.getElementById(`${APP_ID}-class-source`);
    if (classSource) {
      if (state.vehicleClassesSource === 'aao') {
        const unmapped = state.vehicleClassDiagnostics.filter(d => !d.typeIds.length).length;
        classSource.textContent = `Klasy: AAO (${state.vehicleClasses.length})`;
        classSource.title =
          `Klasy odczytane z /aaos/new. Pola nierozpoznane: ${unmapped}. ` +
          `Uzyj przycisku "Klasy AAO CSV", aby wyeksportowac diagnostyke.`;
      } else {
        classSource.textContent = `Klasy: fallback (${state.vehicleClasses.length})`;
        classSource.title =
          'Nie udalo sie odczytac klas z AAO. Uzywany jest awaryjny zestaw klas.' +
          (state.vehicleClassesWarning ? ` ${state.vehicleClassesWarning}` : '');
      }
    }
  }

  function renderTable() {
    const tbody = document.getElementById(`${APP_ID}-tbody`);
    const summary = document.getElementById(`${APP_ID}-summary`);
    const pager = document.getElementById(`${APP_ID}-pager`);
    if (!tbody || !summary || !pager) return;

    const filtered = filteredVehicles();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, pages));
    const start = (state.page - 1) * PAGE_SIZE;
    const current = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = current.map(v => {
      const selected = state.selected.has(v.id);
      const draft = state.draftNames.get(v.id) ?? v.name;
      const changed = draft !== v.name;
      return `
        <tr data-id="${esc(v.id)}" class="${changed ? 'or-fm-changed' : ''}">
          <td class="or-fm-center"><input type="checkbox" class="or-fm-row-check" data-id="${esc(v.id)}" ${selected ? 'checked' : ''}></td>
          <td class="or-fm-id"><a href="/vehicles/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.id)}</a></td>
          <td>${esc(v.buildingName)}</td>
          <td>${esc(v.typeName)}</td>
          <td>${esc(v.name)}</td>
          <td><input type="text" class="or-fm-draft-name" data-id="${esc(v.id)}" value="${esc(draft)}"></td>
        </tr>`;
    }).join('') || `<tr><td colspan="6" class="or-fm-empty">Brak pojazdow dla wybranych filtrow.</td></tr>`;

    const changedCount = state.vehicles.reduce((n, v) => n + ((state.draftNames.get(v.id) ?? v.name) !== v.name ? 1 : 0), 0);
    summary.textContent = `Widoczne: ${filtered.length} / ${state.vehicles.length} | Zaznaczone: ${state.selected.size} | Przygotowane zmiany: ${changedCount}`;

    pager.innerHTML = `
      <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-prev" ${state.page <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Strona ${state.page} z ${pages}</span>
      <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-next" ${state.page >= pages ? 'disabled' : ''}>Nastepna ›</button>`;

    document.getElementById(`${APP_ID}-prev`)?.addEventListener('click', () => { state.page--; renderTable(); });
    document.getElementById(`${APP_ID}-next`)?.addEventListener('click', () => { state.page++; renderTable(); });

    tbody.querySelectorAll('.or-fm-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.id);
        else state.selected.delete(cb.dataset.id);
        updateSummaryOnly();
      });
    });

    tbody.querySelectorAll('.or-fm-draft-name').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        state.draftNames.set(id, input.value);
        const vehicle = state.vehicles.find(v => v.id === id);
        input.closest('tr')?.classList.toggle('or-fm-changed', !!vehicle && input.value !== vehicle.name);
        updateSummaryOnly();
      });
    });
  }

  function updateSummaryOnly() {
    const summary = document.getElementById(`${APP_ID}-summary`);
    if (!summary) return;
    const filtered = filteredVehicles();
    const changedCount = state.vehicles.reduce((n, v) => n + ((state.draftNames.get(v.id) ?? v.name) !== v.name ? 1 : 0), 0);
    summary.textContent = `Widoczne: ${filtered.length} / ${state.vehicles.length} | Zaznaczone: ${state.selected.size} | Przygotowane zmiany: ${changedCount}`;
  }

  function selectedVehicles() {
    return sortVehicles(state.vehicles.filter(v => state.selected.has(v.id)));
  }

  function normalizeNumberingScope(scope, fallback = 'type') {
    const s = String(scope ?? '').trim().toLocaleLowerCase('pl');

    if (!s) return fallback;

    if (['global', 'glob', 'all', 'wszystkie'].includes(s)) return 'global';
    if (['type', 'typ'].includes(s)) return 'type';
    if (['building', 'unit', 'jednostka'].includes(s)) return 'building';

    if ([
      'building_type',
      'building+type',
      'type+building',
      'unit+type',
      'type+unit',
      'jednostka+typ',
      'typ+jednostka',
    ].includes(s)) {
      return 'building_type';
    }

    return fallback;
  }

  function parseCounterSpec(spec, fallbackScope) {
    const raw = String(spec ?? '').trim();
    if (!raw) return { scope: fallbackScope, width: 0 };

    const parts = raw.split(':').map(part => part.trim()).filter(Boolean);

    // Stary zapis: {n:02}, {n:03}
    if (parts.length === 1 && /^\d+$/.test(parts[0])) {
      return {
        scope: fallbackScope,
        width: Math.max(0, Number(parts[0]) || 0),
      };
    }

    // Nowy zapis: {n:typ}, {n:jednostka}, {n:global}
    const scope = normalizeNumberingScope(parts[0], fallbackScope);

    // Nowy zapis z szerokoscia: {n:typ:02}, {n:jednostka:03}
    const width = parts.length >= 2 && /^\d+$/.test(parts[1])
      ? Math.max(0, Number(parts[1]) || 0)
      : 0;

    return { scope, width };
  }

  function existingDualNumber(name) {
    const match = String(name ?? '').trim().match(/\](\d+)-(\d+)$/);
    if (!match) return null;

    return {
      typeNumber: Number(match[1]),
      buildingNumber: Number(match[2]),
    };
  }

  function continuationTypeIdentity(vehicle) {
    // Przy numeracji ]xx-zz najpewniejszym identyfikatorem "typu" jest
    // oznaczenie znajdujace sie przed pierwszym znakiem [.
    // Jest to wazne takze dla pojazdow, dla ktorych API gry nie zwraca typu.
    const name = String(vehicle?.name ?? '').trim();
    const bracketIndex = name.indexOf('[');

    if (bracketIndex > 0) {
      const prefix = name.slice(0, bracketIndex).trim().toLocaleLowerCase('pl');
      if (prefix) return `prefix:${prefix}`;
    }

    if (vehicle?.typeId) return `typeid:${vehicle.typeId}`;
    if (vehicle?.typeName) return `typename:${String(vehicle.typeName).toLocaleLowerCase('pl')}`;
    return `vehicle:${vehicle?.id ?? ''}`;
  }

  function counterGroupKey(scope, vehicle, continuationMode = false) {
    switch (scope) {
      case 'global':
        return 'global';
      case 'building':
        return `building:${vehicle.buildingId}`;
      case 'building_type':
        return continuationMode
          ? `building_type:${vehicle.buildingId}:${continuationTypeIdentity(vehicle)}`
          : `building_type:${vehicle.buildingId}:${vehicle.typeId}`;
      case 'type':
      default:
        return `type:${vehicle.typeId}`;
    }
  }

  function addUsedNumber(usedNumbers, key, number) {
    if (!Number.isFinite(number) || number < 0) return;
    if (!usedNumbers.has(key)) usedNumbers.set(key, new Set());
    usedNumbers.get(key).add(number);
  }

  function buildExistingDualNumberUsage() {
    const usedNumbers = new Map();

    for (const vehicle of state.vehicles) {
      const parsed = existingDualNumber(vehicle.name);
      if (!parsed) continue;

      addUsedNumber(
        usedNumbers,
        counterGroupKey('building', vehicle, true),
        parsed.buildingNumber
      );

      addUsedNumber(
        usedNumbers,
        counterGroupKey('building_type', vehicle, true),
        parsed.typeNumber
      );
    }

    return usedNumbers;
  }

  function nextFreeNumber(usedSet, startNumber) {
    let number = Math.max(0, Number(startNumber) || 0);
    while (usedSet?.has(number)) number += 1;
    return number;
  }

  function stripExistingDualNumberSuffix(name) {
    return String(name ?? '').replace(/\](\d+)-(\d+)\s*$/, ']').trim();
  }

  function existingBracketNumber(name) {
    const full = String(name ?? '');
    const match = full.match(/\[(\d+)-([^\]]+)\]/);
    if (!match) return null;

    const closeIndex = full.indexOf(']', match.index);
    return {
      number: Number(match[1]),
      unit: match[2],
      suffix: closeIndex >= 0 ? full.slice(closeIndex + 1) : '',
    };
  }

  function vehicleTypeGroupKey(vehicle) {
    const typeId = String(vehicle?.typeId ?? '').trim();
    if (typeId) return `typeid:${typeId}`;

    const typeName = String(vehicle?.typeName ?? '').trim().toLocaleLowerCase('pl');
    if (typeName) return `typename:${typeName}`;

    return `vehicle:${vehicle?.id ?? ''}`;
  }

  function buildSortedTypeNumberPlan(typeKeys, startNumber) {
    const wanted = new Set([...typeKeys].map(String));
    const vehicles = sortVehicles(
      state.vehicles.filter(v => wanted.has(vehicleTypeGroupKey(v)))
    );

    const counters = new Map();
    const plan = new Map();

    for (const vehicle of vehicles) {
      const key = vehicleTypeGroupKey(vehicle);
      const number = counters.has(key) ? counters.get(key) : startNumber;
      plan.set(vehicle.id, number);
      counters.set(key, number + 1);
    }

    return plan;
  }

  function buildSortedDualNumberPlan(buildingIds, startNumber) {
    const plan = new Map();
    const wantedBuildings = new Set([...buildingIds].map(String));

    for (const buildingId of wantedBuildings) {
      const vehiclesInBuilding = sortVehicles(
        state.vehicles.filter(v => String(v.buildingId) === buildingId)
      );

      const typeCounters = new Map();
      let buildingNumber = startNumber;

      for (const vehicle of vehiclesInBuilding) {
        const typeKey = continuationTypeIdentity(vehicle);
        const typeNumber = typeCounters.has(typeKey)
          ? typeCounters.get(typeKey)
          : startNumber;

        plan.set(vehicle.id, {
          buildingNumber,
          typeNumber,
        });

        typeCounters.set(typeKey, typeNumber + 1);
        buildingNumber += 1;
      }
    }

    return plan;
  }

  function formatCounters(
    pattern,
    vehicle,
    defaultScope,
    counters,
    startNumber,
    continuationMode = false,
    usedNumbers = null,
    forcedDualPlan = null,
    forcedTypePlan = null
  ) {
    const valuesForVehicle = new Map();

    return pattern.replace(/\{n(?::([^}]+))?\}/g, (_, spec) => {
      const { scope, width } = parseCounterSpec(spec, defaultScope);

      // Jesli ten sam zakres numeracji wystepuje w szablonie kilka razy,
      // dla jednego pojazdu wszedzie dostaje ten sam numer.
      if (!valuesForVehicle.has(scope)) {
        const continuationAware =
          continuationMode && (scope === 'building' || scope === 'building_type');

        let current;

        if (scope === 'type' && forcedTypePlan?.has(vehicle.id)) {
          current = forcedTypePlan.get(vehicle.id);
        } else if (continuationAware && forcedDualPlan?.has(vehicle.id)) {
          const planned = forcedDualPlan.get(vehicle.id);
          current = scope === 'building'
            ? planned.buildingNumber
            : planned.typeNumber;
        } else {
          const key = counterGroupKey(scope, vehicle, continuationAware);

          if (continuationAware) {
            if (!usedNumbers.has(key)) usedNumbers.set(key, new Set());
            const usedSet = usedNumbers.get(key);
            const candidate = counters.has(key) ? counters.get(key) : startNumber;
            current = nextFreeNumber(usedSet, candidate);

            usedSet.add(current);
            counters.set(key, current + 1);
          } else {
            current = counters.has(key) ? counters.get(key) : startNumber;
            counters.set(key, current + 1);
          }
        }

        valuesForVehicle.set(scope, current);
      }

      const n = valuesForVehicle.get(scope);
      return width > 0 ? String(n).padStart(width, '0') : String(n);
    });
  }

  function buildingFragment(buildingName, selector) {
    const full = String(buildingName ?? '').trim();
    if (!selector) return full;

    const parts = full.split(/\s+/).filter(Boolean);
    if (!parts.length) return '';

    const s = String(selector).trim().toLocaleLowerCase('pl');

    // {jednostka:[]} -> tekst miedzy pierwsza para nawiasow kwadratowych
    // np. "JRG 1 [Kielce Centrum]" -> "Kielce Centrum"
    if (s === '[]') {
      const match = full.match(/\[([^\]]*)\]/);
      return match ? match[1].trim() : '';
    }

    if (s === 'first' || s === 'pierwszy') return parts[0];
    if (s === 'last' || s === 'ostatni') return parts[parts.length - 1];

    // {jednostka:2} -> drugi czlon
    if (/^\d+$/.test(s)) {
      const index = Number(s) - 1;
      return index >= 0 && index < parts.length ? parts[index] : '';
    }

    // {jednostka:1-3} -> czlony od 1 do 3 (wlacznie)
    const range = s.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Math.max(1, Number(range[1]));
      const to = Math.max(from, Number(range[2]));
      return parts.slice(from - 1, to).join(' ');
    }

    // {jednostka:2-} -> od drugiego czlonu do konca
    const fromToEnd = s.match(/^(\d+)-$/);
    if (fromToEnd) {
      const from = Math.max(1, Number(fromToEnd[1]));
      return parts.slice(from - 1).join(' ');
    }

    // Nieznany selektor: bezpiecznie zwracamy pelna nazwe zamiast kasowac fragment.
    return full;
  }

  function formatBuilding(pattern, buildingName) {
    return pattern.replace(/\{jednostka(?::([^}]+))?\}/g, (_, selector) =>
      buildingFragment(buildingName, selector)
    );
  }

  function oldNameFragment(oldName, selector) {
    const full = String(oldName ?? '');
    if (!selector) return full;

    const rawSelector = String(selector).trim();
    const s = rawSelector.toLocaleLowerCase('pl');

    // {stara:przed[]} -> wszystko przed pierwszym znakiem [
    // np. "GBA 2,5/16 [JRG 1]" -> "GBA 2,5/16"
    if (['przed[]', 'before[]', 'przed[', 'before['].includes(s)) {
      const index = full.indexOf('[');
      return (index >= 0 ? full.slice(0, index) : full).trim();
    }

    // {stara:koniec:3} -> usuwa 3 znaki od konca starej nazwy.
    // np. "ABC123" -> "ABC"
    let match = s.match(/^(?:koniec|end|usun_koniec|remove_end):(\d+)$/);
    if (match) {
      const count = Math.max(0, Number(match[1]) || 0);
      return count > 0 ? full.slice(0, Math.max(0, full.length - count)).trim() : full;
    }

    // {stara:poczatek:3} -> usuwa 3 znaki od poczatku starej nazwy.
    // np. "ABC123" -> "123"
    match = s.match(/^(?:poczatek|start|usun_poczatek|remove_start):(\d+)$/);
    if (match) {
      const count = Math.max(0, Number(match[1]) || 0);
      return count > 0 ? full.slice(Math.min(count, full.length)).trim() : full;
    }

    return full;
  }

  function formatOldName(pattern, oldName) {
    return pattern.replace(/\{stara(?::([^}]+))?\}/g, (_, selector) =>
      oldNameFragment(oldName, selector)
    );
  }

  function generateNames() {
    const selected = selectedVehicles();
    if (!selected.length) {
      alert('Najpierw zaznacz pojazdy, dla ktorych chcesz przygotowac nazwy.');
      return;
    }

    const patternInput = document.getElementById(`${APP_ID}-pattern`);
    const startInput = document.getElementById(`${APP_ID}-start-number`);
    const numberingInput = document.getElementById(`${APP_ID}-numbering`);
    const continuationInput = document.getElementById(`${APP_ID}-continue-existing`);
    const bracketContinuationInput = document.getElementById(`${APP_ID}-continue-bracket`);

    const pattern = patternInput.value.trim() || '{typ} {n:02}';
    const startNumber = Math.max(0, Number.parseInt(startInput.value, 10) || 1);
    const numbering = normalizeNumberingScope(numberingInput.value, 'type');
    const continueExistingDualNumbering = !!continuationInput?.checked;
    const continueExistingBracketNumbering = !!bracketContinuationInput?.checked;

    state.settings = {
      pattern,
      startNumber,
      numbering,
      sortMode: state.sortMode,
      continueExistingDualNumbering,
      continueExistingBracketNumbering,
    };
    saveSettings();

    let vehiclesToGenerate = selected;
    let forcedDualPlan = null;
    let forcedTypePlan = null;
    const usedNumbers = new Map();

    if (continueExistingDualNumbering) {
      // ]xx-zz: zaznaczenie dowolnego pojazdu z jednostki oznacza
      // przeliczenie calej jednostki wg aktualnego sortowania.
      const affectedBuildingIds = new Set(selected.map(v => String(v.buildingId)));

      vehiclesToGenerate = sortVehicles(
        state.vehicles.filter(v => affectedBuildingIds.has(String(v.buildingId)))
      );

      for (const vehicle of vehiclesToGenerate) {
        state.selected.add(vehicle.id);
      }

      forcedDualPlan = buildSortedDualNumberPlan(affectedBuildingIds, startNumber);
    } else if (continueExistingBracketNumbering) {
      // [xx-JEDNOSTKA]: zaznaczenie dowolnego pojazdu danego typu oznacza
      // przeliczenie wszystkich pojazdow tego typu wg aktualnego sortowania.
      const affectedTypeKeys = new Set(selected.map(vehicleTypeGroupKey));

      vehiclesToGenerate = sortVehicles(
        state.vehicles.filter(v => affectedTypeKeys.has(vehicleTypeGroupKey(v)))
      );

      for (const vehicle of vehiclesToGenerate) {
        state.selected.add(vehicle.id);
      }

      forcedTypePlan = buildSortedTypeNumberPlan(affectedTypeKeys, startNumber);
    }

    const counters = new Map();
    let changedExisting = 0;
    let addedMissing = 0;

    for (const v of vehiclesToGenerate) {
      const hadDualNumber = !!existingDualNumber(v.name);
      const oldBracket = existingBracketNumber(v.name);

      let name = formatCounters(
        pattern,
        v,
        numbering,
        counters,
        startNumber,
        continueExistingDualNumbering,
        usedNumbers,
        forcedDualPlan,
        forcedTypePlan
      );

      name = formatBuilding(name, v.buildingName);

      // ]xx-zz: usuwamy stara koncowke przed podstawieniem {stara},
      // aby nie doklejac nowej numeracji do starej.
      const oldNameForTemplate = continueExistingDualNumbering
        ? stripExistingDualNumberSuffix(v.name)
        : v.name;

      name = formatOldName(name, oldNameForTemplate)
        .replaceAll('{typ}', v.typeName)
        .replaceAll('{id}', v.id)
        .replace(/\s+/g, ' ')
        .trim();

      // [xx-JEDNOSTKA]: wszystko po istniejacym ] jest zachowane.
      // Np. S[01-R01]01-06 -> po renumeracji S[07-R01]01-06.
      if (continueExistingBracketNumbering && oldBracket?.suffix) {
        if (!name.endsWith(oldBracket.suffix)) {
          name += oldBracket.suffix;
        }
      }

      state.draftNames.set(v.id, name);

      if ((continueExistingDualNumbering || continueExistingBracketNumbering) && name !== v.name) {
        if (
          (continueExistingDualNumbering && hadDualNumber) ||
          (continueExistingBracketNumbering && oldBracket)
        ) {
          changedExisting += 1;
        } else {
          addedMissing += 1;
        }
      }
    }

    renderTable();

    if (continueExistingDualNumbering) {
      setStatus(
        `Przeliczono ${vehiclesToGenerate.length} pojazdow w ${new Set(vehiclesToGenerate.map(v => v.buildingId)).size} jednostce/jednostkach wg aktualnego sortowania. ` +
        `Dodano brakujace numery: ${addedMissing}; zmieniono istniejace: ${changedExisting}. ` +
        `Wszystkie pojazdy tych jednostek zostaly automatycznie zaznaczone do zapisu.`,
        'ok'
      );
    } else if (continueExistingBracketNumbering) {
      setStatus(
        `Przeliczono ${vehiclesToGenerate.length} pojazdow w ${new Set(vehiclesToGenerate.map(vehicleTypeGroupKey)).size} typie/typach wg aktualnego sortowania. ` +
        `Dodano brakujace [xx-JEDNOSTKA]: ${addedMissing}; zmieniono istniejace: ${changedExisting}. ` +
        `Wszystko po ] zostalo zachowane. Wszystkie pojazdy tych typow zostaly automatycznie zaznaczone do zapisu.`,
        'ok'
      );
    } else {
      setStatus(
        `Przygotowano nazwy dla ${vehiclesToGenerate.length} pojazdow. Nic nie zostalo jeszcze zapisane w grze.`,
        'ok'
      );
    }
  }

  function resetDraftsForSelected() {
    const selected = selectedVehicles();
    if (!selected.length) {
      alert('Najpierw zaznacz pojazdy.');
      return;
    }
    for (const v of selected) state.draftNames.set(v.id, v.name);
    renderTable();
    setStatus(`Cofnieto przygotowane zmiany dla ${selected.length} pojazdow.`, 'info');
  }

  function csvCell(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportVehiclesCsv(scope = 'filtered') {
    let vehicles;

    if (scope === 'all') {
      vehicles = sortVehicles(state.vehicles);
    } else if (scope === 'selected') {
      vehicles = selectedVehicles();
    } else {
      vehicles = filteredVehicles();
    }

    if (!vehicles.length) {
      alert('Brak pojazdow do eksportu dla wybranego zakresu.');
      return;
    }

    const rows = [
      ['ID', 'Jednostka', 'Typ', 'Obecna nazwa', 'Nowa nazwa'],
      ...vehicles.map(v => [
        v.id,
        v.buildingName,
        v.typeName,
        v.name,
        state.draftNames.get(v.id) ?? v.name,
      ]),
    ];

    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const stamp = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timestamp =
      `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_` +
      `${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;

    const scopeName = scope === 'all' ? 'wszystkie' : scope === 'selected' ? 'zaznaczone' : 'filtrowane';
    const filename = `operatorratunkowy_pojazdy_${scopeName}_${timestamp}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus(`Wyeksportowano ${vehicles.length} pojazdow do pliku ${filename}.`, 'ok');
  }

  function buildRenamePlan() {
    return selectedVehicles()
      .map(v => ({
        ...v,
        newName: String(state.draftNames.get(v.id) ?? v.name).trim(),
      }))
      .filter(v => v.newName && v.newName !== v.name);
  }

  function openConfirmation(plan) {
    const box = document.getElementById(`${APP_ID}-confirm`);
    const list = plan.slice(0, 12).map(v =>
      `<div><b>${esc(v.name)}</b> → <b>${esc(v.newName)}</b> <span class="or-fm-muted">(${esc(v.buildingName)})</span></div>`
    ).join('');

    box.innerHTML = `
      <div class="or-fm-confirm-card">
        <div class="or-fm-confirm-title">Potwierdz zmiane ${plan.length} nazw</div>
        <div class="or-fm-confirm-list">${list}${plan.length > 12 ? `<div class="or-fm-muted">...i jeszcze ${plan.length - 12} pojazdow.</div>` : ''}</div>
        <div class="or-fm-confirm-actions">
          <button type="button" class="or-fm-btn" id="${APP_ID}-confirm-cancel">Anuluj</button>
          <button type="button" class="or-fm-btn or-fm-btn-danger" id="${APP_ID}-confirm-save">Zapisz nazwy w grze</button>
        </div>
      </div>`;
    box.style.display = 'block';

    document.getElementById(`${APP_ID}-confirm-cancel`).addEventListener('click', () => {
      box.style.display = 'none';
      box.innerHTML = '';
    });
    document.getElementById(`${APP_ID}-confirm-save`).addEventListener('click', () => {
      box.style.display = 'none';
      box.innerHTML = '';
      saveRenamePlan(plan);
    });
  }

  async function renameVehicle(vehicleId, newName) {
    const editResponse = await fetch(`/vehicles/${encodeURIComponent(vehicleId)}/editName`, {
      credentials: 'same-origin',
    });
    if (!editResponse.ok) {
      throw new Error(`Nie mozna pobrac formularza pojazdu ${vehicleId} (HTTP ${editResponse.status}).`);
    }

    const html = await editResponse.text();
    const container = document.createElement('div');
    container.innerHTML = html;

    const input =
      container.querySelector(`#vehicle_new_name_${CSS.escape(String(vehicleId))}`) ||
      container.querySelector('input[id^="vehicle_new_name_"]') ||
      container.querySelector('input[name*="new_name"]');

    const form =
      container.querySelector(`#vehicle_form_${CSS.escape(String(vehicleId))}`) ||
      input?.closest('form') ||
      container.querySelector('form');

    if (!input || !form) {
      throw new Error(`Nie znaleziono formularza zmiany nazwy pojazdu ${vehicleId}.`);
    }

    input.value = newName;
    const action = form.getAttribute('action') || form.action;
    const formData = new FormData(form);

    const saveResponse = await fetch(action, {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/javascript, application/json, */*; q=0.01',
      },
    });

    if (!saveResponse.ok) {
      throw new Error(`Nie mozna zapisac pojazdu ${vehicleId} (HTTP ${saveResponse.status}).`);
    }
  }

  async function renameWithRetry(item) {
    try {
      await renameVehicle(item.id, item.newName);
    } catch (firstError) {
      console.warn(`[OR Fleet Manager] Pierwsza proba dla ${item.id} nieudana, ponawiam.`, firstError);
      await sleep(800);
      await renameVehicle(item.id, item.newName);
    }
  }

  async function saveRenamePlan(plan) {
    if (state.saving) return;
    state.saving = true;
    state.cancelSave = false;
    setBusy(true);

    const cancelButton = document.getElementById(`${APP_ID}-cancel-save`);
    cancelButton.style.display = 'inline-flex';

    let done = 0;
    const failed = [];

    for (let i = 0; i < plan.length; i++) {
      if (state.cancelSave) break;
      const item = plan[i];
      setStatus(`Zapisuje ${i + 1}/${plan.length}: ${item.name} → ${item.newName}`, 'info');

      try {
        await renameWithRetry(item);
        done += 1;
        item.name = item.newName;
        const original = state.vehicles.find(v => v.id === item.id);
        if (original) {
          original.name = item.newName;
          state.draftNames.set(item.id, item.newName);
        }
      } catch (error) {
        console.error('[OR Fleet Manager] Blad zmiany nazwy:', item, error);
        failed.push({ item, error });
      }

      if (!state.cancelSave && i < plan.length - 1) await sleep(250);
    }

    cancelButton.style.display = 'none';
    state.saving = false;
    setBusy(false);
    renderTable();

    if (state.cancelSave) {
      setStatus(`Przerwano zapis. Zmieniono ${done} z ${plan.length} nazw${failed.length ? `, bledy: ${failed.length}` : ''}.`, 'warn');
    } else if (failed.length) {
      setStatus(`Gotowe z bledami: zmieniono ${done}/${plan.length}. Nieudane: ${failed.length}. Szczegoly sa w konsoli przegladarki.`, 'error');
    } else {
      setStatus(`Gotowe. Zmieniono ${done} nazw pojazdow.`, 'ok');
    }
  }


  // ---------------------------------------------------------------------------
  // KARTA ZAŁOGA (v2.0)
  // ---------------------------------------------------------------------------

  function vehicleMaxCrew(vehicle) {
    if (vehicle?.maxPersonnelOverride !== null && vehicle?.maxPersonnelOverride !== undefined) {
      return Math.max(0, Number(vehicle.maxPersonnelOverride) || 0);
    }
    if (vehicle?.catalogMaxPersonnel !== null && vehicle?.catalogMaxPersonnel !== undefined) {
      return Math.max(0, Number(vehicle.catalogMaxPersonnel) || 0);
    }
    return null;
  }

  function vehicleMissingCrew(vehicle) {
    const maxCrew = vehicleMaxCrew(vehicle);
    if (maxCrew === null) return null;
    return Math.max(0, maxCrew - Math.max(0, Number(vehicle.assignedPersonnelCount) || 0));
  }

  function crewFilteredVehicles() {
    const q = state.crewQuery.trim().toLocaleLowerCase('pl');
    const filtered = state.vehicles.filter(vehicle => {
      if (state.crewBuildingId && vehicle.buildingId !== state.crewBuildingId) return false;
      if (state.crewTypeId && vehicle.typeId !== state.crewTypeId) return false;
      const missing = vehicleMissingCrew(vehicle);
      if (state.crewOnlyMissing && !(missing > 0)) return false;
      if (q) {
        const hay = `${vehicle.name} ${vehicle.typeName} ${vehicle.buildingName} ${vehicle.id}`.toLocaleLowerCase('pl');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortVehicles(filtered);
  }

  function rebuildCrewFilterOptions() {
    const buildingSelect = document.getElementById(`${APP_ID}-crew-building-filter`);
    const typeSelect = document.getElementById(`${APP_ID}-crew-type-filter`);
    if (!buildingSelect || !typeSelect) return;

    const usedBuildings = new Map();
    const usedTypes = new Map();
    for (const vehicle of state.vehicles) {
      usedBuildings.set(vehicle.buildingId, vehicle.buildingName);
      usedTypes.set(vehicle.typeId, vehicle.typeName);
    }

    buildingSelect.innerHTML = `<option value="">Wszystkie jednostki</option>` +
      [...usedBuildings.entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }))
        .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
        .join('');

    typeSelect.innerHTML = `<option value="">Wszystkie typy</option>` +
      [...usedTypes.entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }))
        .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
        .join('');

    buildingSelect.value = state.crewBuildingId;
    typeSelect.value = state.crewTypeId;
  }

  function applyCrewBuildingFilter(buildingId) {
    state.crewBuildingId = String(buildingId ?? '');
    state.crewPage = 1;

    const select = document.getElementById(`${APP_ID}-crew-building-filter`);
    if (select) select.value = state.crewBuildingId;

    renderCrewTable();
  }

  function changeCrewBuildingFilterByStep(step) {
    const select = document.getElementById(`${APP_ID}-crew-building-filter`);
    if (!select) return;

    const unitOptions = [...select.options].filter(option => option.value);
    if (!unitOptions.length) return;

    let currentIndex = unitOptions.findIndex(option => option.value === state.crewBuildingId);

    if (currentIndex < 0) {
      currentIndex = step > 0 ? -1 : 0;
    }

    let nextIndex = currentIndex + step;
    if (nextIndex < 0) nextIndex = unitOptions.length - 1;
    if (nextIndex >= unitOptions.length) nextIndex = 0;

    applyCrewBuildingFilter(unitOptions[nextIndex].value);
  }

  function extractTrainingDefinition(typeId, maxCrew, visited = new Set(), allowTrailer = false) {
    const key = String(typeId ?? '');
    if (!key || visited.has(key)) return { known: false, requirements: [] };
    visited.add(key);

    const entry = state.vehicleTypes?.[key] ?? state.vehicleTypes?.[Number(key)] ?? null;
    if (!entry) return { known: false, requirements: [] };
    if (entry.isTrailer === true && !allowTrailer) {
      return { known: true, requirements: [] };
    }

    const trainingRoot = entry?.staff?.training ?? entry?.schooling ?? null;
    if (!trainingRoot || typeof trainingRoot !== 'object' || !Object.keys(trainingRoot).length) {
      // Przyczepy / moduły mogą dziedziczyć wymagania po pojeździe ciągnącym.
      for (const [candidateId, candidate] of Object.entries(state.vehicleTypes || {})) {
        const tractive = candidate?.tractiveVehicles;
        const candidateTraining = candidate?.staff?.training ?? candidate?.schooling;
        if (
          Array.isArray(tractive) &&
          tractive.map(String).includes(key) &&
          tractive.length <= 5 &&
          candidateTraining &&
          typeof candidateTraining === 'object'
        ) {
          return extractTrainingDefinition(candidateId, maxCrew, visited, true);
        }
      }
      return { known: true, requirements: [] };
    }

    const firstGroupKey = Object.keys(trainingRoot)[0];
    const group = trainingRoot[firstGroupKey] || {};
    const trainingKeys = Object.keys(group);
    if (!trainingKeys.length) return { known: true, requirements: [] };

    const trainingAtScene = Math.max(0, Number(entry?.staff?.trainingAtScene ?? 0) || 0);
    const isHelicopter = trainingKeys.some(trainingKey => trainingKey.toLowerCase().includes('helicopter'));
    const requirements = [];
    let trainedSlots = 0;

    for (const trainingKey of trainingKeys) {
      const rule = group[trainingKey] || {};
      let amount;

      if (trainingAtScene >= maxCrew || isHelicopter) {
        amount = true;
      } else if (trainingAtScene > 0) {
        amount = trainingAtScene;
      } else if (rule?.all === true) {
        amount = true;
      } else if (Number.isFinite(Number(rule?.min))) {
        amount = Math.max(0, Number(rule.min));
      } else {
        const firstValue = Object.values(rule)[0];
        amount = firstValue === true ? true : Math.max(0, Number(firstValue) || 0);
      }

      // Zachowanie zgodne z mechanizmem przydzielania personelu gry/LSS:
      // pojedynczy kurs (poza lekarzem) zwykle oznacza kurs dla całej załogi.
      if (amount !== true && trainingKeys.length === 1 && amount < maxCrew && trainingKey !== 'notarzt') {
        amount = true;
      }

      if (amount === true) trainedSlots = maxCrew;
      else trainedSlots += amount;

      requirements.push({
        key: trainingKey,
        amount: amount === true ? maxCrew : Math.min(maxCrew, Math.max(0, Number(amount) || 0)),
        all: amount === true,
      });
    }

    return {
      known: true,
      requirements,
      noTrainingSlots: Math.max(0, maxCrew - Math.min(maxCrew, trainedSlots)),
    };
  }

  function personnelTrainingKeys(row) {
    const raw = String(row?.dataset?.filterableBy ?? '').trim();
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.map(String));
    } catch (_) {}

    const keys = [...raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
      .map(match => match[1].replace(/\\"/g, '"'));
    return new Set(keys);
  }

  function normalizePersonnelHeader(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('pl');
  }

  function personnelTableColumns(table) {
    const headers = [...(table?.querySelectorAll('thead th') || [])]
      .map(th => normalizePersonnelHeader(th.textContent));

    const findIndex = patterns => headers.findIndex(text =>
      patterns.some(pattern => pattern.test(text))
    );

    let name = findIndex([/^nazwa$/, /pracownik/, /personel/, /^name$/]);
    let assigned = findIndex([
      /przydzielono do/,
      /przypisano do/,
      /zugewiesen/,
      /assigned to/,
    ]);

    let status = findIndex([
      /^stan$/,
      /^status$/,
      /status personelu/,
    ]);

    let education = findIndex([
      /^edukacja$/,
      /szkolen/,
      /kurs/,
      /education/,
      /ausbildung/,
    ]);

    // Aktualny układ OR ze screena użytkownika:
    // [checkbox] [Nazwa] [Edukacja] [Przydzielono do] [Stan] [Opcje].
    if (name < 0 && headers.length >= 5) name = 1;
    if (assigned < 0 && headers.length >= 5) assigned = 3;
    if (status < 0 && headers.length >= 5) status = 4;
    if (education < 0 && headers.length >= 3) education = 2;

    return { name, assigned, status, education, headers };
  }

  function personnelTableScore(table) {
    const columns = personnelTableColumns(table);
    let score = 0;
    if (columns.assigned >= 0) score += 8;
    if (columns.status >= 0) score += 4;
    if (columns.education >= 0) score += 2;
    if (columns.name >= 0) score += 2;

    const headerText = columns.headers.join(' | ');
    if (/przydzielono do|przypisano do|assigned to|zugewiesen/i.test(headerText)) score += 10;
    if (/stan|status/i.test(headerText)) score += 3;
    if (/nazwa|name|personel|pracownik/i.test(headerText)) score += 2;

    const rows = [...(table?.querySelectorAll('tbody tr') || [])];
    if (rows.length) score += Math.min(5, rows.length);
    if (rows.some(row => row.matches('[id^="personal_"], [data-filterable-by]'))) score += 4;
    if (rows.some(row => row.querySelector('[personal_id], [data-personal-id]'))) score += 4;
    return score;
  }

  function findPersonnelTable(doc) {
    const direct = doc.querySelector('#personal_table');
    if (direct) return direct;

    const tables = [...doc.querySelectorAll('table')];
    if (!tables.length) return null;

    const ranked = tables
      .map(table => ({ table, score: personnelTableScore(table) }))
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.score >= 8 ? ranked[0].table : null;
  }

  function personnelAssignedCell(row, columns) {
    const cells = [...(row?.children || [])];
    if (columns?.assigned >= 0 && cells[columns.assigned]) return cells[columns.assigned];

    return row?.querySelector(
      'td[data-title*="Przydziel" i], td[data-label*="Przydziel" i], ' +
      'td[data-title*="Assigned" i], td[data-label*="Assigned" i]'
    ) || null;
  }

  function assignedVehicleIdFromPersonnelRow(row, columns, buildingId) {
    const cell = personnelAssignedCell(row, columns);
    if (!cell) return '';

    for (const link of cell.querySelectorAll('a[href*="/vehicles/"]')) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/vehicles\/(\d+)(?:\/|$|\?)/);
      if (match) return match[1];
    }

    const text = String(cell.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || /^(?:-|–|—|brak|none)$/i.test(text)) return '';

    const normalized = text.toLocaleLowerCase('pl');
    const matchedVehicle = state.vehicles.find(vehicle =>
      String(vehicle.buildingId) === String(buildingId) &&
      String(vehicle.name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pl') === normalized
    );

    if (matchedVehicle) return String(matchedVehicle.id);
    return `assigned:${text}`;
  }

  function personnelRowIsInSchool(row, columns) {
    const cells = [...(row?.children || [])];
    const statusCell = columns?.status >= 0 ? cells[columns.status] : null;
    const statusText = String(statusCell?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    return /(?:Im Unterricht|W trakcie szkolenia|Na szkoleniu|W szkoleniu|uczestniczy w szkoleniu)/i.test(statusText);
  }

  function personnelIdFromRow(row) {
    const idFromRow = String(row?.id || '').match(/(?:personal|personnel|staff)[_-]?(\d+)/i)?.[1];
    if (idFromRow) return idFromRow;

    for (const attr of ['personal_id', 'data-personal-id', 'data-personnel-id', 'data-person-id']) {
      const own = row?.getAttribute?.(attr);
      if (/^\d+$/.test(String(own || ''))) return String(own);
      const nested = row?.querySelector?.(`[${attr}]`)?.getAttribute(attr);
      if (/^\d+$/.test(String(nested || ''))) return String(nested);
    }

    // Checkbox z listy personelu często niesie ID pracownika w value/name.
    for (const input of row?.querySelectorAll?.('input[type="checkbox"], input[name], button[name]') || []) {
      const value = String(input.getAttribute('value') || '');
      const name = String(input.getAttribute('name') || '');
      if (/^\d+$/.test(value) && /personal|personnel|staff|selected/i.test(name + ' ' + input.id)) return value;
      const m = (name + ' ' + input.id).match(/(?:personal|personnel|staff)[^0-9]*(\d+)/i);
      if (m) return m[1];
    }

    // Ostatnia deska ratunku: link edycji/usunięcia konkretnego pracownika.
    for (const link of row?.querySelectorAll?.('a[href]') || []) {
      const href = String(link.getAttribute('href') || '');
      const m = href.match(/\/(?:personals?|personnel|staff)(?:\/|_)(\d+)(?:\/|$|\?|\/edit)/i);
      if (m) return m[1];
    }

    return '';
  }

  function parseBuildingPersonnelPage(html, buildingId, referenceVehicleId, sourceUrl = '') {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const table = findPersonnelTable(doc);
    if (!table) {
      return {
        buildingId: String(buildingId), referenceVehicleId: String(referenceVehicleId),
        personnel: [], totalCount: 0, freeCount: 0, assignedCount: 0, inSchoolCount: 0,
        csrfToken: String(doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''),
        loadedAt: Date.now(), sourceUrl, parseReason: 'Brak tabeli z kolumna Przydzielono do.'
      };
    }

    const columns = personnelTableColumns(table);
    let rows = [...table.querySelectorAll('tbody tr')];
    if (!rows.length) rows = [...table.querySelectorAll('tr')].filter(row => row.querySelector('td'));

    const personnel = [];
    const seen = new Set();

    for (const row of rows) {
      const personId = personnelIdFromRow(row);
      if (!personId || seen.has(personId)) continue;
      seen.add(personId);

      const assignedVehicleId = assignedVehicleIdFromPersonnelRow(row, columns, buildingId);
      const inSchool = personnelRowIsInSchool(row, columns);
      const assignButton = row.querySelector('a.btn-success[personal_id], a.btn-success');
      const trainingKeys = personnelTrainingKeys(row);

      personnel.push({
        id: personId,
        buildingId: String(buildingId),
        assignedVehicleId,
        trainingKeys,
        inSchool,
        available: !assignedVehicleId && !inSchool,
        canAssignReferenceVehicle: !!assignButton,
        assignHref: String(assignButton?.getAttribute('href') || ''),
      });
    }

    return {
      buildingId: String(buildingId),
      referenceVehicleId: String(referenceVehicleId),
      personnel,
      totalCount: personnel.length,
      freeCount: personnel.filter(person => person.available).length,
      assignedCount: personnel.filter(person => !!person.assignedVehicleId).length,
      inSchoolCount: personnel.filter(person => person.inSchool).length,
      csrfToken: String(doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''),
      loadedAt: Date.now(),
      sourceUrl,
      parseReason: personnel.length ? '' : `Tabela znaleziona (${columns.headers.join(' | ')}), ale nie udalo sie odczytac ID pracownikow.`,
    };
  }

  function discoverPersonnelUrlsFromBuildingHtml(html, buildingId) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const result = [];
    const id = String(buildingId);

    for (const link of doc.querySelectorAll('a[href]')) {
      const hrefRaw = String(link.getAttribute('href') || '');
      const text = String(link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!hrefRaw) continue;
      if (!new RegExp(`/buildings/${id}(?:/|$)`).test(hrefRaw)) continue;
      if (!/personal|personel|pracownik|staff/i.test(hrefRaw + ' ' + text)) continue;
      try {
        const u = new URL(hrefRaw, location.origin);
        if (u.origin === location.origin) result.push(u.pathname + u.search);
      } catch (_) {}
    }
    return [...new Set(result)];
  }

  async function fetchBuildingPersonnelDetail(buildingId) {
    const id = encodeURIComponent(buildingId);
    const tried = [];
    const candidates = [
      `/buildings/${id}`,
      `/buildings/${id}/personals`,
      `/buildings/${id}/personal`,
      `/buildings/${id}/personnel`,
    ];

    // Najpierw strona jednostki: u użytkownika tabela personelu jest widoczna właśnie
    // w widoku jednostki. Przy okazji wykrywamy prawdziwy link do sekcji personelu.
    let buildingHtml = '';
    try {
      const rootResponse = await fetch(`/buildings/${id}`, {
        credentials: 'same-origin', headers: { 'Accept': 'text/html,application/xhtml+xml' },
      });
      tried.push(`/buildings/${id}: HTTP ${rootResponse.status}`);
      if (rootResponse.ok) {
        buildingHtml = await rootResponse.text();
        const rootDetail = parseBuildingPersonnelPage(buildingHtml, buildingId, '', `/buildings/${id}`);
        if (rootDetail.personnel.length) return rootDetail;
        candidates.unshift(...discoverPersonnelUrlsFromBuildingHtml(buildingHtml, buildingId));
      }
    } catch (error) {
      tried.push(`/buildings/${id}: ${error.message}`);
    }

    const uniqueCandidates = [...new Set(candidates)].filter(url => url !== `/buildings/${id}`);

    for (const url of uniqueCandidates) {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin', headers: { 'Accept': 'text/html,application/xhtml+xml' },
        });
        tried.push(`${url}: HTTP ${response.status}`);
        if (!response.ok) continue;
        const html = await response.text();
        const detail = parseBuildingPersonnelPage(html, buildingId, '', url);
        if (detail.personnel.length) return detail;
        tried.push(`${url}: ${detail.parseReason || 'brak personelu'}`);
      } catch (error) {
        tried.push(`${url}: ${error.message}`);
      }
    }

    throw new Error(
      'Nie udalo sie odczytac listy personelu jednostki. Probowano: ' + tried.join(' | ')
    );
  }

  function setCrewStatus(message, kind = 'info') {
    const el = document.getElementById(`${APP_ID}-crew-status`);
    if (!el) return;
    el.className = `or-fm-status or-fm-status-${kind}`;
    el.textContent = message;
  }

  function trainingRequirementText(training) {
    if (!training?.known) return 'Wymagania kursów: nieznane';
    if (!training.requirements?.length) return 'Brak wymaganych kursów';
    return training.requirements
      .map(req => `${req.key}: ${req.all ? 'cała załoga' : req.amount}`)
      .join(', ');
  }

  function minFreePersonnelForNumericTraining(requirements, assignedPeople, freePeople) {
    const numeric = requirements.filter(req => !req.all && req.amount > 0);
    if (!numeric.length) return 0;

    const caps = numeric.map(req => req.amount);
    const targetKey = caps.join(',');
    let states = new Map([['0,'.repeat(Math.max(0, caps.length - 1)) + '0', 0]]);
    // Powyższy klucz upraszczamy natychmiast do prawidłowego wektora.
    states = new Map([[new Array(caps.length).fill(0).join(','), 0]]);

    const processPerson = (person, freeCost) => {
      const before = [...states.entries()];
      for (const [stateKey, cost] of before) {
        const vector = stateKey.split(',').map(Number);
        for (let i = 0; i < numeric.length; i++) {
          if (vector[i] >= caps[i]) continue;
          if (!person.trainingKeys.has(numeric[i].key)) continue;
          const next = [...vector];
          next[i] = Math.min(caps[i], next[i] + 1);
          const nextKey = next.join(',');
          const nextCost = cost + freeCost;
          const previous = states.get(nextKey);
          if (previous === undefined || nextCost < previous) states.set(nextKey, nextCost);
        }
      }
    };

    // Już przydzielone osoby mogą pokryć wymaganie bez zużywania wolnego miejsca.
    assignedPeople.forEach(person => processPerson(person, 0));
    // Każda wolna osoba może zostać użyta tylko do jednego liczbowego wymagania,
    // zgodnie z logiką przydzielacza personelu.
    freePeople.forEach(person => processPerson(person, 1));

    return states.has(targetKey) ? states.get(targetKey) : Infinity;
  }

  function crewAvailability(vehicle) {
    const maxCrew = vehicleMaxCrew(vehicle);
    const assigned = Math.max(0, Number(vehicle.assignedPersonnelCount) || 0);

    if (maxCrew === null) {
      return { kind: 'unknown', label: '?', detail: 'Nie udało się ustalić maksymalnej załogi.', title: '' };
    }
    if (maxCrew <= 0) {
      return { kind: 'neutral', label: '—', detail: 'Pojazd nie wymaga załogi.', title: '' };
    }

    const missing = Math.max(0, maxCrew - assigned);
    const cache = state.crewDetails.get(String(vehicle.buildingId));
    if (!cache || cache.status === 'loading') {
      return { kind: 'loading', label: '…', detail: 'Sprawdzam personel i kursy…', title: '' };
    }
    if (cache.status === 'error') {
      return { kind: 'unknown', label: '?', detail: `Błąd odczytu personelu: ${cache.error}`, title: '' };
    }

    const detail = cache.detail;
    const assignedPeople = detail.personnel.filter(person => person.assignedVehicleId === String(vehicle.id));
    const freePeople = detail.personnel.filter(person => person.available);
    const training = extractTrainingDefinition(vehicle.typeId, maxCrew);
    const title = `${trainingRequirementText(training)} | Personel: ${detail.totalCount ?? detail.personnel.length}; wolni: ${freePeople.length}; przypisani: ${detail.assignedCount ?? 0}; na szkoleniu: ${detail.inSchoolCount ?? 0}`;

    if (!training.known) {
      return {
        kind: 'unknown', label: '?',
        detail: `Wolnych osób: ${freePeople.length}; nieznane wymagania kursów dla tego typu.`,
        title,
      };
    }

    const allKeys = training.requirements.filter(req => req.all).map(req => req.key);
    const assignedWithoutAllTraining = assignedPeople.filter(
      person => !allKeys.every(key => person.trainingKeys.has(key))
    );
    if (assignedWithoutAllTraining.length) {
      return {
        kind: 'bad', label: 'NIE',
        detail: `${assignedWithoutAllTraining.length} już przydzielonych osób nie ma kursów wymaganych dla całej załogi.`,
        title,
      };
    }

    const eligibleFree = freePeople.filter(person => allKeys.every(key => person.trainingKeys.has(key)));
    if (eligibleFree.length < missing) {
      return {
        kind: 'bad', label: 'NIE',
        detail: allKeys.length
          ? `Wolnych z wymaganymi kursami: ${eligibleFree.length}; potrzeba ${missing}.`
          : `Wolnych osób: ${eligibleFree.length}; potrzeba ${missing}.`,
        title,
      };
    }

    const minFreeForNumeric = minFreePersonnelForNumericTraining(
      training.requirements,
      assignedPeople,
      eligibleFree
    );
    if (!Number.isFinite(minFreeForNumeric) || minFreeForNumeric > missing) {
      return {
        kind: 'bad', label: 'NIE',
        detail: `Liczba osób wystarcza, ale brakuje personelu z odpowiednimi kursami.`,
        title,
      };
    }

    if (assignedPeople.length && assignedPeople.length !== assigned) {
      return {
        kind: 'warn', label: 'TAK*',
        detail: `Personelu wystarcza, ale API podaje ${assigned} przydzielonych, a strona przydziału ${assignedPeople.length}.`,
        title,
      };
    }

    return {
      kind: 'ok', label: 'TAK',
      detail: missing > 0
        ? `Można uzupełnić do ${maxCrew}. Wolnych odpowiednich osób: ${eligibleFree.length}.`
        : `Pełna obsada; wymagania kursów są spełnione.`,
      title,
    };
  }

  function selectPersonnelForNumericTraining(requirements, assignedPeople, freePeople) {
    const numeric = requirements.filter(req => !req.all && req.amount > 0);
    if (!numeric.length) return [];

    const caps = numeric.map(req => Math.max(0, Number(req.amount) || 0));
    const initialKey = new Array(caps.length).fill(0).join(',');
    const targetKey = caps.join(',');
    let states = new Map([[initialKey, []]]);

    const processPerson = (person, isFree) => {
      const before = [...states.entries()];
      for (const [stateKey, selected] of before) {
        const vector = stateKey.split(',').map(Number);
        for (let i = 0; i < numeric.length; i++) {
          if (vector[i] >= caps[i]) continue;
          if (!person.trainingKeys.has(numeric[i].key)) continue;

          const next = [...vector];
          next[i] = Math.min(caps[i], next[i] + 1);
          const nextKey = next.join(',');
          const nextSelected = isFree ? [...selected, person] : selected;
          const previous = states.get(nextKey);

          if (!previous || nextSelected.length < previous.length) {
            states.set(nextKey, nextSelected);
          }
        }
      }
    };

    assignedPeople.forEach(person => processPerson(person, false));
    freePeople.forEach(person => processPerson(person, true));

    return states.get(targetKey) || null;
  }

  function buildPersonnelAssignmentPlan(vehicle, detail) {
    const maxCrew = vehicleMaxCrew(vehicle);
    if (maxCrew === null || maxCrew <= 0) {
      return { ok: false, error: 'Nie udało się ustalić maksymalnej załogi tego pojazdu.' };
    }

    const assignedPeople = detail.personnel.filter(
      person => person.assignedVehicleId === String(vehicle.id)
    );
    const apiAssigned = Math.max(0, Number(vehicle.assignedPersonnelCount) || 0);

    // Przy operacji zapisującej wymagamy zgodności obu źródeł. Lepiej odmówić
    // niż przez rozbieżność przydzielić o jedną osobę za dużo.
    if (assignedPeople.length !== apiAssigned) {
      return {
        ok: false,
        error: `Niezgodna liczba przydzielonych osób: API ${apiAssigned}, strona przydziału ${assignedPeople.length}. Odśwież personel i spróbuj ponownie.`,
      };
    }

    const missing = Math.max(0, maxCrew - assignedPeople.length);
    if (missing <= 0) return { ok: true, people: [], missing: 0, maxCrew };

    const training = extractTrainingDefinition(vehicle.typeId, maxCrew);
    if (!training.known) {
      return { ok: false, error: 'Nie znam wymagań kursów dla tego typu pojazdu.' };
    }

    const allKeys = training.requirements.filter(req => req.all).map(req => req.key);
    const invalidAssigned = assignedPeople.filter(
      person => !allKeys.every(key => person.trainingKeys.has(key))
    );
    if (invalidAssigned.length) {
      return {
        ok: false,
        error: `${invalidAssigned.length} już przydzielonych osób nie spełnia wymagań kursów dla całej załogi.`,
      };
    }

    const freeEligiblePeople = detail.personnel.filter(person =>
      person.available &&
      allKeys.every(key => person.trainingKeys.has(key))
    );

    if (freeEligiblePeople.length < missing) {
      return {
        ok: false,
        error: `Wolnych odpowiednich osób: ${freeEligiblePeople.length}; potrzeba ${missing}.`,
      };
    }

    const freePeople = freeEligiblePeople.filter(person => person.assignHref);
    if (freePeople.length < missing) {
      return {
        ok: false,
        error: `Wolnych osób jest ${freeEligiblePeople.length}, ale gra udostępniła przycisk przydziału tylko dla ${freePeople.length}. Odśwież personel i spróbuj ponownie.`,
      };
    }

    const requiredPeople = selectPersonnelForNumericTraining(
      training.requirements,
      assignedPeople,
      freePeople
    );
    if (requiredPeople === null || requiredPeople.length > missing) {
      return {
        ok: false,
        error: 'Brakuje wolnego personelu z wymaganymi kursami.',
      };
    }

    const selectedIds = new Set(requiredPeople.map(person => person.id));
    const people = [...requiredPeople];

    for (const person of freePeople) {
      if (people.length >= missing) break;
      if (selectedIds.has(person.id)) continue;
      selectedIds.add(person.id);
      people.push(person);
    }

    if (people.length < missing) {
      return {
        ok: false,
        error: `Wybrano ${people.length} osób, a potrzeba ${missing}.`,
      };
    }

    return { ok: true, people, missing, maxCrew, training };
  }

  function assignmentRowIsInSchool(row) {
    const text = String(row?.textContent || '').replace(/\s+/g, ' ').trim();
    return /(?:Im Unterricht|W trakcie szkolenia|Na szkoleniu|W szkoleniu|uczestniczy w szkoleniu)/i.test(text);
  }

  function parseVehicleAssignmentControls(html, vehicle) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const rows = [...doc.querySelectorAll('tr[id^="personal_"], tr[data-filterable-by]')];
    const controls = new Map();

    for (const row of rows) {
      const button = row.querySelector('a.btn-success[personal_id], a.btn-success');
      const idFromRow = String(row.id || '').match(/^personal_(\d+)$/)?.[1] || '';
      const personId = idFromRow || String(button?.getAttribute('personal_id') || '');
      if (!personId) continue;

      const href = String(button?.getAttribute('href') || '');
      controls.set(personId, {
        id: personId,
        assignHref: href,
        canAssign: !!button && !!href,
        inSchool: assignmentRowIsInSchool(row),
        trainingKeys: personnelTrainingKeys(row),
      });
    }

    return {
      vehicleId: String(vehicle.id),
      buildingId: String(vehicle.buildingId),
      controls,
      csrfToken: String(doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''),
    };
  }

  async function fetchVehiclePersonnelDetail(vehicle) {
    // 1) Stan wolny/przydzielony bierzemy z listy personelu jednostki.
    const buildingDetail = await fetchBuildingPersonnelDetail(vehicle.buildingId);

    // 2) Adresy POST do przydzielania pobieramy ze strony KONKRETNEGO pojazdu.
    // Zielony przycisk a.btn-success jest akcją przydziału dla danej osoby.
    const response = await fetch(`/vehicles/${encodeURIComponent(vehicle.id)}/zuweisung`, {
      credentials: 'same-origin',
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const assignment = parseVehicleAssignmentControls(html, vehicle);

    const personnel = buildingDetail.personnel.map(person => {
      const control = assignment.controls.get(String(person.id));
      const mergedTraining = new Set([
        ...person.trainingKeys,
        ...(control?.trainingKeys || []),
      ]);

      return {
        ...person,
        trainingKeys: mergedTraining,
        // Wolność nadal wynika z listy jednostki. Przycisk jest tylko akcją zapisu.
        available: !!person.available,
        assignHref: control?.canAssign ? control.assignHref : '',
        canAssignReferenceVehicle: !!control?.canAssign,
      };
    });

    return {
      ...buildingDetail,
      referenceVehicleId: String(vehicle.id),
      personnel,
      csrfToken: assignment.csrfToken || buildingDetail.csrfToken || '',
      assignmentControlCount: [...assignment.controls.values()].filter(item => item.canAssign).length,
    };
  }

  async function postPersonnelAssignment(person, csrfToken) {
    if (!person?.assignHref) throw new Error(`Brak adresu przydziału dla osoby ${person?.id || '?'}.`);

    const response = await fetch(person.assignHref, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-csrf-token': csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || '',
        'x-requested-with': 'XMLHttpRequest',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} podczas przydzielania osoby ${person.id}.`);
    }

    return response.text();
  }

  async function assignCrewToMax(vehicleId, options = {}) {
    const vehicle = state.vehicles.find(v => String(v.id) === String(vehicleId));
    if (!vehicle || state.crewAssigning.has(String(vehicleId))) {
      return { ok: false, skipped: true, error: 'Pojazd jest niedostepny albo trwa juz jego przydzielanie.' };
    }

    const askConfirmation = options.confirm !== false;
    const quiet = options.quiet === true;

    state.crewAssigning.add(String(vehicleId));
    renderCrewTable();
    if (!quiet) setCrewStatus(`Sprawdzam przydział dla ${vehicle.name}…`, 'info');

    try {
      // Zawsze pobieramy aktualny stan tuz przed zapisem. Jest to szczegolnie
      // wazne przy zbiorczym przydziale, bo poprzedni pojazd mogl juz zajac
      // czesc wolnego personelu tej samej jednostki.
      const detail = await fetchVehiclePersonnelDetail(vehicle);
      const plan = buildPersonnelAssignmentPlan(vehicle, detail);

      if (!plan.ok) throw new Error(plan.error);
      if (!plan.people.length) {
        if (!quiet) setCrewStatus(`${vehicle.name}: pojazd ma już maksymalną załogę.`, 'ok');
        return { ok: true, assigned: 0, vehicle };
      }

      if (askConfirmation) {
        const accepted = window.confirm(
          `Przydzielić ${plan.people.length} osób do pojazdu „${vehicle.name}” ` +
          `i uzupełnić obsadę do ${plan.maxCrew}?\n\n` +
          `Skrypt wybierze wyłącznie wolny personel spełniający rozpoznane wymagania kursów.`
        );
        if (!accepted) {
          if (!quiet) setCrewStatus('Anulowano przydzielanie personelu.', 'info');
          return { ok: false, cancelled: true, vehicle };
        }
      }

      let assignedNow = 0;
      for (const person of plan.people) {
        await postPersonnelAssignment(person, detail.csrfToken);
        assignedNow += 1;
        if (!quiet) {
          setCrewStatus(
            `Przydzielam personel do ${vehicle.name}: ${assignedNow}/${plan.people.length}…`,
            'info'
          );
        }
        if (assignedNow < plan.people.length) await sleep(80);
      }

      vehicle.assignedPersonnelCount = Math.max(
        0,
        Number(vehicle.assignedPersonnelCount) || 0
      ) + assignedNow;

      const refreshed = await fetchBuildingPersonnelDetail(vehicle.buildingId);
      state.crewDetails.set(String(vehicle.buildingId), { status: 'loaded', detail: refreshed });

      if (!quiet) {
        setCrewStatus(
          `${vehicle.name}: przydzielono ${assignedNow} osób. Obsada uzupełniona do maksimum.`,
          'ok'
        );
      }
      return { ok: true, assigned: assignedNow, vehicle };
    } catch (error) {
      console.error('[OR Fleet Manager] Błąd przydzielania personelu:', error);
      state.crewDetails.delete(String(vehicle?.buildingId || ''));
      if (!quiet) setCrewStatus(`Nie udało się przydzielić personelu: ${error.message}`, 'error');
      return { ok: false, error: error.message, vehicle };
    } finally {
      state.crewAssigning.delete(String(vehicleId));
      renderCrewTable();
    }
  }

  async function assignSelectedCrewToMax() {
    if (state.crewBatchAssigning) return;

    const selectedVehicles = sortVehicles(
      state.vehicles.filter(vehicle => state.crewSelected.has(String(vehicle.id)))
    );

    if (!selectedVehicles.length) {
      alert('Najpierw zaznacz pojazdy w karcie Załoga.');
      return;
    }

    const candidates = selectedVehicles.filter(vehicle => {
      const missing = vehicleMissingCrew(vehicle);
      return missing !== null && missing > 0;
    });

    if (!candidates.length) {
      setCrewStatus('Wszystkie zaznaczone pojazdy mają już maksymalną załogę.', 'info');
      return;
    }

    const totalMissing = candidates.reduce((sum, vehicle) => sum + (vehicleMissingCrew(vehicle) || 0), 0);
    const accepted = window.confirm(
      `Uzupełnić do maksimum ${candidates.length} zaznaczonych pojazdów?\n\n` +
      `Łącznie brakuje obecnie ${totalMissing} osób.\n` +
      `Pojazdy będą obsługiwane kolejno. Przed każdym przydziałem skrypt ponownie sprawdzi wolny personel i wymagane kursy, więc ta sama osoba nie zostanie przydzielona dwa razy.`
    );
    if (!accepted) return;

    state.crewBatchAssigning = true;
    renderCrewTable();

    let successVehicles = 0;
    let assignedPeople = 0;
    const failures = [];

    try {
      for (let i = 0; i < candidates.length; i++) {
        const vehicle = candidates[i];
        setCrewStatus(
          `Zbiorczy przydział ${i + 1}/${candidates.length}: ${vehicle.name}…`,
          'info'
        );

        const result = await assignCrewToMax(vehicle.id, { confirm: false, quiet: true });
        if (result.ok) {
          successVehicles += 1;
          assignedPeople += Number(result.assigned) || 0;
        } else if (!result.cancelled) {
          failures.push(`${vehicle.name}: ${result.error || 'nie udało się przydzielić'}`);
        }

        if (i < candidates.length - 1) await sleep(120);
      }

      setCrewStatus(
        `Zbiorczy przydział zakończony: pojazdy uzupełnione ${successVehicles}/${candidates.length}, przydzielono ${assignedPeople} osób` +
        (failures.length ? `, błędy: ${failures.length}. Szczegóły w konsoli.` : '.') ,
        failures.length ? 'warn' : 'ok'
      );

      if (failures.length) {
        console.warn('[OR Fleet Manager] Błędy zbiorczego przydziału:', failures);
      }
    } finally {
      state.crewBatchAssigning = false;
      renderCrewTable();
    }
  }

  function crewStatusHtml(result) {
    const cls = `or-fm-crew-${result.kind}`;
    return `<div class="or-fm-crew-result ${cls}" title="${esc(result.title || '')}">` +
      `<b>${esc(result.label)}</b><span>${esc(result.detail)}</span></div>`;
  }

  function renderCrewTable() {
    const tbody = document.getElementById(`${APP_ID}-crew-tbody`);
    const summary = document.getElementById(`${APP_ID}-crew-summary`);
    const pager = document.getElementById(`${APP_ID}-crew-pager`);
    if (!tbody || !summary || !pager) return;

    const batchButton = document.getElementById(`${APP_ID}-crew-assign-selected`);
    if (batchButton) {
      batchButton.disabled = state.crewBatchAssigning || state.crewSelected.size === 0;
      batchButton.textContent = state.crewBatchAssigning ? 'Przydzielam zaznaczone…' : 'Przydziel do max zaznaczone';
    }

    const filtered = crewFilteredVehicles();
    const pages = Math.max(1, Math.ceil(filtered.length / CREW_PAGE_SIZE));
    state.crewPage = Math.max(1, Math.min(state.crewPage, pages));
    const start = (state.crewPage - 1) * CREW_PAGE_SIZE;
    const current = filtered.slice(start, start + CREW_PAGE_SIZE);

    tbody.innerHTML = current.map(vehicle => {
      const selected = state.crewSelected.has(String(vehicle.id));
      const maxCrew = vehicleMaxCrew(vehicle);
      const assigned = Math.max(0, Number(vehicle.assignedPersonnelCount) || 0);
      const missing = maxCrew === null ? null : Math.max(0, maxCrew - assigned);
      const status = crewAvailability(vehicle);
      const fullCrew = maxCrew !== null && maxCrew > 0 && assigned >= maxCrew;
      const assigning = state.crewAssigning.has(String(vehicle.id));
      const canAssign = !fullCrew && missing > 0 && status.kind === 'ok' && !assigning;
      const assignTitle = fullCrew
        ? 'Pojazd ma już maksymalną załogę.'
        : status.kind === 'ok'
          ? 'Przydziel wolny personel do maksymalnej załogi.'
          : 'Przydział jest dostępny po pozytywnej weryfikacji personelu i kursów.';
      return `<tr class="${fullCrew ? 'or-fm-crew-full' : ''}">` +
        `<td class="or-fm-center"><input type="checkbox" class="or-fm-crew-row-check" data-vehicle-id="${esc(vehicle.id)}" ${selected ? 'checked' : ''}></td>` +
        `<td class="or-fm-id"><a href="/vehicles/${esc(vehicle.id)}" target="_blank" rel="noopener">${esc(vehicle.id)}</a></td>` +
        `<td>${esc(vehicle.buildingName)}</td>` +
        `<td>${esc(vehicle.typeName)}</td>` +
        `<td>${esc(vehicle.name)}</td>` +
        `<td class="or-fm-center or-fm-number">${maxCrew === null ? '?' : esc(maxCrew)}</td>` +
        `<td class="or-fm-center or-fm-number">${esc(assigned)}</td>` +
        `<td class="or-fm-center or-fm-number ${missing > 0 ? 'or-fm-missing' : ''}">${missing === null ? '?' : esc(missing)}</td>` +
        `<td class="or-fm-crew-status-cell">${crewStatusHtml(status)}</td>` +
        `<td class="or-fm-center"><button type="button" class="or-fm-btn or-fm-btn-small or-fm-assign-btn" data-vehicle-id="${esc(vehicle.id)}" title="${esc(assignTitle)}" ${canAssign ? '' : 'disabled'}>${assigning ? 'Przydzielam…' : fullCrew ? 'Pełna' : 'Do max'}</button></td>` +
        `</tr>`;
    }).join('') || `<tr><td colspan="10" class="or-fm-empty">Brak pojazdów dla wybranych filtrów.</td></tr>`;

    const missingCount = filtered.filter(vehicle => (vehicleMissingCrew(vehicle) || 0) > 0).length;
    const loadedBuildings = [...new Set(current.map(v => v.buildingId))]
      .filter(id => state.crewDetails.get(String(id))?.status === 'loaded').length;
    summary.textContent = `Widoczne: ${filtered.length} / ${state.vehicles.length} | Zaznaczone: ${state.crewSelected.size} | Z brakującą załogą: ${missingCount} | Strona ${state.crewPage}/${pages}`;

    pager.innerHTML = `
      <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-crew-prev" ${state.crewPage <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>${state.crewPage} / ${pages}</span>
      <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-crew-next" ${state.crewPage >= pages ? 'disabled' : ''}>Następna ›</button>`;

    document.getElementById(`${APP_ID}-crew-prev`)?.addEventListener('click', () => {
      state.crewPage -= 1;
      renderCrewTable();
    });
    document.getElementById(`${APP_ID}-crew-next`)?.addEventListener('click', () => {
      state.crewPage += 1;
      renderCrewTable();
    });

    tbody.querySelectorAll('.or-fm-crew-row-check').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const id = String(checkbox.dataset.vehicleId || '');
        if (checkbox.checked) state.crewSelected.add(id);
        else state.crewSelected.delete(id);
        renderCrewTable();
      });
    });

    tbody.querySelectorAll('.or-fm-assign-btn').forEach(button => {
      button.addEventListener('click', () => assignCrewToMax(button.dataset.vehicleId));
    });

    if (state.activeTab === 'crew' && current.length) {
      ensureCrewDetailsForVehicles(current);
    }
  }

  async function ensureCrewDetailsForVehicles(vehicles, force = false) {
    if (!vehicles?.length) return;
    const buildingIds = [...new Set(vehicles.map(v => String(v.buildingId)).filter(Boolean))];
    const queue = buildingIds.filter(buildingId => {
      const cached = state.crewDetails.get(buildingId);
      return force || !cached || cached.status === 'error';
    });
    if (!queue.length) return;

    const generation = state.crewLoadGeneration;
    state.crewLoading = true;
    let completed = 0;
    let errors = 0;

    for (const buildingId of queue) {
      state.crewDetails.set(buildingId, { status: 'loading' });
    }
    renderCrewTable();

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const buildingId = queue[index];
        if (generation !== state.crewLoadGeneration) return;
        setCrewStatus(`Sprawdzam personel jednostek: ${completed + errors}/${queue.length}…`, 'info');
        try {
          const detail = await fetchBuildingPersonnelDetail(buildingId);
          if (generation !== state.crewLoadGeneration) return;
          state.crewDetails.set(buildingId, { status: 'loaded', detail });
          completed += 1;
        } catch (error) {
          console.warn(`[OR Fleet Manager] Nie udało się pobrać personelu jednostki ${buildingId}:`, error);
          state.crewDetails.set(buildingId, { status: 'error', error: error?.message || String(error) });
          errors += 1;
        }
        renderCrewTable();
        await sleep(80);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CREW_DETAIL_CONCURRENCY, queue.length) }, () => worker())
    );

    if (generation === state.crewLoadGeneration) {
      state.crewLoading = false;
      setCrewStatus(
        errors
          ? `Sprawdzono ${completed} jednostek; błędy odczytu: ${errors}.`
          : `Sprawdzono personel i kursy w ${completed} jednostkach na bieżącej stronie.`,
        errors ? 'warn' : 'ok'
      );
      renderCrewTable();
    }
  }

  function switchManagerTab(tab) {
    state.activeTab = tab === 'crew' ? 'crew' : 'names';
    const crewActive = state.activeTab === 'crew';

    document.querySelectorAll(`#${APP_ID}-modal .or-fm-name-section`).forEach(element => {
      element.classList.toggle('or-fm-tab-hidden', crewActive);
    });
    document.getElementById(`${APP_ID}-crew-panel`)?.classList.toggle('or-fm-tab-active', crewActive);
    document.getElementById(`${APP_ID}-tab-names`)?.classList.toggle('or-fm-tab-selected', !crewActive);
    document.getElementById(`${APP_ID}-tab-crew`)?.classList.toggle('or-fm-tab-selected', crewActive);

    if (crewActive) {
      rebuildCrewFilterOptions();
      renderCrewTable();
    }
  }

  function setBusy(busy) {
    const root = document.getElementById(`${APP_ID}-modal`);
    if (!root) return;
    root.classList.toggle('or-fm-busy', !!busy);
  }

  function setStatus(message, kind = 'info') {
    const el = document.getElementById(`${APP_ID}-status`);
    if (!el) return;
    el.className = `or-fm-status or-fm-status-${kind}`;
    el.textContent = message;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.id = `${APP_ID}-styles`;
    style.textContent = `
      #${APP_ID}-button {
        position: fixed; right: 18px; bottom: 18px; z-index: 99990;
        border: 0; border-radius: 999px; padding: 11px 16px;
        background: #1565c0; color: white; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.28); font: 600 13px/1.2 Arial,sans-serif;
      }
      #${APP_ID}-button:hover { filter: brightness(1.08); }
      #${APP_ID}-modal { display:none; position:fixed; inset:0; z-index:99991; background:rgba(0,0,0,.56); font:13px/1.35 Arial,sans-serif; color:#222; }
      #${APP_ID}-modal.or-fm-open { display:flex; align-items:center; justify-content:center; }
      .or-fm-window { width:min(1500px,96vw); height:min(900px,94vh); background:#fff; border-radius:10px; box-shadow:0 12px 45px rgba(0,0,0,.45); display:flex; flex-direction:column; overflow:hidden; }
      .or-fm-header { display:flex; align-items:center; gap:12px; padding:12px 16px; background:#263238; color:#fff; }
      .or-fm-header h2 { margin:0; font-size:18px; flex:1; }
      .or-fm-close { border:0; background:transparent; color:#fff; font-size:26px; cursor:pointer; line-height:1; }
      .or-fm-tabs { display:flex; gap:0; border-bottom:1px solid #b0bec5; background:#eceff1; }
      .or-fm-tab { border:0; border-right:1px solid #cfd8dc; background:transparent; padding:9px 18px; font-weight:700; cursor:pointer; color:#455a64; }
      .or-fm-tab:hover { background:#e0e5e8; }
      .or-fm-tab.or-fm-tab-selected { background:#fff; color:#1565c0; box-shadow:inset 0 -3px 0 #1565c0; }
      .or-fm-tab-hidden { display:none !important; }
      .or-fm-crew-panel { display:none; min-height:0; flex:1; flex-direction:column; }
      .or-fm-crew-panel.or-fm-tab-active { display:flex; }
      .or-fm-toolbar { display:flex; flex-wrap:wrap; gap:8px; padding:10px 12px; border-bottom:1px solid #ddd; background:#f7f7f7; align-items:center; }
      .or-fm-toolbar input[type="text"], .or-fm-toolbar input[type="number"], .or-fm-toolbar select { min-height:32px; border:1px solid #bbb; border-radius:4px; padding:5px 8px; background:#fff; color:#222; }
      .or-fm-search { min-width:250px; flex:1 1 280px; }
      .or-fm-pattern { min-width:260px; flex:1 1 320px; }
      .or-fm-btn { display:inline-flex; align-items:center; justify-content:center; min-height:32px; border:1px solid #aaa; border-radius:4px; padding:5px 10px; background:#fff; color:#222; cursor:pointer; white-space:nowrap; }
      .or-fm-btn:hover:not(:disabled) { background:#eee; }
      .or-fm-btn:disabled { opacity:.45; cursor:not-allowed; }
      .or-fm-btn-primary { background:#1565c0; color:white; border-color:#0d47a1; }
      .or-fm-btn-primary:hover:not(:disabled) { background:#0d5bad; }
      .or-fm-btn-danger { background:#c62828; color:white; border-color:#8e0000; }
      .or-fm-btn-danger:hover:not(:disabled) { background:#a91f1f; }
      .or-fm-btn-warn { background:#ef6c00; color:white; border-color:#bd4e00; }
      .or-fm-btn-small { min-height:27px; padding:3px 8px; }
      .or-fm-check {
        display:inline-flex; align-items:center; gap:6px; min-height:32px;
        padding:4px 8px; border:1px solid #bbb; border-radius:4px;
        background:#fff; white-space:nowrap; cursor:pointer;
      }
      .or-fm-check input { margin:0; }
      .or-fm-help-wrap { background:#fff8e1; border-bottom:1px solid #ead9a4; }
      .or-fm-help-toggle {
        width:100%; display:flex; align-items:center; gap:8px; padding:8px 12px;
        border:0; background:transparent; color:#5d4a00; cursor:pointer;
        font:700 12px/1.35 Arial,sans-serif; text-align:left;
      }
      .or-fm-help-toggle:hover { background:rgba(255,255,255,.35); }
      .or-fm-help-arrow { display:inline-block; width:14px; transition:transform .15s ease; }
      .or-fm-help-wrap.or-fm-help-open .or-fm-help-arrow { transform:rotate(90deg); }
      .or-fm-help { display:none; padding:4px 12px 10px 34px; font-size:12px; }
      .or-fm-help-wrap.or-fm-help-open .or-fm-help { display:block; }
      .or-fm-body { min-height:0; flex:1; display:flex; flex-direction:column; }
      .or-fm-table-wrap { overflow:auto; flex:1; }
      .or-fm-table { width:100%; border-collapse:collapse; table-layout:auto; }
      .or-fm-table th { position:sticky; top:0; z-index:2; background:#eceff1; border-bottom:1px solid #bbb; padding:7px; text-align:left; white-space:nowrap; }
      .or-fm-table td { border-bottom:1px solid #eee; padding:5px 7px; vertical-align:middle; }
      .or-fm-table tr:hover td { background:#f7fbff; }
      .or-fm-table tr.or-fm-changed td { background:#fffde7; }
      .or-fm-table tr.or-fm-crew-full td { background:#e8f5e9; }
      .or-fm-table tr.or-fm-crew-full:hover td { background:#dcedc8; }
      .or-fm-table input[type="text"] { width:100%; min-width:240px; box-sizing:border-box; border:1px solid #bbb; border-radius:3px; padding:5px 7px; }
      .or-fm-number { font-weight:700; font-variant-numeric:tabular-nums; }
      .or-fm-missing { color:#b71c1c; background:#fff3f3; }
      .or-fm-crew-status-cell { min-width:300px; }
      .or-fm-crew-result { display:flex; align-items:flex-start; gap:8px; }
      .or-fm-crew-result > b { display:inline-flex; min-width:42px; justify-content:center; padding:2px 6px; border-radius:4px; }
      .or-fm-crew-result > span { font-size:12px; line-height:1.3; }
      .or-fm-crew-ok > b { background:#c8e6c9; color:#1b5e20; }
      .or-fm-crew-bad > b { background:#ffcdd2; color:#b71c1c; }
      .or-fm-crew-warn > b { background:#ffe0b2; color:#e65100; }
      .or-fm-crew-loading > b { background:#bbdefb; color:#0d47a1; }
      .or-fm-crew-unknown > b { background:#e0e0e0; color:#424242; }
      .or-fm-crew-neutral > b { background:#eceff1; color:#607d8b; }
      .or-fm-center { text-align:center; }
      .or-fm-id { white-space:nowrap; }
      .or-fm-empty { text-align:center; padding:30px !important; color:#777; }
      .or-fm-footer { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:9px 12px; border-top:1px solid #ddd; background:#fafafa; }
      .or-fm-summary { flex:1; min-width:300px; font-weight:600; }
      .or-fm-pager { display:flex; gap:8px; align-items:center; }
      .or-fm-status { padding:7px 12px; border-top:1px solid #ddd; font-size:12px; }
      .or-fm-status-info { background:#e3f2fd; color:#0d47a1; }
      .or-fm-status-ok { background:#e8f5e9; color:#1b5e20; }
      .or-fm-status-warn { background:#fff3e0; color:#e65100; }
      .or-fm-status-error { background:#ffebee; color:#b71c1c; }
      .or-fm-muted { color:#777; }
      #${APP_ID}-confirm { display:none; position:absolute; inset:0; z-index:4; background:rgba(0,0,0,.45); }
      .or-fm-confirm-card { width:min(680px,90%); max-height:80%; overflow:auto; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); background:#fff; border-radius:8px; padding:16px; box-shadow:0 10px 35px rgba(0,0,0,.4); }
      .or-fm-confirm-title { font-size:18px; font-weight:700; margin-bottom:12px; }
      .or-fm-confirm-list { display:flex; flex-direction:column; gap:5px; margin-bottom:14px; }
      .or-fm-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
      #${APP_ID}-modal.or-fm-busy .or-fm-toolbar button:not(#${APP_ID}-cancel-save),
      #${APP_ID}-modal.or-fm-busy .or-fm-footer button { opacity:.55; }
      @media (max-width: 800px) {
        .or-fm-window { width:100vw; height:100vh; border-radius:0; }
        .or-fm-toolbar { align-items:stretch; }
        .or-fm-toolbar > * { flex:1 1 100%; }
        .or-fm-table { font-size:12px; }
      }
    `;
    document.head.appendChild(style);
  }

  function createUi() {
    injectStyles();

    const button = document.createElement('button');
    button.id = `${APP_ID}-button`;
    button.type = 'button';
    button.textContent = '🚒 Flota OR';
    document.body.appendChild(button);

    const modal = document.createElement('div');
    modal.id = `${APP_ID}-modal`;
    modal.innerHTML = `
      <div class="or-fm-window" role="dialog" aria-modal="true" aria-label="Menedzer pojazdow Operator Ratunkowy">
        <div class="or-fm-header">
          <h2>🚒 Menedzer pojazdow OR <span class="or-fm-muted" style="font-size:12px;color:#cfd8dc">v2.08</span></h2>
          <button type="button" class="or-fm-close" id="${APP_ID}-close" title="Zamknij">×</button>
        </div>
        <div class="or-fm-tabs">
          <button type="button" class="or-fm-tab or-fm-tab-selected" id="${APP_ID}-tab-names">Nazwy</button>
          <button type="button" class="or-fm-tab" id="${APP_ID}-tab-crew">Załoga</button>
        </div>

        <div class="or-fm-toolbar or-fm-name-section">
          <input id="${APP_ID}-search" class="or-fm-search" type="text" placeholder="Szukaj: nazwa, typ, jednostka, ID...">
          <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-building-prev" title="Poprzednia jednostka">‹</button>
          <select id="${APP_ID}-building-filter"><option value="">Wszystkie jednostki</option></select>
          <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-building-next" title="Nastepna jednostka">›</button>
          <select id="${APP_ID}-type-filter"><option value="">Wszystkie typy</option></select>
          <select id="${APP_ID}-class-filter" title="Filtruj po klasie pojazdu">
            <option value="">Wszystkie klasy</option>
          </select>
          <span id="${APP_ID}-class-source" class="or-fm-muted" title="Zrodlo klas pojazdow"></span>
          <select id="${APP_ID}-sort" title="Kolejnosc listy i numerowania">
            <option value="default" ${state.sortMode === 'default' ? 'selected' : ''}>Sortuj: jednostka → typ → ID</option>
            <option value="name_asc" ${state.sortMode === 'name_asc' ? 'selected' : ''}>Sortuj: nazwa A → Z</option>
            <option value="name_desc" ${state.sortMode === 'name_desc' ? 'selected' : ''}>Sortuj: nazwa Z → A</option>
          </select>
          <button type="button" class="or-fm-btn" id="${APP_ID}-reload">↻ Wczytaj ponownie</button>
          <select id="${APP_ID}-export-scope" title="Zakres eksportu CSV">
            <option value="filtered">Eksport: filtrowane</option>
            <option value="selected">Eksport: zaznaczone</option>
            <option value="all">Eksport: wszystkie</option>
          </select>
          <button type="button" class="or-fm-btn" id="${APP_ID}-export-csv">⇩ CSV</button>
          <button type="button" class="or-fm-btn" id="${APP_ID}-export-aao-classes" title="Eksportuje rozpoznane i nierozpoznane pola klas z formularza AAO">⇩ Klasy AAO CSV</button>
        </div>

        <div class="or-fm-toolbar or-fm-name-section">
          <button type="button" class="or-fm-btn" id="${APP_ID}-select-page">Zaznacz strone</button>
          <button type="button" class="or-fm-btn" id="${APP_ID}-select-filtered">Zaznacz wszystkie filtrowane</button>
          <button type="button" class="or-fm-btn" id="${APP_ID}-clear-selection">Wyczysc zaznaczenie</button>
          <span style="width:1px;height:24px;background:#ccc"></span>
          <select id="${APP_ID}-pattern-preset" title="Gotowe szablony nazw">
            <option value="">Szablony...</option>
            <option value="type_unit">{typ}[{n:typ:02}-{jednostka:[]}]</option>
            <option value="editable_ww">ww[{n:typ:02}-{jednostka:[]}]</option>
            <option value="old_dual">{stara}{n:jednostka+typ:02}-{n:jednostka:02}</option>
            <option value="old_bracket">{stara}[{n:typ:02}-{jednostka:[]}]</option>
          </select>
          <input id="${APP_ID}-pattern" class="or-fm-pattern" type="text" value="${esc(state.settings.pattern)}" title="Szablon nazwy - po wybraniu gotowego szablonu nadal mozna go dowolnie edytowac">
          <input id="${APP_ID}-start-number" type="number" min="0" value="${esc(state.settings.startNumber)}" style="width:85px" title="Numer poczatkowy">
          <select id="${APP_ID}-numbering" title="Domyslny sposob numeracji dla {n}, {n:02}, {n:03}">
            <option value="type" ${state.settings.numbering === 'type' ? 'selected' : ''}>Domyslnie: osobno dla typu</option>
            <option value="building" ${state.settings.numbering === 'building' ? 'selected' : ''}>Domyslnie: osobno dla jednostki</option>
            <option value="building_type" ${state.settings.numbering === 'building_type' ? 'selected' : ''}>Domyslnie: typ osobno w jednostce</option>
            <option value="global" ${state.settings.numbering === 'global' ? 'selected' : ''}>Domyslnie: globalnie</option>
          </select>
          <label class="or-fm-check" title="Przelicza cala jednostke wg aktualnego sortowania; dodaje brakujace i poprawia istniejace numery ]xx-zz">
            <input type="checkbox" id="${APP_ID}-continue-existing" ${state.settings.continueExistingDualNumbering ? 'checked' : ''}>
            Kontynuuj ]xx-zz
          </label>
          <label class="or-fm-check" title="Przelicza wszystkie pojazdy danego typu wg aktualnego sortowania; poprawia [xx-JEDNOSTKA] i zachowuje wszystko po ]">
            <input type="checkbox" id="${APP_ID}-continue-bracket" ${state.settings.continueExistingBracketNumbering ? 'checked' : ''}>
            Kontynuuj [xx-JEDNOSTKA]
          </label>
          <button type="button" class="or-fm-btn or-fm-btn-primary" id="${APP_ID}-generate">Przygotuj nazwy</button>
          <button type="button" class="or-fm-btn" id="${APP_ID}-reset-drafts">Cofnij przygotowane</button>
          <button type="button" class="or-fm-btn or-fm-btn-danger" id="${APP_ID}-save">Zapisz zaznaczone</button>
          <button type="button" class="or-fm-btn or-fm-btn-warn" id="${APP_ID}-cancel-save" style="display:none">■ Przerwij zapis</button>
        </div>

        <div class="or-fm-help-wrap or-fm-name-section" id="${APP_ID}-help-wrap">
          <button type="button" class="or-fm-help-toggle" id="${APP_ID}-help-toggle" aria-expanded="false">
            <span class="or-fm-help-arrow">›</span>
            <span>Pomoc / dostępne znaczniki</span>
          </button>
          <div class="or-fm-help" id="${APP_ID}-help">

          Filtr jednostki: przyciski <b>‹</b> i <b>›</b> przechodza do poprzedniej / nastepnej jednostki.
          Kazda zmiana jednostki automatycznie czysci zaznaczenie pojazdow.<br>
          Filtr <b>Klasa pojazdu</b> jest budowany z formularza <code>/aaos/new</code>.
          v2.0 rozpoznaje zarowno standardowe pola AAO, np. <code>fire</code>, <code>rw</code>,
          <code>dlk</code>, <code>rtw</code>, jak i bezposrednie pola <code>vehicle_type_ids[...]</code>.
          Standardowe pola sa laczone z typami za pomoca katalogu pojazdow.
          Przycisk <b>Klasy AAO CSV</b> eksportuje wszystkie znalezione pola i pokazuje,
          ktore z nich nadal nie maja mapowania do ID typow.<br>
          Szablon: <b>{typ}</b> = typ pojazdu, <b>{jednostka}</b> = pelna nazwa jednostki, <b>{id}</b> = ID, <b>{stara}</b> = obecna nazwa.<br>
          Ze starej nazwy: <b>{stara:przed[]}</b> = wszystko przed pierwszym znakiem <b>[</b>.
          Np. <code>GBA 2,5/16 [JRG 1]</code> → <code>GBA 2,5/16</code>.<br>
          Usuwanie znakow ze starej nazwy:
          <b>{stara:koniec:3}</b> = usuwa 3 znaki od konca,
          <b>{stara:poczatek:3}</b> = usuwa 3 znaki od poczatku.
          Liczbe <b>3</b> mozesz zastapic dowolna liczba znakow.<br>
          Numer domyslny: <b>{n}</b> / <b>{n:02}</b> / <b>{n:03}</b> — korzysta z pola „Domyslnie”.<br>
          Numer z wlasnym zakresem:
          <b>{n:typ:02}</b> = osobno dla kazdego typu,
          <b>{n:jednostka:02}</b> = osobno dla kazdej jednostki,
          <b>{n:jednostka+typ:02}</b> = osobno dla kazdego typu w kazdej jednostce,
          <b>{n:global:02}</b> = jedna numeracja dla wszystkich zaznaczonych.<br>
          <b>Kontynuuj ]xx-zz</b>: dla schematu <code>{stara}{n:jednostka+typ:02}-{n:jednostka:02}</code>
          skrypt bierze pod uwage <b>aktualne sortowanie</b> i przelicza cala jednostke.
          <b>xx</b> = kolejny numer typu w jednostce, <b>zz</b> = kolejny numer pojazdu w jednostce.
          Brakujace koncowki sa dodawane, a istniejace <code>]xx-zz</code> sa zmieniane, jezeli po aktualnym sortowaniu powinny miec inne numery.
          Zaznaczenie jednego pojazdu powoduje objecie operacja calej jego jednostki.<br>
          <b>Kontynuuj [xx-JEDNOSTKA]</b>: dla schematu np. <code>S[{n:typ:02}-{jednostka:[]}]</code>
          skrypt przelicza <b>wszystkie pojazdy zaznaczonego typu</b> wedlug aktualnego sortowania.
          Istniejace numery w nawiasach sa poprawiane, a brakujace dodawane.
          Wszystko znajdujace sie po <code>]</code>, np. <code>01-06</code>, pozostaje bez zmian.
          Zaznaczenie jednego pojazdu danego typu powoduje objecie operacja wszystkich pojazdow tego typu.<br>
          Gotowe szablony: lista <b>„Szablony...”</b> wypelnia pole szablonu, ale nie blokuje jego edycji.
          Dostepny jest tez szablon <code>{stara}{n:jednostka+typ:02}-{n:jednostka:02}</code> do numeracji koncowki <code>]xx-zz</code>.
          W wariancie <code>ww[{n:typ:02}-{jednostka:[]}]</code> zaznaczony zostanie tekst <b>ww</b>, aby mozna go bylo od razu zastapic wlasnym oznaczeniem.<br>
          Mozna pominac szerokosc, np. <b>{n:typ}</b>, albo podac inna, np. <b>{n:typ:03}</b>.<br>
          <b>Kolejnosc numerowania jest taka sama jak wybrane sortowanie listy.</b>
          Przy „Sortuj: nazwa A → Z” token <b>{n:jednostka:02}</b> numeruje pojazdy w kazdej jednostce wedlug ich obecnych nazw A-Z.<br>
          Fragment nazwy jednostki: <b>{jednostka:1}</b> = pierwszy czlon, <b>{jednostka:2}</b> = drugi,
          <b>{jednostka:1-2}</b> = czlony 1-2, <b>{jednostka:2-}</b> = od drugiego do konca,
          <b>{jednostka:first}</b> / <b>{jednostka:last}</b> = pierwszy / ostatni,
          <b>{jednostka:[]}</b> = tekst miedzy pierwsza para nawiasow kwadratowych.<br>
          Przyklad: <code>{jednostka:[]} {typ} {n:jednostka+typ:02}</code>
          — GBA w kazdej jednostce otrzyma 01, 02, 03... niezaleznie od GBA w innych jednostkach.
          „Przygotuj nazwy” tylko tworzy podglad — zapis do gry nastapi dopiero po „Zapisz zaznaczone” i potwierdzeniu.<br>
          Eksport CSV zapisuje kolumny: <b>ID, Jednostka, Typ, Obecna nazwa, Nowa nazwa</b>.
          Plik jest w UTF-8, pola sa rozdzielane przecinkami i zachowuje aktualne sortowanie.
        
          </div>
        </div>

        <div class="or-fm-body or-fm-name-section">
          <div class="or-fm-table-wrap">
            <table class="or-fm-table">
              <thead><tr>
                <th style="width:36px">✓</th>
                <th>ID</th>
                <th>Jednostka</th>
                <th>Typ</th>
                <th>Obecna nazwa</th>
                <th style="min-width:320px">Nowa nazwa</th>
              </tr></thead>
              <tbody id="${APP_ID}-tbody"><tr><td colspan="6" class="or-fm-empty">Otworz menedzer, aby pobrac dane.</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="or-fm-footer or-fm-name-section">
          <div class="or-fm-summary" id="${APP_ID}-summary">Nie wczytano danych.</div>
          <div class="or-fm-pager" id="${APP_ID}-pager"></div>
        </div>

        <div class="or-fm-crew-panel" id="${APP_ID}-crew-panel">
          <div class="or-fm-toolbar">
            <input id="${APP_ID}-crew-search" class="or-fm-search" type="text" placeholder="Szukaj w załodze: nazwa, typ, jednostka, ID...">
            <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-crew-building-prev" title="Poprzednia jednostka">‹</button>
            <select id="${APP_ID}-crew-building-filter"><option value="">Wszystkie jednostki</option></select>
            <button type="button" class="or-fm-btn or-fm-btn-small" id="${APP_ID}-crew-building-next" title="Następna jednostka">›</button>
            <select id="${APP_ID}-crew-type-filter"><option value="">Wszystkie typy</option></select>
            <label class="or-fm-check" title="Pokaż tylko pojazdy, które nie mają jeszcze maksymalnej liczby przydzielonych osób">
              <input type="checkbox" id="${APP_ID}-crew-only-missing"> Tylko brakująca załoga
            </label>
            <button type="button" class="or-fm-btn" id="${APP_ID}-crew-select-page">Zaznacz stronę</button>
            <button type="button" class="or-fm-btn" id="${APP_ID}-crew-select-filtered">Zaznacz filtrowane</button>
            <button type="button" class="or-fm-btn" id="${APP_ID}-crew-clear-selection">Wyczyść zaznaczenie</button>
            <button type="button" class="or-fm-btn or-fm-btn-primary" id="${APP_ID}-crew-assign-selected">Przydziel do max zaznaczone</button>
            <button type="button" class="or-fm-btn" id="${APP_ID}-crew-refresh">↻ Odśwież personel</button>
          </div>
          <div class="or-fm-help-wrap">
            <div class="or-fm-help-toggle" style="cursor:default">
              <span>👥 Załoga: wolny personel jest liczony na podstawie pustej kolumny „Przydzielono do” (nie na podstawie stanu „Dostępne”). „Czy można do max?” uwzględnia też wymagane kursy. Możesz zaznaczyć kilka pojazdów i użyć „Przydziel do max zaznaczone”; skrypt obsługuje je kolejno i przed każdym pojazdem ponownie sprawdza personel. Zielony wiersz oznacza pojazd z maksymalną obsadą.</span>
            </div>
          </div>
          <div class="or-fm-body">
            <div class="or-fm-table-wrap">
              <table class="or-fm-table">
                <thead><tr>
                  <th style="width:36px">✓</th>
                  <th>ID</th>
                  <th>Jednostka</th>
                  <th>Typ</th>
                  <th>Pojazd</th>
                  <th>Max załoga</th>
                  <th>Przydzielona załoga</th>
                  <th>Brakująca załoga</th>
                  <th>Czy w jednostce można uzupełnić do max?</th>
                  <th>Przydział</th>
                </tr></thead>
                <tbody id="${APP_ID}-crew-tbody"><tr><td colspan="10" class="or-fm-empty">Otwórz kartę Załoga, aby sprawdzić personel.</td></tr></tbody>
              </table>
            </div>
          </div>
          <div class="or-fm-footer">
            <div class="or-fm-summary" id="${APP_ID}-crew-summary">Nie wczytano danych.</div>
            <div class="or-fm-pager" id="${APP_ID}-crew-pager"></div>
          </div>
          <div id="${APP_ID}-crew-status" class="or-fm-status or-fm-status-info">Szczegóły personelu zostaną pobrane po otwarciu tej karty.</div>
        </div>
        <div id="${APP_ID}-status" class="or-fm-status or-fm-status-info">Gotowy.</div>
        <div id="${APP_ID}-confirm"></div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById(`${APP_ID}-tab-names`).addEventListener('click', () => switchManagerTab('names'));
    document.getElementById(`${APP_ID}-tab-crew`).addEventListener('click', () => switchManagerTab('crew'));

    const crewSearch = document.getElementById(`${APP_ID}-crew-search`);
    let crewSearchTimer = null;
    crewSearch.addEventListener('input', () => {
      clearTimeout(crewSearchTimer);
      crewSearchTimer = setTimeout(() => {
        state.crewQuery = crewSearch.value;
        state.crewPage = 1;
        renderCrewTable();
      }, 120);
    });

    document.getElementById(`${APP_ID}-crew-building-filter`).addEventListener('change', event => {
      applyCrewBuildingFilter(event.target.value);
    });

    document.getElementById(`${APP_ID}-crew-building-prev`).addEventListener('click', () => {
      changeCrewBuildingFilterByStep(-1);
    });

    document.getElementById(`${APP_ID}-crew-building-next`).addEventListener('click', () => {
      changeCrewBuildingFilterByStep(1);
    });

    document.getElementById(`${APP_ID}-crew-type-filter`).addEventListener('change', event => {
      state.crewTypeId = event.target.value;
      state.crewPage = 1;
      renderCrewTable();
    });

    document.getElementById(`${APP_ID}-crew-only-missing`).addEventListener('change', event => {
      state.crewOnlyMissing = !!event.target.checked;
      state.crewPage = 1;
      renderCrewTable();
    });

    document.getElementById(`${APP_ID}-crew-select-page`).addEventListener('click', () => {
      const filtered = crewFilteredVehicles();
      const start = (state.crewPage - 1) * CREW_PAGE_SIZE;
      filtered.slice(start, start + CREW_PAGE_SIZE).forEach(vehicle => state.crewSelected.add(String(vehicle.id)));
      renderCrewTable();
    });

    document.getElementById(`${APP_ID}-crew-select-filtered`).addEventListener('click', () => {
      crewFilteredVehicles().forEach(vehicle => state.crewSelected.add(String(vehicle.id)));
      renderCrewTable();
    });

    document.getElementById(`${APP_ID}-crew-clear-selection`).addEventListener('click', () => {
      state.crewSelected.clear();
      renderCrewTable();
    });

    document.getElementById(`${APP_ID}-crew-assign-selected`).addEventListener('click', () => {
      assignSelectedCrewToMax();
    });

    document.getElementById(`${APP_ID}-crew-refresh`).addEventListener('click', () => {
      state.crewLoadGeneration += 1;
      state.crewDetails.clear();
      state.crewLoading = false;
      setCrewStatus('Odświeżam personel i kursy…', 'info');
      renderCrewTable();
    });

    button.addEventListener('click', async () => {
      modal.classList.add('or-fm-open');
      if (!state.vehicles.length && !state.loading) await loadData();
      switchManagerTab(state.activeTab);
    });

    document.getElementById(`${APP_ID}-close`).addEventListener('click', () => {
      if (!state.saving) modal.classList.remove('or-fm-open');
      else setStatus('Trwa zapis nazw. Najpierw go zakoncz albo kliknij „Przerwij zapis”.', 'warn');
    });

    modal.addEventListener('click', event => {
      // Klikniecia wewnatrz okna nie powinny docierac do strony gry.
      if (event.target !== modal) {
        event.stopPropagation();
        return;
      }

      if (!state.saving) modal.classList.remove('or-fm-open');
    });

    // OperatorRatunkowy.pl ma wlasne globalne obslugi klawiatury.
    // Zatrzymujemy propagacje klawiszy uzywanych wewnatrz menedzera,
    // ale dopiero po obsluzeniu ich przez konkretne pole/input.
    ['keydown', 'keyup', 'keypress'].forEach(eventName => {
      modal.addEventListener(eventName, event => {
        if (event.target !== modal) event.stopPropagation();
      });
    });

    // To samo dla podstawowych zdarzen formularzy, aby zmiana pola wyszukiwania,
    // kasowanie tekstu lub edycja szablonu nie uruchamialy reakcji strony gry.
    ['input', 'change', 'mousedown', 'mouseup'].forEach(eventName => {
      modal.addEventListener(eventName, event => {
        if (event.target !== modal) event.stopPropagation();
      });
    });

    const search = document.getElementById(`${APP_ID}-search`);
    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = search.value;
        state.page = 1;
        renderTable();
      }, 120);
    });

    document.getElementById(`${APP_ID}-building-filter`).addEventListener('change', event => {
      applyBuildingFilter(event.target.value, 'list');
    });

    document.getElementById(`${APP_ID}-building-prev`).addEventListener('click', () => {
      changeBuildingFilterByStep(-1);
    });

    document.getElementById(`${APP_ID}-building-next`).addEventListener('click', () => {
      changeBuildingFilterByStep(1);
    });

    document.getElementById(`${APP_ID}-type-filter`).addEventListener('change', event => {
      state.typeId = event.target.value;
      state.page = 1;
      renderTable();
    });

    document.getElementById(`${APP_ID}-class-filter`).addEventListener('change', event => {
      state.classId = event.target.value;
      state.page = 1;
      renderTable();

      const label = event.target.selectedOptions?.[0]?.textContent || 'Wszystkie klasy';
      setStatus(`Filtr klasy: ${label}.`, 'info');
    });

    document.getElementById(`${APP_ID}-sort`).addEventListener('change', event => {
      state.sortMode = event.target.value || 'default';
      state.settings.sortMode = state.sortMode;
      saveSettings();
      state.page = 1;
      renderTable();
      setStatus(
        state.sortMode === 'name_asc'
          ? 'Sortowanie po nazwie A-Z. Numeracja bedzie nadawana w tej kolejnosci.'
          : state.sortMode === 'name_desc'
            ? 'Sortowanie po nazwie Z-A. Numeracja bedzie nadawana w tej kolejnosci.'
            : 'Sortowanie domyslne: jednostka → typ → ID.',
        'info'
      );
    });

    document.getElementById(`${APP_ID}-reload`).addEventListener('click', () => loadData(true));

    document.getElementById(`${APP_ID}-export-csv`).addEventListener('click', () => {
      const scope = document.getElementById(`${APP_ID}-export-scope`).value || 'filtered';
      exportVehiclesCsv(scope);
    });

    document.getElementById(`${APP_ID}-export-aao-classes`).addEventListener('click', () => {
      exportAAOClassDiagnosticsCsv();
    });

    document.getElementById(`${APP_ID}-select-page`).addEventListener('click', () => {
      const filtered = filteredVehicles();
      const start = (state.page - 1) * PAGE_SIZE;
      filtered.slice(start, start + PAGE_SIZE).forEach(v => state.selected.add(v.id));
      renderTable();
    });

    document.getElementById(`${APP_ID}-select-filtered`).addEventListener('click', () => {
      filteredVehicles().forEach(v => state.selected.add(v.id));
      renderTable();
    });

    document.getElementById(`${APP_ID}-clear-selection`).addEventListener('click', () => {
      state.selected.clear();
      renderTable();
    });

    document.getElementById(`${APP_ID}-pattern-preset`).addEventListener('change', event => {
      const patternInput = document.getElementById(`${APP_ID}-pattern`);
      const preset = event.target.value;

      if (preset === 'type_unit') {
        patternInput.value = '{typ}[{n:typ:02}-{jednostka:[]}]';
        patternInput.focus();
      } else if (preset === 'editable_ww') {
        patternInput.value = 'ww[{n:typ:02}-{jednostka:[]}]';
        patternInput.focus();
        patternInput.setSelectionRange(0, 2);
      } else if (preset === 'old_dual') {
        patternInput.value = '{stara}{n:jednostka+typ:02}-{n:jednostka:02}';
        patternInput.focus();
      } else if (preset === 'old_bracket') {
        patternInput.value = '{stara}[{n:typ:02}-{jednostka:[]}]';
        patternInput.focus();
      }

      // Lista jest tylko narzedziem do wstawiania - po wyborze wraca do pozycji startowej.
      event.target.value = '';
    });

    document.getElementById(`${APP_ID}-continue-existing`).addEventListener('change', event => {
      const checked = !!event.target.checked;
      state.settings.continueExistingDualNumbering = checked;

      if (checked) {
        const other = document.getElementById(`${APP_ID}-continue-bracket`);
        other.checked = false;
        state.settings.continueExistingBracketNumbering = false;
      }

      saveSettings();
      setStatus(
        checked
          ? 'Wlaczono kontynuacje ]xx-zz. Cala jednostka bedzie przeliczana wg aktualnego sortowania.'
          : 'Wylaczono kontynuacje numeracji ]xx-zz.',
        'info'
      );
    });

    document.getElementById(`${APP_ID}-continue-bracket`).addEventListener('change', event => {
      const checked = !!event.target.checked;
      state.settings.continueExistingBracketNumbering = checked;

      if (checked) {
        const other = document.getElementById(`${APP_ID}-continue-existing`);
        other.checked = false;
        state.settings.continueExistingDualNumbering = false;
      }

      saveSettings();
      setStatus(
        checked
          ? 'Wlaczono kontynuacje [xx-JEDNOSTKA]. Wszystkie pojazdy danego typu beda przeliczane wg aktualnego sortowania; wszystko po ] zostanie zachowane.'
          : 'Wylaczono kontynuacje numeracji [xx-JEDNOSTKA].',
        'info'
      );
    });

    document.getElementById(`${APP_ID}-generate`).addEventListener('click', generateNames);
    document.getElementById(`${APP_ID}-reset-drafts`).addEventListener('click', resetDraftsForSelected);

    document.getElementById(`${APP_ID}-save`).addEventListener('click', () => {
      const plan = buildRenamePlan();
      if (!state.selected.size) {
        alert('Najpierw zaznacz pojazdy, ktore chcesz zapisac.');
        return;
      }
      if (!plan.length) {
        alert('W zaznaczonych pojazdach nie ma przygotowanych zmian nazw.');
        return;
      }
      openConfirmation(plan);
    });

    document.getElementById(`${APP_ID}-cancel-save`).addEventListener('click', () => {
      state.cancelSave = true;
      setStatus('Przerwanie zostalo zlecone. Biezacy zapis zostanie dokonczony i operacja sie zatrzyma.', 'warn');
    });

    document.getElementById(`${APP_ID}-help-toggle`).addEventListener('click', () => {
      const wrap = document.getElementById(`${APP_ID}-help-wrap`);
      const toggle = document.getElementById(`${APP_ID}-help-toggle`);
      const isOpen = wrap.classList.toggle('or-fm-help-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('keydown', event => {
      if (!modal.classList.contains('or-fm-open')) return;

      // Escape zamyka okno tylko wtedy, gdy fokus NIE jest w polu edycyjnym.
      // Dzięki temu praca w wyszukiwarce i polach tekstowych nie zamyka przypadkiem menedzera.
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;

      if (event.key === 'Escape' && !isEditable && !state.saving) {
        modal.classList.remove('or-fm-open');
      }
    });
  }

  createUi();
  console.log('[OR Fleet Manager] Wersja 2.08 zaladowana. Przycisk „Flota OR” znajduje sie w prawym dolnym rogu.');
})();
