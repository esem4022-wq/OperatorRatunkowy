// ==UserScript==
// @name         Operator Ratunkowy - Menedzer budynkow OR
// @namespace    operatorratunkowy.local.buildingmanager
// @version      0.11.0
// @description  Zarzadzanie budynkami: nazwy, specjalizacje, pojazdy i obsada w OperatorRatunkowy.pl
// @author       ChatGPT
// @license      CC BY-NC-SA 4.0
// @homepageURL   https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL     https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-budynkow-or.user.js
// @downloadURL   https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-budynkow-or.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Operator Ratunkowy - Menedzer budynkow OR
 * Wersja 0.11.0
 *
 * Funkcje:
 * - pobiera wszystkie budynki z API gry,
 * - pobiera polskie nazwy typow budynkow z API LSS-Manager,
 * - wyszukiwanie i filtrowanie po typie budynku,
 * - osobna zakladka Specjalizacje z lista rozbudow/specjalizacji dla kazdego budynku,
 * - osobna zakladka Obsada i pojazdy: liczba pojazdow, pojemnosc, personel, cel, bilans i rekrutacja,
 * - filtry obsady: brakuje zalogi / za duzo zalogi,
 * - edycja docelowej liczby pracownikow i sterowanie rekrutacja bezposrednio z tabeli,
 * - mozliwosc ukrycia kolumny Typ budynku w zakladce Obsada i pojazdy,
 * - zaznaczanie pojedynczych, widocznych lub wszystkich filtrowanych budynkow,
 * - reczna edycja przygotowanej nazwy,
 * - generator nazw z polami:
 *   {typ}, {id}, {stara}, {n}, {n:02}, {n:03},
 *   {stara:1}, {stara:2}, {stara:1-2}, {stara:2-},
 *   {stara:first}, {stara:last}, {stara:[]}, {stara:poza[]}
 * - alias {nazwa:...} dziala tak samo jak {stara:...},
 * - numeracja globalna albo osobno dla typu budynku,
 * - podglad zmian przed zapisem,
 * - zapis sekwencyjny z mozliwoscia przerwania.
 *
 * Zapis nazwy:
 * Skrypt pobiera standardowy formularz /buildings/{id}/edit,
 * zmienia tylko pole #building_name i wysyla ten sam formularz z powrotem.
 */

(() => {
  'use strict';

  const APP_ID = 'or-building-manager-v01';
  const STORAGE_KEY = 'orBuildingManagerV01Settings';
  const PAGE_SIZE = 200;
  const BUILDING_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/buildings';
  const VEHICLE_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/vehicles';
  const FLEET_MANAGER_BUTTON_ID = 'or-fleet-manager-v01-button';

  if (window.top !== window.self) return;
  if (document.getElementById(`${APP_ID}-button`)) return;

  const state = {
    buildings: [],
    buildingTypes: {},
    loading: false,
    saving: false,
    cancelSave: false,
    page: 1,
    specializationPage: 1,
    staffingPage: 1,
    activeTab: 'rename',
    query: '',
    typeId: '',
    specializationFilter: '',
    specializationPresence: 'all',
    staffingFilter: 'all',
    vehicles: [],
    vehicleTypes: {},
    selected: new Set(),
    draftNames: new Map(),
    settings: loadSettings(),
  };

  function loadSettings() {
    try {
      return Object.assign({
        pattern: '{stara}',
        startNumber: 1,
        numbering: 'type',
        showStaffingBuildingType: true,
      }, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_) {
      return { pattern: '{stara}', startNumber: 1, numbering: 'type', showStaffingBuildingType: true };
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

  async function fetchBuildings() {
    try {
      return await fetchAllPages('/api/v2/buildings?limit=2000');
    } catch (v2Error) {
      console.warn('[OR Building Manager] /api/v2/buildings niedostepne, proba starszego API.', v2Error);
      return normalizeResult(await fetchJson('/api/buildings'));
    }
  }

  async function fetchBuildingCatalog() {
    try {
      const response = await fetch(BUILDING_CATALOG_URL, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      console.warn('[OR Building Manager] Polski katalog typow budynkow LSSM jest niedostepny.', error);
      return {};
    }
  }

  async function fetchVehicles() {
    try {
      return await fetchAllPages('/api/v2/vehicles?limit=10000');
    } catch (v2Error) {
      console.warn('[OR Building Manager] /api/v2/vehicles niedostepne, proba starszego API.', v2Error);
      return normalizeResult(await fetchJson('/api/vehicles'));
    }
  }

  async function fetchVehicleCatalog() {
    try {
      const response = await fetch(VEHICLE_CATALOG_URL, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      console.warn('[OR Building Manager] Polski katalog typow pojazdow LSSM jest niedostepny.', error);
      return {};
    }
  }

  function valueOf(obj, keys, fallback = null) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return fallback;
  }

  function getCatalogEntry(catalog, typeId) {
    if (!catalog) return null;
    return catalog?.[typeId] ?? catalog?.[Number(typeId)] ?? null;
  }

  function numberValue(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function optionalNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function getVehicleCatalogEntry(catalog, typeId) {
    if (!catalog) return null;
    return catalog?.[typeId] ?? catalog?.[Number(typeId)] ?? null;
  }

  function getVehicleMaxCrew(vehicle, catalog) {
    const override = optionalNumber(valueOf(vehicle, ['max_personnel_override'], null));
    if (override !== null) return Math.max(0, override);

    const entry = getVehicleCatalogEntry(catalog, valueOf(vehicle, ['vehicle_type', 'type'], ''));
    return Math.max(
      0,
      numberValue(
        valueOf(entry, ['maxPersonnel', 'max_personnel'], null) ??
        entry?.staff?.max,
        0
      )
    );
  }

  function getParkingCapacity(rawBuilding, catalog) {
    const typeId = String(valueOf(rawBuilding, ['building_type', 'building_type_id', 'type'], ''));
    const entry = getCatalogEntry(catalog, typeId);

    if (!entry || entry.startParkingLots === undefined || entry.startParkingLots === null) {
      return null;
    }

    const level = Math.max(0, numberValue(valueOf(rawBuilding, ['level'], 0), 0));
    const start = Math.max(0, numberValue(entry.startParkingLots, 0));
    const perLevel = Math.max(0, numberValue(entry.parkingLotsPerLevel, 1));

    let capacity = start + (level * perLevel);

    const rawExtensions = valueOf(rawBuilding, ['extensions'], []);
    const extensions = Array.isArray(rawExtensions)
      ? rawExtensions
      : rawExtensions && typeof rawExtensions === 'object'
        ? Object.values(rawExtensions)
        : [];

    for (const extension of extensions) {
      // Rozbudowa daje miejsca dopiero, gdy jest ukonczona/dostepna.
      if (!boolValue(valueOf(extension, ['available'], true), true)) continue;

      const extensionTypeId = String(valueOf(extension, ['type_id', 'typeId', 'id'], ''));
      const meta = getCatalogExtension(catalog, typeId, extensionTypeId);
      if (!meta) continue;

      capacity += Math.max(0, numberValue(meta.givesParkingLots, 0));

      // Nie wszystkie wersje gry korzystaja z tego pola, ale jesli katalog je
      // zawiera, uwzgledniamy je zgodnie z definicja LSSM.
      if (meta.givesParkingLotsPerLevel !== undefined && meta.givesParkingLotsPerLevel !== null) {
        capacity += Math.max(0, numberValue(meta.givesParkingLotsPerLevel, 0)) * level;
      }
    }

    return Math.max(0, Math.round(capacity));
  }

  function recruitmentText(building) {
    const phase = Math.max(0, numberValue(building.hiringPhase, 0));
    const automatic = !!building.hiringAutomatic;

    if (phase > 0) {
      return `TAK — ${phase} ${phase === 1 ? 'dzien' : 'dni'}${automatic ? ' (auto)' : ''}`;
    }

    return automatic ? 'NIE — auto wlaczone' : 'NIE';
  }

  function recruitmentValue(building) {
    if (building.hiringAutomatic) return 'automatic';
    const phase = Math.max(0, numberValue(building.hiringPhase, 0));
    return ['1', '2', '3'].includes(String(phase)) ? String(phase) : '0';
  }

  function recruitmentOptions(building) {
    const current = recruitmentValue(building);
    return [
      ['0', 'Wylaczona'],
      ['1', '1 dzien'],
      ['2', '2 dni'],
      ['3', '3 dni'],
      ['automatic', 'Automatyczna'],
    ].map(([value, label]) =>
      `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`
    ).join('');
  }

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  }

  async function savePersonnelTarget(building, target) {
    const value = Math.max(0, Math.trunc(numberValue(target, building.personnelTarget)));
    const token = csrfToken();
    if (!token) throw new Error('Nie znaleziono tokenu CSRF strony.');

    const params = new URLSearchParams();
    params.set('utf8', '✓');
    params.set('_method', 'put');
    params.set('authenticity_token', token);
    params.set('building[personal_count_target]', String(value));

    const response = await fetch(`/buildings/${encodeURIComponent(building.id)}?personal_count_target_only=1`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Thirdparty-Script': 'OR-Building-Manager',
        'Accept': 'text/javascript, application/json, */*; q=0.01',
      },
      body: params.toString(),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Nie mozna zapisac docelowej liczby pracownikow (HTTP ${response.status}).`);
    }

    building.personnelTarget = value;
    return value;
  }

  async function saveRecruitment(building, value) {
    const allowed = new Set(['0', '1', '2', '3', 'automatic']);
    const action = allowed.has(String(value)) ? String(value) : '0';

    const response = await fetch(`/buildings/${encodeURIComponent(building.id)}/hire_do/${encodeURIComponent(action)}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Thirdparty-Script': 'OR-Building-Manager',
        'Accept': 'text/javascript, text/html, application/json, */*; q=0.01',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Nie mozna zmienic rekrutacji (HTTP ${response.status}).`);
    }

    if (action === 'automatic') {
      building.hiringAutomatic = true;
      building.hiringPhase = 0;
    } else {
      building.hiringAutomatic = false;
      building.hiringPhase = Number(action);
    }
  }

  function balanceClass(balance) {
    if (balance < 0) return 'or-bm-balance-negative';
    if (balance > 0) return 'or-bm-balance-positive';
    return 'or-bm-balance-zero';
  }

  function crewNeedClass(building) {
    if (building.personnelCurrent > building.vehicleCrewTarget) return 'or-bm-crew-surplus';
    if (building.personnelCurrent === building.vehicleCrewTarget) return 'or-bm-crew-ok';
    return 'or-bm-crew-shortage';
  }

  function signedNumber(value) {
    const n = numberValue(value, 0);
    return n > 0 ? `+${n}` : String(n);
  }

  function getTypeName(raw, catalog, typeId) {
    const entry = getCatalogEntry(catalog, typeId);
    if (typeof entry === 'string') return entry;

    return String(
      valueOf(entry, ['caption', 'name', 'label'], null) ??
      valueOf(raw, ['building_type_caption', 'type_caption'], null) ??
      `Typ ${typeId || '?'}`
    );
  }

  function boolValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLocaleLowerCase('pl');
    if (['1', 'true', 'yes', 'tak'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'nie'].includes(normalized)) return false;
    return fallback;
  }

  function getCatalogExtension(catalog, buildingTypeId, extensionTypeId) {
    const buildingType = getCatalogEntry(catalog, buildingTypeId);
    const extensions = buildingType?.extensions;
    if (!extensions) return null;
    return extensions?.[extensionTypeId] ?? extensions?.[Number(extensionTypeId)] ?? null;
  }

  function normalizeExtensions(rawBuilding, catalog, buildingTypeId) {
    const rawExtensions = valueOf(rawBuilding, ['extensions'], []);
    const list = Array.isArray(rawExtensions)
      ? rawExtensions
      : rawExtensions && typeof rawExtensions === 'object'
        ? Object.values(rawExtensions)
        : [];

    return list.map((extension, index) => {
      const typeId = String(valueOf(extension, ['type_id', 'typeId', 'id'], index));
      const catalogExtension = getCatalogExtension(catalog, buildingTypeId, typeId);
      const caption = String(
        valueOf(extension, ['caption', 'name', 'label'], null) ??
        valueOf(catalogExtension, ['caption', 'name', 'label'], null) ??
        `Specjalizacja ${typeId}`
      );

      const available = boolValue(valueOf(extension, ['available'], true), true);
      const enabled = boolValue(valueOf(extension, ['enabled'], true), true);

      return { typeId, caption, available, enabled };
    }).filter(extension => extension.caption);
  }

  function extensionStatus(extension) {
    if (!extension.available) return 'unavailable';
    return extension.enabled ? 'active' : 'disabled';
  }

  function renderExtensionBadges(extensions, status) {
    const list = extensions.filter(extension => extensionStatus(extension) === status);
    if (!list.length) return '<span class="or-bm-muted">—</span>';

    const cls = status === 'active'
      ? 'or-bm-badge-active'
      : status === 'disabled'
        ? 'or-bm-badge-disabled'
        : 'or-bm-badge-unavailable';

    return list
      .map(extension => `<span class="or-bm-badge ${cls}">${esc(extension.caption)}</span>`)
      .join(' ');
  }

  function normalizeData(rawBuildings, catalog, rawVehicles, vehicleCatalog) {
    const vehicles = (rawVehicles || []).map(vehicle => ({
      ...vehicle,
      id: String(valueOf(vehicle, ['id'], '')),
      buildingId: String(valueOf(vehicle, ['building_id', 'buildingId'], '')),
      typeId: String(valueOf(vehicle, ['vehicle_type', 'type'], '')),
      maxCrew: getVehicleMaxCrew(vehicle, vehicleCatalog),
    })).filter(vehicle => vehicle.id);

    const vehiclesByBuilding = new Map();
    for (const vehicle of vehicles) {
      if (!vehicle.buildingId) continue;
      if (!vehiclesByBuilding.has(vehicle.buildingId)) vehiclesByBuilding.set(vehicle.buildingId, []);
      vehiclesByBuilding.get(vehicle.buildingId).push(vehicle);
    }

    const buildings = rawBuildings.map(b => {
      const id = String(valueOf(b, ['id'], ''));
      const typeId = String(valueOf(b, ['building_type', 'building_type_id', 'type'], ''));
      const name = String(valueOf(b, ['caption', 'name'], `Budynek ${id}`));
      const typeName = getTypeName(b, catalog, typeId);
      const latitude = valueOf(b, ['latitude', 'lat'], null);
      const longitude = valueOf(b, ['longitude', 'lng', 'lon'], null);
      const extensions = normalizeExtensions(b, catalog, typeId);
      const buildingVehicles = vehiclesByBuilding.get(id) || [];
      const vehicleCrewTarget = buildingVehicles.reduce((sum, vehicle) => sum + vehicle.maxCrew, 0);
      const personnelCurrent = Math.max(0, numberValue(valueOf(b, ['personal_count'], 0), 0));
      const personnelTarget = Math.max(0, numberValue(valueOf(b, ['personal_count_target'], 0), 0));

      return {
        id,
        name,
        typeId,
        typeName,
        latitude,
        longitude,
        extensions,
        level: Math.max(0, numberValue(valueOf(b, ['level'], 0), 0)),
        smallBuilding: boolValue(valueOf(b, ['small_building'], false), false),
        vehicleCount: buildingVehicles.length,
        maxVehicles: getParkingCapacity(b, catalog),
        vehicleCrewTarget,
        personnelCurrent,
        personnelTarget,
        personnelBalance: personnelCurrent - vehicleCrewTarget,
        hiringPhase: Math.max(0, numberValue(valueOf(b, ['hiring_phase'], 0), 0)),
        hiringAutomatic: boolValue(valueOf(b, ['hiring_automatic'], false), false),
      };
    }).filter(b => b.id);

    buildings.sort((a, b) =>
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true }) ||
      a.name.localeCompare(b.name, 'pl', { numeric: true }) ||
      Number(a.id) - Number(b.id)
    );

    state.buildings = buildings;
    state.buildingTypes = catalog || {};
    state.vehicles = vehicles;
    state.vehicleTypes = vehicleCatalog || {};

    for (const b of buildings) {
      if (!state.draftNames.has(b.id)) state.draftNames.set(b.id, b.name);
    }
  }

  async function loadData(force = false) {
    if (state.loading) return;
    state.loading = true;
    setStatus('Pobieram budynki...', 'info');
    setBusy(true);

    try {
      if (force) {
        state.selected.clear();
        state.draftNames.clear();
      }

      const [buildings, catalog, vehicles, vehicleCatalog] = await Promise.all([
        fetchBuildings(),
        fetchBuildingCatalog(),
        fetchVehicles(),
        fetchVehicleCatalog(),
      ]);

      normalizeData(buildings, catalog, vehicles, vehicleCatalog);
      state.page = 1;
      state.specializationPage = 1;
      state.staffingPage = 1;
      rebuildFilterOptions();
      renderCurrentTab();
      setStatus(`Wczytano ${state.buildings.length} budynkow i ${state.vehicles.length} pojazdow.`, 'ok');
    } catch (error) {
      console.error('[OR Building Manager] Blad ladowania:', error);
      setStatus(`Blad ladowania: ${error.message}`, 'error');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function filteredBuildings() {
    const q = state.query.trim().toLocaleLowerCase('pl');

    return state.buildings.filter(b => {
      if (state.typeId && b.typeId !== state.typeId) return false;

      if (q) {
        const extensionText = b.extensions.map(extension => extension.caption).join(' ');
        const hay = `${b.name} ${b.typeName} ${b.id} ${extensionText}`.toLocaleLowerCase('pl');
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }

  function rebuildFilterOptions() {
    const typeSelect = document.getElementById(`${APP_ID}-type-filter`);
    const specializationSelect = document.getElementById(`${APP_ID}-specialization-filter`);

    const usedTypes = new Map();
    const usedSpecializations = new Set();

    for (const b of state.buildings) {
      usedTypes.set(b.typeId, b.typeName);
      b.extensions.forEach(extension => usedSpecializations.add(extension.caption));
    }

    if (typeSelect) {
      const typeOptions = [...usedTypes.entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }))
        .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
        .join('');

      typeSelect.innerHTML = `<option value="">Wszystkie typy budynkow</option>${typeOptions}`;
      typeSelect.value = state.typeId;
    }

    if (specializationSelect) {
      const specializationOptions = [...usedSpecializations]
        .sort((a, b) => a.localeCompare(b, 'pl', { numeric: true }))
        .map(name => `<option value="${esc(name)}">${esc(name)}</option>`)
        .join('');

      specializationSelect.innerHTML = `<option value="">Wszystkie specjalizacje</option>${specializationOptions}`;
      specializationSelect.value = state.specializationFilter;
    }
  }

  function filteredSpecializationBuildings() {
    return filteredBuildings().filter(building => {
      const count = building.extensions.length;

      if (state.specializationPresence === 'with' && count === 0) return false;
      if (state.specializationPresence === 'without' && count !== 0) return false;

      if (
        state.specializationFilter &&
        !building.extensions.some(extension => extension.caption === state.specializationFilter)
      ) return false;

      return true;
    });
  }

  function renderCurrentTab() {
    if (state.activeTab === 'specializations') renderSpecializationsTable();
    else if (state.activeTab === 'staffing') renderStaffingTable();
    else renderTable();
  }

  function renderTable() {
    const tbody = document.getElementById(`${APP_ID}-tbody`);
    const summary = document.getElementById(`${APP_ID}-summary`);
    const pager = document.getElementById(`${APP_ID}-pager`);
    if (!tbody || !summary || !pager) return;

    const filtered = filteredBuildings();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, pages));

    const start = (state.page - 1) * PAGE_SIZE;
    const current = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = current.map(b => {
      const selected = state.selected.has(b.id);
      const draft = state.draftNames.get(b.id) ?? b.name;
      const changed = draft !== b.name;

      return `
        <tr data-id="${esc(b.id)}" class="${changed ? 'or-bm-changed' : ''}">
          <td class="or-bm-center"><input type="checkbox" class="or-bm-row-check" data-id="${esc(b.id)}" ${selected ? 'checked' : ''}></td>
          <td class="or-bm-id"><a href="/buildings/${esc(b.id)}" target="_blank" rel="noopener">${esc(b.id)}</a></td>
          <td>${esc(b.typeName)}</td>
          <td>${esc(b.name)}</td>
          <td><input type="text" class="or-bm-draft-name" data-id="${esc(b.id)}" value="${esc(draft)}"></td>
        </tr>`;
    }).join('') || `<tr><td colspan="5" class="or-bm-empty">Brak budynkow dla wybranych filtrow.</td></tr>`;

    updateSummaryOnly();

    pager.innerHTML = `
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-prev" ${state.page <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Strona ${state.page} z ${pages}</span>
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-next" ${state.page >= pages ? 'disabled' : ''}>Nastepna ›</button>`;

    document.getElementById(`${APP_ID}-prev`)?.addEventListener('click', () => {
      state.page--;
      renderTable();
    });

    document.getElementById(`${APP_ID}-next`)?.addEventListener('click', () => {
      state.page++;
      renderTable();
    });

    tbody.querySelectorAll('.or-bm-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.id);
        else state.selected.delete(cb.dataset.id);
        updateSummaryOnly();
      });
    });

    tbody.querySelectorAll('.or-bm-draft-name').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        state.draftNames.set(id, input.value);
        const building = state.buildings.find(b => b.id === id);
        input.closest('tr')?.classList.toggle('or-bm-changed', !!building && input.value !== building.name);
        updateSummaryOnly();
      });
    });
  }

  function renderSpecializationsTable() {
    const tbody = document.getElementById(`${APP_ID}-specialization-tbody`);
    const summary = document.getElementById(`${APP_ID}-specialization-summary`);
    const pager = document.getElementById(`${APP_ID}-specialization-pager`);
    if (!tbody || !summary || !pager) return;

    const filtered = filteredSpecializationBuildings();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.specializationPage = Math.max(1, Math.min(state.specializationPage, pages));

    const start = (state.specializationPage - 1) * PAGE_SIZE;
    const current = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = current.map(building => {
      const activeCount = building.extensions.filter(e => extensionStatus(e) === 'active').length;
      const disabledCount = building.extensions.filter(e => extensionStatus(e) === 'disabled').length;
      const unavailableCount = building.extensions.filter(e => extensionStatus(e) === 'unavailable').length;

      return `
        <tr data-id="${esc(building.id)}">
          <td class="or-bm-id"><a href="/buildings/${esc(building.id)}" target="_blank" rel="noopener">${esc(building.id)}</a></td>
          <td>${esc(building.typeName)}</td>
          <td><a href="/buildings/${esc(building.id)}" target="_blank" rel="noopener"><b>${esc(building.name)}</b></a></td>
          <td class="or-bm-specializations-cell">${renderExtensionBadges(building.extensions, 'active')}</td>
          <td class="or-bm-specializations-cell">${renderExtensionBadges(building.extensions, 'disabled')}</td>
          <td class="or-bm-specializations-cell">${renderExtensionBadges(building.extensions, 'unavailable')}</td>
          <td class="or-bm-center"><b>${building.extensions.length}</b><div class="or-bm-muted or-bm-count-detail">${activeCount}/${disabledCount}/${unavailableCount}</div></td>
        </tr>`;
    }).join('') || `<tr><td colspan="7" class="or-bm-empty">Brak budynkow dla wybranych filtrow.</td></tr>`;

    const totalExtensions = filtered.reduce((sum, b) => sum + b.extensions.length, 0);
    const active = filtered.reduce((sum, b) => sum + b.extensions.filter(e => extensionStatus(e) === 'active').length, 0);
    const disabled = filtered.reduce((sum, b) => sum + b.extensions.filter(e => extensionStatus(e) === 'disabled').length, 0);
    const unavailable = filtered.reduce((sum, b) => sum + b.extensions.filter(e => extensionStatus(e) === 'unavailable').length, 0);

    summary.textContent =
      `Budynki: ${filtered.length} / ${state.buildings.length} | ` +
      `Specjalizacje: ${totalExtensions} | Aktywne: ${active} | Wylaczone: ${disabled} | W budowie/niedostepne: ${unavailable}`;

    pager.innerHTML = `
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-spec-prev" ${state.specializationPage <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Strona ${state.specializationPage} z ${pages}</span>
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-spec-next" ${state.specializationPage >= pages ? 'disabled' : ''}>Nastepna ›</button>`;

    document.getElementById(`${APP_ID}-spec-prev`)?.addEventListener('click', () => {
      state.specializationPage--;
      renderSpecializationsTable();
    });

    document.getElementById(`${APP_ID}-spec-next`)?.addEventListener('click', () => {
      state.specializationPage++;
      renderSpecializationsTable();
    });
  }

  function filteredStaffingBuildings() {
    return filteredBuildings().filter(building => {
      if (state.staffingFilter === 'shortage') {
        return building.personnelCurrent < building.vehicleCrewTarget;
      }

      if (state.staffingFilter === 'surplus') {
        return building.personnelCurrent > building.vehicleCrewTarget;
      }

      return true;
    });
  }

  function renderStaffingTable() {
    const tbody = document.getElementById(`${APP_ID}-staffing-tbody`);
    const summary = document.getElementById(`${APP_ID}-staffing-summary`);
    const pager = document.getElementById(`${APP_ID}-staffing-pager`);
    const panel = document.getElementById(`${APP_ID}-staffing-panel`);
    if (!tbody || !summary || !pager || !panel) return;

    panel.classList.toggle('or-bm-hide-staffing-type', !state.settings.showStaffingBuildingType);

    const filtered = filteredStaffingBuildings();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.staffingPage = Math.max(1, Math.min(state.staffingPage, pages));

    const start = (state.staffingPage - 1) * PAGE_SIZE;
    const current = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = current.map(building => {
      const capacityText = building.maxVehicles === null ? '—' : building.maxVehicles;
      const capacityClass =
        building.maxVehicles === null
          ? ''
          : building.vehicleCount > building.maxVehicles
            ? 'or-bm-balance-negative'
            : building.vehicleCount < building.maxVehicles
              ? 'or-bm-balance-positive'
              : '';

      return `
        <tr data-id="${esc(building.id)}">
          <td class="or-bm-id"><a href="/buildings/${esc(building.id)}" target="_blank" rel="noopener">${esc(building.id)}</a></td>
          <td class="or-bm-staffing-type">${esc(building.typeName)}</td>
          <td><a href="/buildings/${esc(building.id)}" target="_blank" rel="noopener"><b>${esc(building.name)}</b></a></td>
          <td class="or-bm-center">${building.level}</td>
          <td class="or-bm-center"><b>${building.vehicleCount}</b></td>
          <td class="or-bm-center ${capacityClass}"><b>${capacityText}</b></td>
          <td class="or-bm-center"><b>${building.personnelCurrent}</b></td>
          <td class="or-bm-center or-bm-inline-edit">
            <input type="number" min="0" step="1" class="or-bm-personnel-target" data-id="${esc(building.id)}" value="${building.personnelTarget}" aria-label="Pracownicy docelowo: ${esc(building.name)}">
            <button type="button" class="or-bm-btn or-bm-btn-small or-bm-personnel-save" data-id="${esc(building.id)}" title="Zapisz docelowa liczbe pracownikow">💾</button>
          </td>
          <td class="or-bm-center ${crewNeedClass(building)}"><b>${building.vehicleCrewTarget}</b></td>
          <td class="or-bm-center ${balanceClass(building.personnelBalance)}"><b>${signedNumber(building.personnelBalance)}</b></td>
          <td class="or-bm-center">
            <select class="or-bm-hiring-select" data-id="${esc(building.id)}" aria-label="Rekrutacja: ${esc(building.name)}">
              ${recruitmentOptions(building)}
            </select>
          </td>
        </tr>`;
    }).join('') || `<tr><td colspan="${state.settings.showStaffingBuildingType ? 11 : 10}" class="or-bm-empty">Brak budynkow dla wybranych filtrow.</td></tr>`;

    tbody.querySelectorAll('.or-bm-personnel-save').forEach(button => {
      button.addEventListener('click', async () => {
        const id = button.dataset.id;
        const building = state.buildings.find(item => item.id === id);
        const input = tbody.querySelector(`.or-bm-personnel-target[data-id="${CSS.escape(id)}"]`);
        if (!building || !input) return;

        const nextValue = Math.max(0, Math.trunc(numberValue(input.value, building.personnelTarget)));
        input.value = String(nextValue);
        button.disabled = true;
        input.disabled = true;
        setStatus(`Zapisuje docelowa liczbe pracownikow dla: ${building.name}...`, 'info');

        try {
          await savePersonnelTarget(building, nextValue);
          setStatus(`Zapisano: ${building.name} — pracownicy docelowo: ${nextValue}.`, 'ok');
          button.classList.add('or-bm-save-ok');
          setTimeout(() => button.classList.remove('or-bm-save-ok'), 1200);
        } catch (error) {
          console.error('[OR Building Manager] Blad zapisu docelowej liczby pracownikow:', error);
          input.value = String(building.personnelTarget);
          setStatus(`Blad zapisu dla ${building.name}: ${error.message}`, 'error');
        } finally {
          button.disabled = false;
          input.disabled = false;
        }
      });
    });

    tbody.querySelectorAll('.or-bm-personnel-target').forEach(input => {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          tbody.querySelector(`.or-bm-personnel-save[data-id="${CSS.escape(input.dataset.id)}"]`)?.click();
        }
      });
    });

    tbody.querySelectorAll('.or-bm-hiring-select').forEach(select => {
      select.addEventListener('change', async () => {
        const id = select.dataset.id;
        const building = state.buildings.find(item => item.id === id);
        if (!building) return;

        const previous = recruitmentValue(building);
        const nextValue = select.value;
        select.disabled = true;
        setStatus(`Zmieniam rekrutacje dla: ${building.name}...`, 'info');

        try {
          await saveRecruitment(building, nextValue);
          setStatus(`Zmieniono rekrutacje: ${building.name}.`, 'ok');
          renderStaffingTable();
        } catch (error) {
          console.error('[OR Building Manager] Blad zmiany rekrutacji:', error);
          select.value = previous;
          setStatus(`Blad rekrutacji dla ${building.name}: ${error.message}`, 'error');
          select.disabled = false;
        }
      });
    });

    const vehicleCount = filtered.reduce((sum, b) => sum + b.vehicleCount, 0);
    const personnelCurrent = filtered.reduce((sum, b) => sum + b.personnelCurrent, 0);
    const crewTarget = filtered.reduce((sum, b) => sum + b.vehicleCrewTarget, 0);
    const balance = personnelCurrent - crewTarget;
    const hiring = filtered.filter(b => b.hiringPhase > 0 || b.hiringAutomatic).length;

    const staffingFilterLabel = state.staffingFilter === 'shortage'
      ? 'Brakuje zalogi'
      : state.staffingFilter === 'surplus'
        ? 'Za duzo zalogi'
        : 'Wszystkie';

    summary.innerHTML =
      `Filtr: <b>${staffingFilterLabel}</b> | ` +
      `Budynki: <b>${filtered.length}</b> / ${state.buildings.length} | ` +
      `Pojazdy: <b>${vehicleCount}</b> | ` +
      `Pracownicy: <b>${personnelCurrent}</b> | ` +
      `Potrzeba zalogi: <b>${crewTarget}</b> | ` +
      `Bilans: <b class="${balanceClass(balance)}">${signedNumber(balance)}</b> | ` +
      `Trwa rekrutacja: <b>${hiring}</b>`;

    pager.innerHTML = `
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-staff-prev" ${state.staffingPage <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Strona ${state.staffingPage} z ${pages}</span>
      <button type="button" class="or-bm-btn or-bm-btn-small" id="${APP_ID}-staff-next" ${state.staffingPage >= pages ? 'disabled' : ''}>Nastepna ›</button>`;

    document.getElementById(`${APP_ID}-staff-prev`)?.addEventListener('click', () => {
      state.staffingPage--;
      renderStaffingTable();
    });

    document.getElementById(`${APP_ID}-staff-next`)?.addEventListener('click', () => {
      state.staffingPage++;
      renderStaffingTable();
    });
  }

  function setActiveTab(tab) {
    state.activeTab = ['rename', 'specializations', 'staffing'].includes(tab) ? tab : 'rename';
    state.page = 1;
    state.specializationPage = 1;
    state.staffingPage = 1;

    const renameToolbar = document.getElementById(`${APP_ID}-rename-toolbar`);
    const renameHelp = document.getElementById(`${APP_ID}-rename-help`);
    const renamePanel = document.getElementById(`${APP_ID}-rename-panel`);
    const specializationToolbar = document.getElementById(`${APP_ID}-specialization-toolbar`);
    const specializationPanel = document.getElementById(`${APP_ID}-specialization-panel`);
    const staffingToolbar = document.getElementById(`${APP_ID}-staffing-toolbar`);
    const staffingPanel = document.getElementById(`${APP_ID}-staffing-panel`);

    const isRename = state.activeTab === 'rename';
    const isSpecializations = state.activeTab === 'specializations';
    const isStaffing = state.activeTab === 'staffing';

    if (renameToolbar) renameToolbar.style.display = isRename ? 'flex' : 'none';
    if (renameHelp) renameHelp.style.display = isRename ? 'block' : 'none';
    if (renamePanel) renamePanel.style.display = isRename ? 'flex' : 'none';
    if (specializationToolbar) specializationToolbar.style.display = isSpecializations ? 'flex' : 'none';
    if (specializationPanel) specializationPanel.style.display = isSpecializations ? 'flex' : 'none';
    if (staffingToolbar) staffingToolbar.style.display = isStaffing ? 'flex' : 'none';
    if (staffingPanel) staffingPanel.style.display = isStaffing ? 'flex' : 'none';

    document.querySelectorAll(`#${APP_ID}-modal .or-bm-tab`).forEach(button => {
      button.classList.toggle('or-bm-tab-active', button.dataset.tab === state.activeTab);
    });

    renderCurrentTab();
  }

  function updateSummaryOnly() {
    const summary = document.getElementById(`${APP_ID}-summary`);
    if (!summary) return;

    const filtered = filteredBuildings();
    const changedCount = state.buildings.reduce(
      (n, b) => n + ((state.draftNames.get(b.id) ?? b.name) !== b.name ? 1 : 0),
      0
    );

    summary.textContent =
      `Widoczne: ${filtered.length} / ${state.buildings.length} | ` +
      `Zaznaczone: ${state.selected.size} | ` +
      `Przygotowane zmiany: ${changedCount}`;
  }

  function selectedBuildings() {
    return state.buildings.filter(b => state.selected.has(b.id));
  }

  function formatCounter(pattern, n) {
    return pattern.replace(/\{n(?::(\d+))?\}/g, (_, width) => {
      const w = width ? Number(width) : 0;
      return w > 0 ? String(n).padStart(w, '0') : String(n);
    });
  }

  function textFragment(text, selector) {
    const full = String(text ?? '').trim();
    if (!selector) return full;

    const s = String(selector).trim().toLocaleLowerCase('pl');

    // Tekst miedzy pierwsza para []
    if (s === '[]') {
      const match = full.match(/\[([^\]]*)\]/);
      return match ? match[1].trim() : '';
    }

    // Tekst poza nawiasami [] - usuwa wszystkie fragmenty [....]
    // np. "[01]xxx" -> "xxx", "OSP [01] Kielce" -> "OSP Kielce"
    if (s === 'poza[]' || s === 'outside[]' || s === '![]') {
      return full
        .replace(/\s*\[[^\]]*\]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const parts = full.split(/\s+/).filter(Boolean);
    if (!parts.length) return '';

    if (s === 'first' || s === 'pierwszy') return parts[0];
    if (s === 'last' || s === 'ostatni') return parts[parts.length - 1];

    if (/^\d+$/.test(s)) {
      const index = Number(s) - 1;
      return index >= 0 && index < parts.length ? parts[index] : '';
    }

    const range = s.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Math.max(1, Number(range[1]));
      const to = Math.max(from, Number(range[2]));
      return parts.slice(from - 1, to).join(' ');
    }

    const fromToEnd = s.match(/^(\d+)-$/);
    if (fromToEnd) {
      const from = Math.max(1, Number(fromToEnd[1]));
      return parts.slice(from - 1).join(' ');
    }

    return full;
  }

  function formatOldName(pattern, oldName) {
    return pattern
      .replace(/\{stara(?::([^}]+))?\}/g, (_, selector) => textFragment(oldName, selector))
      .replace(/\{nazwa(?::([^}]+))?\}/g, (_, selector) => textFragment(oldName, selector));
  }

  function generateNames() {
    const selected = selectedBuildings();

    if (!selected.length) {
      alert('Najpierw zaznacz budynki, dla ktorych chcesz przygotowac nazwy.');
      return;
    }

    const patternInput = document.getElementById(`${APP_ID}-pattern`);
    const startInput = document.getElementById(`${APP_ID}-start-number`);
    const numberingInput = document.getElementById(`${APP_ID}-numbering`);

    const pattern = patternInput.value.trim() || '{stara}';
    const startNumber = Math.max(0, Number.parseInt(startInput.value, 10) || 1);
    const numbering = numberingInput.value;

    state.settings = { pattern, startNumber, numbering };
    saveSettings();

    const counters = new Map();
    let globalCounter = startNumber;

    for (const b of selected) {
      let n;

      if (numbering === 'global') {
        n = globalCounter++;
      } else {
        const key = b.typeId;
        const current = counters.has(key) ? counters.get(key) : startNumber;
        n = current;
        counters.set(key, current + 1);
      }

      const newName = formatOldName(formatCounter(pattern, n), b.name)
        .replaceAll('{typ}', b.typeName)
        .replaceAll('{id}', b.id)
        .replace(/\s+/g, ' ')
        .trim();

      state.draftNames.set(b.id, newName);
    }

    renderTable();
    setStatus(`Przygotowano nazwy dla ${selected.length} budynkow. Nic nie zostalo jeszcze zapisane w grze.`, 'ok');
  }

  function resetDraftsForSelected() {
    const selected = selectedBuildings();

    if (!selected.length) {
      alert('Najpierw zaznacz budynki.');
      return;
    }

    for (const b of selected) state.draftNames.set(b.id, b.name);
    renderTable();
    setStatus(`Cofnieto przygotowane zmiany dla ${selected.length} budynkow.`, 'info');
  }

  function buildRenamePlan() {
    return selectedBuildings()
      .map(b => ({
        ...b,
        newName: String(state.draftNames.get(b.id) ?? b.name).trim(),
      }))
      .filter(b => b.newName && b.newName !== b.name);
  }

  function openConfirmation(plan) {
    const box = document.getElementById(`${APP_ID}-confirm`);

    const list = plan.slice(0, 12).map(b =>
      `<div><b>${esc(b.name)}</b> → <b>${esc(b.newName)}</b> <span class="or-bm-muted">(${esc(b.typeName)})</span></div>`
    ).join('');

    box.innerHTML = `
      <div class="or-bm-confirm-card">
        <div class="or-bm-confirm-title">Potwierdz zmiane ${plan.length} nazw budynkow</div>
        <div class="or-bm-confirm-list">
          ${list}
          ${plan.length > 12 ? `<div class="or-bm-muted">...i jeszcze ${plan.length - 12} budynkow.</div>` : ''}
        </div>
        <div class="or-bm-confirm-actions">
          <button type="button" class="or-bm-btn" id="${APP_ID}-confirm-cancel">Anuluj</button>
          <button type="button" class="or-bm-btn or-bm-btn-danger" id="${APP_ID}-confirm-save">Zapisz nazwy w grze</button>
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

  function chooseBuildingForm(container, buildingId) {
    // W grze pole nazwy budynku ma id="building_name",
    // a formularz id="edit_building_ID".
    const captionInput =
      container.querySelector('#building_name') ||
      container.querySelector('input[name="building[name]"]') ||
      container.querySelector('input[name$="[name]"]') ||
      container.querySelector('input[name="building[caption]"]') ||
      container.querySelector('#building_caption') ||
      container.querySelector('input[name$="[caption]"]');

    const form =
      container.querySelector(`#edit_building_${CSS.escape(String(buildingId))}`) ||
      captionInput?.closest('form') ||
      container.querySelector('form');

    return { form: form || null, captionInput: captionInput || null };
  }

  async function renameBuilding(buildingId, newName) {
    const editUrl = `/buildings/${encodeURIComponent(buildingId)}/edit`;

    const editResponse = await fetch(editUrl, {
      credentials: 'same-origin',
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });

    if (!editResponse.ok) {
      throw new Error(`Nie mozna pobrac formularza budynku ${buildingId} (HTTP ${editResponse.status}).`);
    }

    const html = await editResponse.text();

    // Uzywamy elementu z biezacego dokumentu, tak jak FuxTools.
    // Wlasciwe selektory gry:
    //   #building_name
    //   #edit_building_ID
    const container = document.createElement('div');
    container.innerHTML = html;

    const { form, captionInput } = chooseBuildingForm(container, buildingId);

    if (!captionInput) {
      const inputs = [...container.querySelectorAll('input')]
        .map(el => `${el.id || '(bez id)'} / ${el.name || '(bez name)'}`)
        .slice(0, 25)
        .join(', ');
      throw new Error(
        `Nie znaleziono pola nazwy #building_name w budynku ${buildingId}. ` +
        `Znalezione pola: ${inputs || 'brak'}`
      );
    }

    if (!form) {
      throw new Error(`Nie znaleziono formularza #edit_building_${buildingId} w budynku ${buildingId}.`);
    }

    captionInput.value = newName;

    const actionRaw = form.getAttribute('action') || form.action;
    if (!actionRaw) {
      throw new Error(`Formularz budynku ${buildingId} nie ma adresu action.`);
    }

    const actionUrl = new URL(actionRaw, location.origin);
    const action = actionUrl.pathname + actionUrl.search;

    const formData = new FormData(form);

    // Ustawiamy wartosc jeszcze raz jawnie, aby miec pewnosc,
    // ze FormData zawiera nowa nazwe.
    if (captionInput.name) {
      formData.set(captionInput.name, newName);
    }

    const saveResponse = await fetch(action, {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Thirdparty-Script': 'OR-Building-Manager',
        'Accept': 'text/javascript, application/json, */*; q=0.01',
      },
      redirect: 'follow',
    });

    if (!saveResponse.ok) {
      throw new Error(`Nie mozna zapisac budynku ${buildingId} (HTTP ${saveResponse.status}).`);
    }

    // Weryfikacja przez prawidlowy endpoint API, jesli jest dostepny.
    try {
      const verify = await fetch(`/api/buildings/${encodeURIComponent(buildingId)}`, {
        credentials: 'same-origin',
      });

      if (verify.ok) {
        const data = await verify.json();
        const building = data?.result ?? data;
        const current = String(valueOf(building, ['caption', 'name'], ''));

        if (current && current !== newName) {
          throw new Error(
            `Zapis zakonczyl sie odpowiedzia HTTP ${saveResponse.status}, ` +
            `ale API nadal zwraca stara nazwe budynku ${buildingId}.`
          );
        }
      }
    } catch (verifyError) {
      // Brak endpointu lub chwilowy blad weryfikacji nie uniewaznia poprawnego POST-a.
      // Wyjatek z faktycznego porownania nazwy przepuszczamy wyzej tylko w konsoli,
      // a lista i tak zostanie odswiezona przy kolejnym wczytaniu.
      console.debug('[OR Building Manager] Weryfikacja API:', verifyError);
    }
  }

  async function renameWithRetry(item) {
    try {
      await renameBuilding(item.id, item.newName);
    } catch (firstError) {
      console.warn(`[OR Building Manager] Pierwsza proba dla ${item.id} nieudana, ponawiam.`, firstError);
      await sleep(900);
      await renameBuilding(item.id, item.newName);
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

        const original = state.buildings.find(b => b.id === item.id);
        if (original) {
          original.name = item.newName;
          state.draftNames.set(item.id, item.newName);
        }
      } catch (error) {
        console.error('[OR Building Manager] Blad zmiany nazwy:', item, error);
        failed.push({ item, error });
      }

      // Celowo sekwencyjnie, z przerwa pomiedzy zadaniami.
      if (!state.cancelSave && i < plan.length - 1) await sleep(300);
    }

    cancelButton.style.display = 'none';
    state.saving = false;
    setBusy(false);
    renderTable();

    if (state.cancelSave) {
      setStatus(
        `Przerwano zapis. Zmieniono ${done} z ${plan.length} nazw${failed.length ? `, bledy: ${failed.length}` : ''}.`,
        'warn'
      );
    } else if (failed.length) {
      setStatus(
        `Gotowe z bledami: zmieniono ${done}/${plan.length}. Nieudane: ${failed.length}. Szczegoly sa w konsoli przegladarki.`,
        'error'
      );
    } else {
      setStatus(`Gotowe. Zmieniono ${done} nazw budynkow.`, 'ok');
    }
  }

  function setBusy(busy) {
    const root = document.getElementById(`${APP_ID}-modal`);
    if (!root) return;
    root.classList.toggle('or-bm-busy', !!busy);
  }

  function setStatus(message, kind = 'info') {
    const el = document.getElementById(`${APP_ID}-status`);
    if (!el) return;
    el.className = `or-bm-status or-bm-status-${kind}`;
    el.textContent = message;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.id = `${APP_ID}-styles`;

    style.textContent = `
      #${APP_ID}-button {
        position: fixed; right: 132px; bottom: 18px; z-index: 99990;
        border: 0; border-radius: 999px; padding: 11px 16px;
        background: #546e7a; color: white; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.28); font: 600 13px/1.2 Arial,sans-serif;
      }
      #${APP_ID}-button:hover { filter: brightness(1.08); }
      #${APP_ID}-modal {
        display:none; position:fixed; inset:0; z-index:99991;
        background:rgba(0,0,0,.56); font:13px/1.35 Arial,sans-serif; color:#222;
      }
      #${APP_ID}-modal.or-bm-open { display:flex; align-items:center; justify-content:center; }
      .or-bm-window {
        width:min(1450px,96vw); height:min(900px,94vh); background:#fff;
        border-radius:10px; box-shadow:0 12px 45px rgba(0,0,0,.45);
        display:flex; flex-direction:column; overflow:hidden;
      }
      .or-bm-header {
        display:flex; align-items:center; gap:12px; padding:12px 16px;
        background:#37474f; color:#fff;
      }
      .or-bm-header h2 { margin:0; font-size:18px; flex:1; }
      .or-bm-close {
        border:0; background:transparent; color:#fff; font-size:26px;
        cursor:pointer; line-height:1;
      }
      .or-bm-tabs {
        display:flex; gap:0; padding:0 12px; background:#455a64;
        border-top:1px solid rgba(255,255,255,.12);
      }
      .or-bm-tab {
        border:0; border-bottom:3px solid transparent; padding:10px 14px;
        background:transparent; color:#e8eef1; cursor:pointer; font-weight:700;
      }
      .or-bm-tab:hover { background:rgba(255,255,255,.08); }
      .or-bm-tab.or-bm-tab-active {
        background:#fff; color:#263238; border-bottom-color:#263238;
      }
      .or-bm-badge {
        display:inline-block; margin:2px 3px 2px 0; padding:3px 6px;
        border-radius:999px; font-size:11px; line-height:1.25;
        border:1px solid transparent; white-space:nowrap;
      }
      .or-bm-badge-active { background:#e8f5e9; color:#1b5e20; border-color:#a5d6a7; }
      .or-bm-badge-disabled { background:#eceff1; color:#455a64; border-color:#cfd8dc; }
      .or-bm-badge-unavailable { background:#fff3e0; color:#e65100; border-color:#ffcc80; }
      .or-bm-specializations-cell { min-width:210px; max-width:420px; }
      .or-bm-count-detail { font-size:10px; margin-top:2px; }
      .or-bm-balance-negative { color:#b71c1c !important; background:#ffebee !important; }
      .or-bm-balance-positive { color:#1b5e20 !important; background:#e8f5e9 !important; }
      .or-bm-balance-zero { color:#455a64 !important; }
      .or-bm-crew-surplus { color:#0d47a1 !important; background:#e3f2fd !important; }
      .or-bm-crew-ok { color:#1b5e20 !important; background:#e8f5e9 !important; }
      .or-bm-crew-shortage { color:#7a5d00 !important; background:#fff8b8 !important; }
      .or-bm-staffing-note { font-size:12px; color:#546e7a; }
      .or-bm-hide-staffing-type .or-bm-staffing-type { display:none !important; }
      .or-bm-check-label { display:inline-flex; align-items:center; gap:5px; padding:5px 8px; background:#fff; border:1px solid #bbb; border-radius:4px; cursor:pointer; white-space:nowrap; }
      .or-bm-inline-edit { white-space:nowrap; min-width:145px; }
      .or-bm-personnel-target { width:78px; min-height:30px; box-sizing:border-box; border:1px solid #bbb; border-radius:4px; padding:4px 6px; text-align:center; }
      .or-bm-hiring-select { min-height:30px; border:1px solid #bbb; border-radius:4px; padding:4px 6px; background:#fff; color:#222; }
      .or-bm-save-ok { background:#e8f5e9 !important; border-color:#66bb6a !important; }
      .or-bm-toolbar {
        display:flex; flex-wrap:wrap; gap:8px; padding:10px 12px;
        border-bottom:1px solid #ddd; background:#f7f7f7; align-items:center;
      }
      .or-bm-toolbar input[type="text"],
      .or-bm-toolbar input[type="number"],
      .or-bm-toolbar select {
        min-height:32px; border:1px solid #bbb; border-radius:4px;
        padding:5px 8px; background:#fff; color:#222;
      }
      .or-bm-search { min-width:250px; flex:1 1 280px; }
      .or-bm-pattern { min-width:300px; flex:1 1 360px; }
      .or-bm-btn {
        display:inline-flex; align-items:center; justify-content:center; min-height:32px;
        border:1px solid #aaa; border-radius:4px; padding:5px 10px;
        background:#fff; color:#222; cursor:pointer; white-space:nowrap;
      }
      .or-bm-btn:hover:not(:disabled) { background:#eee; }
      .or-bm-btn:disabled { opacity:.45; cursor:not-allowed; }
      .or-bm-btn-primary { background:#455a64; color:white; border-color:#263238; }
      .or-bm-btn-primary:hover:not(:disabled) { background:#37474f; }
      .or-bm-btn-danger { background:#c62828; color:white; border-color:#8e0000; }
      .or-bm-btn-danger:hover:not(:disabled) { background:#a91f1f; }
      .or-bm-btn-warn { background:#ef6c00; color:white; border-color:#bd4e00; }
      .or-bm-btn-small { min-height:27px; padding:3px 8px; }
      .or-bm-help {
        padding:8px 12px; background:#fff8e1; border-bottom:1px solid #ead9a4; font-size:12px;
      }
      .or-bm-body { min-height:0; flex:1; display:flex; flex-direction:column; }
      .or-bm-table-wrap { overflow:auto; flex:1; }
      .or-bm-table { width:100%; border-collapse:collapse; table-layout:auto; }
      .or-bm-table th {
        position:sticky; top:0; z-index:2; background:#eceff1;
        border-bottom:1px solid #bbb; padding:7px; text-align:left; white-space:nowrap;
      }
      .or-bm-table td { border-bottom:1px solid #eee; padding:5px 7px; vertical-align:middle; }
      .or-bm-table tr:hover td { background:#f7fbff; }
      .or-bm-table tr.or-bm-changed td { background:#fffde7; }
      .or-bm-table input[type="text"] {
        width:100%; min-width:300px; box-sizing:border-box;
        border:1px solid #bbb; border-radius:3px; padding:5px 7px;
      }
      .or-bm-center { text-align:center; }
      .or-bm-id { white-space:nowrap; }
      .or-bm-empty { text-align:center; padding:30px !important; color:#777; }
      .or-bm-footer {
        display:flex; flex-wrap:wrap; gap:8px; align-items:center;
        padding:9px 12px; border-top:1px solid #ddd; background:#fafafa;
      }
      .or-bm-summary { flex:1; min-width:300px; font-weight:600; }
      .or-bm-pager { display:flex; gap:8px; align-items:center; }
      .or-bm-status { padding:7px 12px; border-top:1px solid #ddd; font-size:12px; }
      .or-bm-status-info { background:#e3f2fd; color:#0d47a1; }
      .or-bm-status-ok { background:#e8f5e9; color:#1b5e20; }
      .or-bm-status-warn { background:#fff3e0; color:#e65100; }
      .or-bm-status-error { background:#ffebee; color:#b71c1c; }
      .or-bm-muted { color:#777; }
      #${APP_ID}-confirm {
        display:none; position:absolute; inset:0; z-index:4; background:rgba(0,0,0,.45);
      }
      .or-bm-confirm-card {
        width:min(680px,90%); max-height:80%; overflow:auto; position:absolute;
        left:50%; top:50%; transform:translate(-50%,-50%); background:#fff;
        border-radius:8px; padding:16px; box-shadow:0 10px 35px rgba(0,0,0,.4);
      }
      .or-bm-confirm-title { font-size:18px; font-weight:700; margin-bottom:12px; }
      .or-bm-confirm-list { display:flex; flex-direction:column; gap:5px; margin-bottom:14px; }
      .or-bm-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
      #${APP_ID}-modal.or-bm-busy .or-bm-toolbar button:not(#${APP_ID}-cancel-save),
      #${APP_ID}-modal.or-bm-busy .or-bm-footer button { opacity:.55; }
      @media (max-width: 800px) {
        .or-bm-window { width:100vw; height:100vh; border-radius:0; }
        .or-bm-toolbar { align-items:stretch; }
        .or-bm-toolbar > * { flex:1 1 100%; }
        .or-bm-table { font-size:12px; }
      }
    `;

    document.head.appendChild(style);
  }

  function positionLauncherButton() {
    const button = document.getElementById(`${APP_ID}-button`);
    if (!button) return false;

    const fleetButton = document.getElementById(FLEET_MANAGER_BUTTON_ID);
    button.style.bottom = '18px';

    if (!fleetButton) {
      button.style.right = '132px';
      return false;
    }

    const rect = fleetButton.getBoundingClientRect();
    const rightEdgeDistance = Math.max(0, window.innerWidth - rect.left);
    const bottomDistance = Math.max(0, window.innerHeight - rect.bottom);

    button.style.right = `${Math.round(rightEdgeDistance + 10)}px`;
    button.style.bottom = `${Math.round(bottomDistance)}px`;
    return true;
  }

  function keepLauncherNextToFleetManager() {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (positionLauncherButton() || attempts >= 40) clearInterval(timer);
    }, 250);

    window.addEventListener('resize', positionLauncherButton);
  }

  function createUi() {
    injectStyles();

    const button = document.createElement('button');
    button.id = `${APP_ID}-button`;
    button.type = 'button';
    button.textContent = '🏢 Budynki OR';
    document.body.appendChild(button);
    keepLauncherNextToFleetManager();

    const modal = document.createElement('div');
    modal.id = `${APP_ID}-modal`;

    modal.innerHTML = `
      <div class="or-bm-window" role="dialog" aria-modal="true" aria-label="Menedzer budynkow Operator Ratunkowy">
        <div class="or-bm-header">
          <h2>🏢 Menedzer budynkow OR <span style="font-size:12px;color:#cfd8dc">v0.11.0</span></h2>
          <button type="button" class="or-bm-close" id="${APP_ID}-close" title="Zamknij">×</button>
        </div>

        <div class="or-bm-tabs">
          <button type="button" class="or-bm-tab or-bm-tab-active" data-tab="rename">✏️ Edycja nazw</button>
          <button type="button" class="or-bm-tab" data-tab="specializations">🧩 Specjalizacje</button>
          <button type="button" class="or-bm-tab" data-tab="staffing">👥 Obsada i pojazdy</button>
        </div>

        <div class="or-bm-toolbar">
          <input id="${APP_ID}-search" class="or-bm-search" type="text" placeholder="Szukaj: nazwa, typ, ID...">
          <select id="${APP_ID}-type-filter"><option value="">Wszystkie typy budynkow</option></select>
          <button type="button" class="or-bm-btn" id="${APP_ID}-reload">↻ Wczytaj ponownie</button>
        </div>

        <div class="or-bm-toolbar" id="${APP_ID}-rename-toolbar">
          <button type="button" class="or-bm-btn" id="${APP_ID}-select-page">Zaznacz strone</button>
          <button type="button" class="or-bm-btn" id="${APP_ID}-select-filtered">Zaznacz wszystkie filtrowane</button>
          <button type="button" class="or-bm-btn" id="${APP_ID}-clear-selection">Wyczysc zaznaczenie</button>

          <span style="width:1px;height:24px;background:#ccc"></span>

          <input id="${APP_ID}-pattern" class="or-bm-pattern" type="text" value="${esc(state.settings.pattern)}" title="Szablon nazwy">
          <input id="${APP_ID}-start-number" type="number" min="0" value="${esc(state.settings.startNumber)}" style="width:85px" title="Numer poczatkowy">

          <select id="${APP_ID}-numbering" title="Sposob numeracji">
            <option value="type" ${state.settings.numbering === 'type' ? 'selected' : ''}>Numeruj osobno dla typu</option>
            <option value="global" ${state.settings.numbering === 'global' ? 'selected' : ''}>Jedna numeracja globalna</option>
          </select>

          <button type="button" class="or-bm-btn or-bm-btn-primary" id="${APP_ID}-generate">Przygotuj nazwy</button>
          <button type="button" class="or-bm-btn" id="${APP_ID}-reset-drafts">Cofnij przygotowane</button>
          <button type="button" class="or-bm-btn or-bm-btn-danger" id="${APP_ID}-save">Zapisz zaznaczone</button>
          <button type="button" class="or-bm-btn or-bm-btn-warn" id="${APP_ID}-cancel-save" style="display:none">■ Przerwij zapis</button>
        </div>

        <div class="or-bm-help" id="${APP_ID}-rename-help">
          <b>Pola szablonu:</b>
          <b>{typ}</b> = typ budynku,
          <b>{id}</b> = ID,
          <b>{stara}</b> = obecna nazwa,
          <b>{n}</b> / <b>{n:02}</b> / <b>{n:03}</b> = kolejny numer.<br>

          Fragment obecnej nazwy:
          <b>{stara:1}</b> = pierwszy czlon,
          <b>{stara:2}</b> = drugi,
          <b>{stara:1-2}</b> = czlony 1-2,
          <b>{stara:2-}</b> = od drugiego do konca,
          <b>{stara:first}</b> / <b>{stara:last}</b> = pierwszy / ostatni,
          <b>{stara:[]}</b> = tekst miedzy pierwsza para nawiasow kwadratowych,
          <b>{stara:poza[]}</b> = cala nazwa bez fragmentow znajdujacych sie w <b>[]</b>.
          Zamiast <b>{stara:...}</b> mozesz tez uzyc <b>{nazwa:...}</b>.<br>

          Przyklad: dla budynku <code>OSP [Kamienna Gora] 01</code>
          szablon <code>{stara:[]} - {typ}</code> utworzy <code>Kamienna Gora - ...</code>.<br>
          Dla nazwy <code>[01]xxx</code> pole <code>{stara:poza[]}</code> zwroci <code>xxx</code>.<br>

          „Przygotuj nazwy” tworzy tylko podglad. Zapis nastapi dopiero po kliknieciu
          „Zapisz zaznaczone” i dodatkowym potwierdzeniu.
        </div>

        <div class="or-bm-body" id="${APP_ID}-rename-panel">
          <div class="or-bm-table-wrap">
            <table class="or-bm-table">
              <thead>
                <tr>
                  <th style="width:36px">✓</th>
                  <th>ID</th>
                  <th>Typ budynku</th>
                  <th>Obecna nazwa</th>
                  <th style="min-width:360px">Nowa nazwa</th>
                </tr>
              </thead>
              <tbody id="${APP_ID}-tbody">
                <tr><td colspan="5" class="or-bm-empty">Otworz menedzer, aby pobrac dane.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="or-bm-footer">
            <div class="or-bm-summary" id="${APP_ID}-summary">Nie wczytano danych.</div>
            <div class="or-bm-pager" id="${APP_ID}-pager"></div>
          </div>
        </div>

        <div class="or-bm-toolbar" id="${APP_ID}-specialization-toolbar" style="display:none">
          <select id="${APP_ID}-specialization-filter">
            <option value="">Wszystkie specjalizacje</option>
          </select>
          <select id="${APP_ID}-specialization-presence">
            <option value="all">Wszystkie budynki</option>
            <option value="with">Tylko z jakas specjalizacja</option>
            <option value="without">Tylko bez specjalizacji</option>
          </select>
          <span class="or-bm-muted">Aktywne / wylaczone / w budowie lub niedostepne sa pokazane osobno.</span>
        </div>

        <div class="or-bm-body" id="${APP_ID}-specialization-panel" style="display:none">
          <div class="or-bm-table-wrap">
            <table class="or-bm-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Typ budynku</th>
                  <th>Budynek</th>
                  <th>Aktywne specjalizacje</th>
                  <th>Wylaczone</th>
                  <th>W budowie / niedostepne</th>
                  <th>Razem</th>
                </tr>
              </thead>
              <tbody id="${APP_ID}-specialization-tbody">
                <tr><td colspan="7" class="or-bm-empty">Otworz menedzer, aby pobrac dane.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="or-bm-footer">
            <div class="or-bm-summary" id="${APP_ID}-specialization-summary">Nie wczytano danych.</div>
            <div class="or-bm-pager" id="${APP_ID}-specialization-pager"></div>
          </div>
        </div>

        <div class="or-bm-toolbar" id="${APP_ID}-staffing-toolbar" style="display:none">
          <select id="${APP_ID}-staffing-filter" title="Filtr bilansu zalogi">
            <option value="all">Wszystkie budynki</option>
            <option value="shortage">Brakuje zalogi</option>
            <option value="surplus">Za duzo zalogi</option>
          </select>
          <label class="or-bm-check-label" title="Pokaz lub ukryj kolumne Typ budynku">
            <input type="checkbox" id="${APP_ID}-staffing-show-type" ${state.settings.showStaffingBuildingType ? 'checked' : ''}>
            Typ budynku
          </label>
          <span class="or-bm-staffing-note">
            Docelowa = cel personelu. Potrzeba zalogi = suma maksymalnych zalog pojazdow.
            Bilans = obecny personel minus potrzeba zalogi.
          </span>
        </div>

        <div class="or-bm-body" id="${APP_ID}-staffing-panel" style="display:none">
          <div class="or-bm-table-wrap">
            <table class="or-bm-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th class="or-bm-staffing-type">Typ budynku</th>
                  <th>Budynek</th>
                  <th>Poziom</th>
                  <th>Ilosc pojazdow</th>
                  <th>Max pojazdow</th>
                  <th>Pracownicy<br>obecnie</th>
                  <th>Pracownicy<br>docelowo</th>
                  <th>Potrzeba zalogi</th>
                  <th>Bilans<br>+ / -</th>
                  <th>Rekrutacja</th>
                </tr>
              </thead>
              <tbody id="${APP_ID}-staffing-tbody">
                <tr><td colspan="11" class="or-bm-empty">Otworz menedzer, aby pobrac dane.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="or-bm-footer">
            <div class="or-bm-summary" id="${APP_ID}-staffing-summary">Nie wczytano danych.</div>
            <div class="or-bm-pager" id="${APP_ID}-staffing-pager"></div>
          </div>
        </div>

        <div id="${APP_ID}-status" class="or-bm-status or-bm-status-info">Gotowy.</div>
        <div id="${APP_ID}-confirm"></div>
      </div>`;

    document.body.appendChild(modal);

    modal.querySelectorAll('.or-bm-tab').forEach(tabButton => {
      tabButton.addEventListener('click', () => setActiveTab(tabButton.dataset.tab));
    });

    document.getElementById(`${APP_ID}-specialization-filter`).addEventListener('change', event => {
      state.specializationFilter = event.target.value;
      state.specializationPage = 1;
      renderSpecializationsTable();
    });

    document.getElementById(`${APP_ID}-specialization-presence`).addEventListener('change', event => {
      state.specializationPresence = event.target.value;
      state.specializationPage = 1;
      renderSpecializationsTable();
    });

    document.getElementById(`${APP_ID}-staffing-filter`).addEventListener('change', event => {
      state.staffingFilter = event.target.value;
      state.staffingPage = 1;
      renderStaffingTable();
    });

    document.getElementById(`${APP_ID}-staffing-show-type`).addEventListener('change', event => {
      state.settings.showStaffingBuildingType = !!event.target.checked;
      saveSettings();
      renderStaffingTable();
    });

    button.addEventListener('click', async () => {
      modal.classList.add('or-bm-open');
      if (!state.buildings.length && !state.loading) await loadData();
      else renderCurrentTab();
    });

    document.getElementById(`${APP_ID}-close`).addEventListener('click', () => {
      if (!state.saving) {
        modal.classList.remove('or-bm-open');
      } else {
        setStatus('Trwa zapis nazw. Najpierw go zakoncz albo kliknij „Przerwij zapis”.', 'warn');
      }
    });

    modal.addEventListener('click', event => {
      if (event.target === modal && !state.saving) modal.classList.remove('or-bm-open');
    });

    const search = document.getElementById(`${APP_ID}-search`);
    let searchTimer = null;

    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = search.value;
        state.page = 1;
        state.specializationPage = 1;
        state.staffingPage = 1;
        renderCurrentTab();
      }, 120);
    });

    document.getElementById(`${APP_ID}-type-filter`).addEventListener('change', event => {
      state.typeId = event.target.value;
      state.page = 1;
      state.specializationPage = 1;
      state.staffingPage = 1;
      renderCurrentTab();
    });

    document.getElementById(`${APP_ID}-reload`).addEventListener('click', () => loadData(true));

    document.getElementById(`${APP_ID}-select-page`).addEventListener('click', () => {
      const filtered = filteredBuildings();
      const start = (state.page - 1) * PAGE_SIZE;
      filtered.slice(start, start + PAGE_SIZE).forEach(b => state.selected.add(b.id));
      renderTable();
    });

    document.getElementById(`${APP_ID}-select-filtered`).addEventListener('click', () => {
      filteredBuildings().forEach(b => state.selected.add(b.id));
      renderTable();
    });

    document.getElementById(`${APP_ID}-clear-selection`).addEventListener('click', () => {
      state.selected.clear();
      renderTable();
    });

    document.getElementById(`${APP_ID}-generate`).addEventListener('click', generateNames);
    document.getElementById(`${APP_ID}-reset-drafts`).addEventListener('click', resetDraftsForSelected);

    document.getElementById(`${APP_ID}-save`).addEventListener('click', () => {
      if (!state.selected.size) {
        alert('Najpierw zaznacz budynki, ktore chcesz zapisac.');
        return;
      }

      const plan = buildRenamePlan();

      if (!plan.length) {
        alert('W zaznaczonych budynkach nie ma przygotowanych zmian nazw.');
        return;
      }

      openConfirmation(plan);
    });

    document.getElementById(`${APP_ID}-cancel-save`).addEventListener('click', () => {
      state.cancelSave = true;
      setStatus('Przerwanie zostalo zlecone. Biezacy zapis zostanie dokonczony i operacja sie zatrzyma.', 'warn');
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal.classList.contains('or-bm-open') && !state.saving) {
        modal.classList.remove('or-bm-open');
      }
    });
  }

  createUi();
  console.log('[OR Building Manager] Wersja 0.11.0 zaladowana. Przycisk „Budynki OR” jest ustawiany obok Menedzera pojazdow.');
})();
