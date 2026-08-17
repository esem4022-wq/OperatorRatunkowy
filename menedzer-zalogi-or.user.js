// ==UserScript==
// @name         Operator Ratunkowy - Menedżer załogi OR
// @namespace    operatorratunkowy.local.crewmanager
// @version      0.1.1
// @description  Osobny menedżer personelu i obsady pojazdów w OperatorRatunkowy.pl
// @author       ChatGPT + użytkownik
// @license      CC BY-NC-SA 4.0
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zalogi-or.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zalogi-or.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.1.1';
  const APP_ID = 'or-crew-manager-v01';
  const PAGE_SIZE = 200;
  const BUILDING_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/buildings';
  const VEHICLE_CATALOG_URL = 'https://api.lss-manager.de/pl_PL/vehicles';

  if (window.top !== window.self) return;
  if (!isMainPage()) return;
  if (document.getElementById(`${APP_ID}-button`)) return;

  const state = {
    buildings: [],
    vehicles: [],
    buildingTypes: {},
    vehicleTypes: {},
    loading: false,
    saving: false,
    activeTab: 'buildings',
    buildingPage: 1,
    vehiclePage: 1,
    query: '',
    buildingTypeId: '',
    buildingStatus: 'all',
    vehicleBuildingId: '',
    vehicleTypeId: '',
    vehicleStatus: 'all',
    selectedVehicles: new Set(),
    changedBuildings: new Map(),
  };

  function isMainPage() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    return path === '/';
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function normalizeResult(data) {
    const result = data?.result ?? data;
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object') return Object.values(result);
    return [];
  }

  function valueOf(obj, keys, fallback = null) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return fallback;
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

  function boolValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const n = String(value).trim().toLocaleLowerCase('pl');
    if (['1', 'true', 'yes', 'tak', 'on'].includes(n)) return true;
    if (['0', 'false', 'no', 'nie', 'off'].includes(n)) return false;
    return fallback;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.text();
  }

  async function fetchAllPages(firstUrl) {
    const items = [];
    let nextUrl = firstUrl;
    let safety = 0;
    while (nextUrl && safety < 250) {
      safety += 1;
      const data = await fetchJson(nextUrl);
      items.push(...normalizeResult(data));
      nextUrl = data?.paging?.next_page || null;
    }
    if (safety >= 250) throw new Error('Przerwano pobieranie: zbyt wiele stron API.');
    return items;
  }

  async function fetchBuildings() {
    try {
      return await fetchAllPages('/api/v2/buildings?limit=2000');
    } catch (error) {
      console.warn('[OR Crew Manager] /api/v2/buildings niedostępne, używam starszego API.', error);
      return normalizeResult(await fetchJson('/api/buildings'));
    }
  }

  async function fetchVehicles() {
    try {
      return await fetchAllPages('/api/v2/vehicles?limit=10000');
    } catch (error) {
      console.warn('[OR Crew Manager] /api/v2/vehicles niedostępne, używam starszego API.', error);
      return normalizeResult(await fetchJson('/api/vehicles'));
    }
  }

  async function fetchCatalog(url) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      console.warn('[OR Crew Manager] Katalog LSSM niedostępny.', error);
      return {};
    }
  }

  function getCatalogEntry(catalog, id) {
    if (!catalog) return null;
    return catalog?.[id] ?? catalog?.[Number(id)] ?? null;
  }

  function typeNameFromCatalog(catalog, id, raw, fallbackPrefix) {
    const entry = getCatalogEntry(catalog, id);
    if (typeof entry === 'string') return entry;
    return String(
      valueOf(entry, ['caption', 'name', 'label'], null) ??
      valueOf(raw, ['caption_type', 'type_caption', 'building_type_caption', 'vehicle_type_caption'], null) ??
      `${fallbackPrefix} ${id || '?'}`
    );
  }

  function getVehicleMaxCrew(rawVehicle, vehicleCatalog) {
    const override = optionalNumber(valueOf(rawVehicle, ['max_personnel_override'], null));
    if (override !== null) return Math.max(0, Math.round(override));

    const typeId = String(valueOf(rawVehicle, ['vehicle_type', 'vehicle_type_id', 'type'], ''));
    const entry = getCatalogEntry(vehicleCatalog, typeId);
    return Math.max(0, Math.round(numberValue(
      valueOf(entry, ['maxPersonnel', 'max_personnel'], null) ?? entry?.staff?.max,
      0
    )));
  }

  function getAssignedCrew(rawVehicle) {
    const direct = optionalNumber(valueOf(rawVehicle, [
      'assigned_personnel_count',
      'assigned_personal_count',
      'personnel_count',
      'personal_count',
    ], null));
    if (direct !== null) return Math.max(0, Math.round(direct));

    const list = valueOf(rawVehicle, ['assigned_personnel', 'assigned_personal', 'personnel', 'personal'], null);
    if (Array.isArray(list)) return list.length;
    return null;
  }

  function normalizeData(rawBuildings, rawVehicles, buildingCatalog, vehicleCatalog) {
    const rawBuildingMap = new Map();
    for (const b of rawBuildings) rawBuildingMap.set(String(valueOf(b, ['id'], '')), b);

    const buildingsBasic = rawBuildings.map(raw => {
      const id = String(valueOf(raw, ['id'], ''));
      const typeId = String(valueOf(raw, ['building_type', 'building_type_id', 'type'], ''));
      return {
        raw,
        id,
        typeId,
        name: String(valueOf(raw, ['caption', 'name'], `Jednostka ${id}`)),
        typeName: typeNameFromCatalog(buildingCatalog, typeId, raw, 'Typ'),
        personnelCurrent: Math.max(0, Math.round(numberValue(valueOf(raw, ['personal_count', 'personnel_count'], 0), 0))),
        personnelTarget: Math.max(0, Math.round(numberValue(valueOf(raw, ['personal_count_target', 'personnel_count_target'], 0), 0))),
        hiringPhase: Math.max(0, Math.round(numberValue(valueOf(raw, ['hiring_phase'], 0), 0))),
        hiringAutomatic: boolValue(valueOf(raw, ['hiring_automatic'], false), false),
      };
    }).filter(b => b.id);

    const buildingById = new Map(buildingsBasic.map(b => [b.id, b]));

    const vehicles = rawVehicles.map(raw => {
      const id = String(valueOf(raw, ['id'], ''));
      const buildingId = String(valueOf(raw, ['building_id', 'buildingId'], ''));
      const typeId = String(valueOf(raw, ['vehicle_type', 'vehicle_type_id', 'type'], ''));
      const maxCrew = getVehicleMaxCrew(raw, vehicleCatalog);
      const assignedCrew = getAssignedCrew(raw);
      const missingCrew = assignedCrew === null ? null : Math.max(0, maxCrew - assignedCrew);
      const unit = buildingById.get(buildingId);
      return {
        raw,
        id,
        buildingId,
        typeId,
        name: String(valueOf(raw, ['caption', 'name'], `Pojazd ${id}`)),
        typeName: typeNameFromCatalog(vehicleCatalog, typeId, raw, 'Typ pojazdu'),
        buildingName: unit?.name || `Jednostka ${buildingId || '?'}`,
        maxCrew,
        assignedCrew,
        missingCrew,
      };
    }).filter(v => v.id);

    const vehiclesByBuilding = new Map();
    for (const v of vehicles) {
      if (!vehiclesByBuilding.has(v.buildingId)) vehiclesByBuilding.set(v.buildingId, []);
      vehiclesByBuilding.get(v.buildingId).push(v);
    }

    const buildings = buildingsBasic.map(b => {
      const list = vehiclesByBuilding.get(b.id) || [];
      const vehicleCrewTarget = list.reduce((sum, v) => sum + v.maxCrew, 0);
      const knownAssignedCrew = list.filter(v => v.assignedCrew !== null).reduce((sum, v) => sum + v.assignedCrew, 0);
      const unknownAssignedVehicles = list.filter(v => v.assignedCrew === null).length;
      return {
        ...b,
        vehicleCount: list.length,
        vehicleCrewTarget,
        personnelBalance: b.personnelCurrent - vehicleCrewTarget,
        knownAssignedCrew,
        unknownAssignedVehicles,
      };
    });

    buildings.sort((a, b) =>
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true }) ||
      a.name.localeCompare(b.name, 'pl', { numeric: true }) ||
      Number(a.id) - Number(b.id)
    );
    vehicles.sort((a, b) =>
      a.buildingName.localeCompare(b.buildingName, 'pl', { numeric: true }) ||
      a.typeName.localeCompare(b.typeName, 'pl', { numeric: true }) ||
      a.name.localeCompare(b.name, 'pl', { numeric: true }) ||
      Number(a.id) - Number(b.id)
    );

    state.buildings = buildings;
    state.vehicles = vehicles;
    state.buildingTypes = buildingCatalog || {};
    state.vehicleTypes = vehicleCatalog || {};
  }

  function buildingCrewStatus(building) {
    if (building.personnelBalance < 0) return 'shortage';
    if (building.personnelBalance > 0) return 'surplus';
    return 'ok';
  }

  function vehicleCrewStatus(vehicle) {
    if (vehicle.assignedCrew === null) return 'unknown';
    if (vehicle.assignedCrew < vehicle.maxCrew) return 'shortage';
    if (vehicle.assignedCrew > vehicle.maxCrew) return 'surplus';
    return 'ok';
  }

  function statusLabel(status) {
    return ({
      shortage: 'Brakuje',
      ok: 'OK',
      surplus: 'Nadmiar',
      unknown: 'Brak danych',
    })[status] || status;
  }

  function signed(n) {
    n = numberValue(n, 0);
    return n > 0 ? `+${n}` : String(n);
  }

  function recruitmentText(b) {
    if (b.hiringPhase > 0) return `${b.hiringPhase} ${b.hiringPhase === 1 ? 'dzień' : 'dni'}${b.hiringAutomatic ? ' + auto' : ''}`;
    return b.hiringAutomatic ? 'Auto' : 'Wył.';
  }

  function filteredBuildings() {
    const q = state.query.trim().toLocaleLowerCase('pl');
    return state.buildings.filter(b => {
      if (state.buildingTypeId && b.typeId !== state.buildingTypeId) return false;
      if (state.buildingStatus === 'recruiting' && b.hiringPhase <= 0 && !b.hiringAutomatic) return false;
      if (['shortage', 'ok', 'surplus'].includes(state.buildingStatus) && buildingCrewStatus(b) !== state.buildingStatus) return false;
      if (q) {
        const hay = `${b.id} ${b.name} ${b.typeName}`.toLocaleLowerCase('pl');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function filteredVehicles() {
    const q = state.query.trim().toLocaleLowerCase('pl');
    return state.vehicles.filter(v => {
      if (state.vehicleBuildingId && v.buildingId !== state.vehicleBuildingId) return false;
      if (state.vehicleTypeId && v.typeId !== state.vehicleTypeId) return false;
      if (state.vehicleStatus !== 'all' && vehicleCrewStatus(v) !== state.vehicleStatus) return false;
      if (q) {
        const hay = `${v.id} ${v.name} ${v.typeName} ${v.buildingName}`.toLocaleLowerCase('pl');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById(`${APP_ID}-status`);
    if (!el) return;
    el.className = `or-cm-status or-cm-status-${type}`;
    el.textContent = text;
  }

  function setBusy(flag) {
    const modal = document.getElementById(`${APP_ID}-modal`);
    if (modal) modal.classList.toggle('or-cm-busy', !!flag);
  }

  function updateSummary() {
    const el = document.getElementById(`${APP_ID}-summary-cards`);
    if (!el) return;
    const units = state.buildings.length;
    const current = state.buildings.reduce((s, b) => s + b.personnelCurrent, 0);
    const need = state.buildings.reduce((s, b) => s + b.vehicleCrewTarget, 0);
    const balance = current - need;
    const shortageVehicles = state.vehicles.filter(v => vehicleCrewStatus(v) === 'shortage').length;
    const unknownVehicles = state.vehicles.filter(v => v.assignedCrew === null).length;

    el.innerHTML = `
      <div class="or-cm-card"><span>Jednostki</span><b>${units}</b></div>
      <div class="or-cm-card"><span>Personel</span><b>${current}</b></div>
      <div class="or-cm-card"><span>Potrzeba załogi</span><b>${need}</b></div>
      <div class="or-cm-card ${balance < 0 ? 'or-cm-card-bad' : balance > 0 ? 'or-cm-card-good' : ''}"><span>Bilans</span><b>${signed(balance)}</b></div>
      <div class="or-cm-card ${shortageVehicles ? 'or-cm-card-bad' : ''}"><span>Pojazdy z brakami</span><b>${shortageVehicles}</b></div>
      <div class="or-cm-card"><span>Brak danych o przydziale</span><b>${unknownVehicles}</b></div>`;
  }

  function rebuildFilterOptions() {
    const bType = document.getElementById(`${APP_ID}-building-type`);
    const vBuilding = document.getElementById(`${APP_ID}-vehicle-building`);
    const vType = document.getElementById(`${APP_ID}-vehicle-type`);
    if (bType) {
      const unique = [...new Map(state.buildings.map(b => [b.typeId, b.typeName])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }));
      bType.innerHTML = '<option value="">Wszystkie typy jednostek</option>' + unique.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      bType.value = state.buildingTypeId;
    }
    if (vBuilding) {
      vBuilding.innerHTML = '<option value="">Wszystkie jednostki</option>' + state.buildings.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
      vBuilding.value = state.vehicleBuildingId;
    }
    if (vType) {
      const unique = [...new Map(state.vehicles.map(v => [v.typeId, v.typeName])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'pl', { numeric: true }));
      vType.innerHTML = '<option value="">Wszystkie typy pojazdów</option>' + unique.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      vType.value = state.vehicleTypeId;
    }
  }

  function renderBuildings() {
    const tbody = document.getElementById(`${APP_ID}-building-body`);
    const pager = document.getElementById(`${APP_ID}-building-pager`);
    if (!tbody || !pager) return;
    const filtered = filteredBuildings();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.buildingPage = Math.max(1, Math.min(state.buildingPage, pages));
    const start = (state.buildingPage - 1) * PAGE_SIZE;
    const rows = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = rows.map(b => {
      const status = buildingCrewStatus(b);
      const draft = state.changedBuildings.get(b.id) || {
        target: b.personnelTarget,
        phase: b.hiringPhase,
        automatic: b.hiringAutomatic,
      };
      return `
        <tr data-id="${esc(b.id)}" class="or-cm-row-${status}">
          <td><a href="/buildings/${esc(b.id)}" target="_blank" rel="noopener">${esc(b.id)}</a></td>
          <td>${esc(b.typeName)}</td>
          <td><a href="/buildings/${esc(b.id)}" target="_blank" rel="noopener"><b>${esc(b.name)}</b></a></td>
          <td class="or-cm-center">${b.vehicleCount}</td>
          <td class="or-cm-center"><b>${b.personnelCurrent}</b></td>
          <td class="or-cm-center"><input class="or-cm-target" data-id="${esc(b.id)}" type="number" min="0" step="1" value="${esc(draft.target)}"></td>
          <td class="or-cm-center"><b>${b.vehicleCrewTarget}</b></td>
          <td class="or-cm-center or-cm-balance-${status}"><b>${signed(b.personnelBalance)}</b></td>
          <td class="or-cm-center">
            <select class="or-cm-phase" data-id="${esc(b.id)}">
              <option value="0" ${Number(draft.phase) === 0 ? 'selected' : ''}>Wyłączona</option>
              <option value="1" ${Number(draft.phase) === 1 ? 'selected' : ''}>1 dzień</option>
              <option value="2" ${Number(draft.phase) === 2 ? 'selected' : ''}>2 dni</option>
              <option value="3" ${Number(draft.phase) === 3 ? 'selected' : ''}>3 dni</option>
            </select>
            <label class="or-cm-inline-check"><input class="or-cm-auto" data-id="${esc(b.id)}" type="checkbox" ${draft.automatic ? 'checked' : ''}> auto</label>
          </td>
          <td class="or-cm-center"><span class="or-cm-pill or-cm-pill-${status}">${statusLabel(status)}</span></td>
          <td class="or-cm-actions">
            <button type="button" class="or-cm-btn or-cm-btn-small or-cm-save-unit" data-id="${esc(b.id)}">💾 Zapisz</button>
            <a class="or-cm-btn or-cm-btn-small" href="/buildings/${esc(b.id)}" target="_blank" rel="noopener">↗ Jednostka</a>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="11" class="or-cm-empty">Brak jednostek dla wybranych filtrów.</td></tr>';

    tbody.querySelectorAll('.or-cm-target,.or-cm-phase,.or-cm-auto').forEach(el => {
      el.addEventListener('change', () => rememberBuildingDraft(el.dataset.id));
      el.addEventListener('input', () => rememberBuildingDraft(el.dataset.id));
    });
    tbody.querySelectorAll('.or-cm-save-unit').forEach(btn => btn.addEventListener('click', () => saveBuildingStaffing(btn.dataset.id, btn)));

    pager.innerHTML = `
      <button class="or-cm-btn or-cm-btn-small" id="${APP_ID}-building-prev" ${state.buildingPage <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Jednostki: <b>${filtered.length}</b> • strona ${state.buildingPage}/${pages}</span>
      <button class="or-cm-btn or-cm-btn-small" id="${APP_ID}-building-next" ${state.buildingPage >= pages ? 'disabled' : ''}>Następna ›</button>`;
    document.getElementById(`${APP_ID}-building-prev`)?.addEventListener('click', () => { state.buildingPage--; renderBuildings(); });
    document.getElementById(`${APP_ID}-building-next`)?.addEventListener('click', () => { state.buildingPage++; renderBuildings(); });
  }

  function rememberBuildingDraft(id) {
    const row = document.querySelector(`#${APP_ID}-building-body tr[data-id="${CSS.escape(String(id))}"]`);
    if (!row) return;
    const target = Math.max(0, Math.round(numberValue(row.querySelector('.or-cm-target')?.value, 0)));
    const phase = Math.max(0, Math.min(3, Math.round(numberValue(row.querySelector('.or-cm-phase')?.value, 0))));
    const automatic = !!row.querySelector('.or-cm-auto')?.checked;
    state.changedBuildings.set(String(id), { target, phase, automatic });
  }

  function renderVehicles() {
    const tbody = document.getElementById(`${APP_ID}-vehicle-body`);
    const pager = document.getElementById(`${APP_ID}-vehicle-pager`);
    if (!tbody || !pager) return;
    const filtered = filteredVehicles();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.vehiclePage = Math.max(1, Math.min(state.vehiclePage, pages));
    const start = (state.vehiclePage - 1) * PAGE_SIZE;
    const rows = filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = rows.map(v => {
      const status = vehicleCrewStatus(v);
      const missing = v.missingCrew === null ? '—' : v.missingCrew;
      return `
        <tr data-id="${esc(v.id)}" class="or-cm-row-${status}">
          <td class="or-cm-center"><input type="checkbox" class="or-cm-vehicle-check" data-id="${esc(v.id)}" ${state.selectedVehicles.has(v.id) ? 'checked' : ''}></td>
          <td><a href="/vehicles/${esc(v.id)}" target="_blank" rel="noopener">${esc(v.id)}</a></td>
          <td>${esc(v.typeName)}</td>
          <td><b>${esc(v.name)}</b></td>
          <td>${esc(v.buildingName)}</td>
          <td class="or-cm-center"><b>${v.maxCrew}</b></td>
          <td class="or-cm-center"><b>${v.assignedCrew === null ? '—' : v.assignedCrew}</b></td>
          <td class="or-cm-center"><b>${missing}</b></td>
          <td class="or-cm-center"><span class="or-cm-pill or-cm-pill-${status}">${statusLabel(status)}</span></td>
          <td class="or-cm-actions">
            <button type="button" class="or-cm-btn or-cm-btn-small or-cm-fill-vehicle" data-id="${esc(v.id)}">👥 Do max</button>
            <button type="button" class="or-cm-btn or-cm-btn-small or-cm-open-assignment" data-id="${esc(v.id)}">↗ Przydział</button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="10" class="or-cm-empty">Brak pojazdów dla wybranych filtrów.</td></tr>';

    tbody.querySelectorAll('.or-cm-vehicle-check').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.selectedVehicles.add(cb.dataset.id);
      else state.selectedVehicles.delete(cb.dataset.id);
      updateVehicleSelectionInfo();
    }));
    tbody.querySelectorAll('.or-cm-fill-vehicle').forEach(btn => btn.addEventListener('click', () => fillVehicleToMax(btn.dataset.id, btn)));
    tbody.querySelectorAll('.or-cm-open-assignment').forEach(btn => btn.addEventListener('click', () => openVehicleAssignment(btn.dataset.id)));

    pager.innerHTML = `
      <button class="or-cm-btn or-cm-btn-small" id="${APP_ID}-vehicle-prev" ${state.vehiclePage <= 1 ? 'disabled' : ''}>‹ Poprzednia</button>
      <span>Pojazdy: <b>${filtered.length}</b> • strona ${state.vehiclePage}/${pages}</span>
      <button class="or-cm-btn or-cm-btn-small" id="${APP_ID}-vehicle-next" ${state.vehiclePage >= pages ? 'disabled' : ''}>Następna ›</button>`;
    document.getElementById(`${APP_ID}-vehicle-prev`)?.addEventListener('click', () => { state.vehiclePage--; renderVehicles(); });
    document.getElementById(`${APP_ID}-vehicle-next`)?.addEventListener('click', () => { state.vehiclePage++; renderVehicles(); });
    updateVehicleSelectionInfo();
  }

  function updateVehicleSelectionInfo() {
    const el = document.getElementById(`${APP_ID}-vehicle-selection`);
    if (el) el.textContent = `Zaznaczone: ${state.selectedVehicles.size}`;
  }

  async function loadData(force = false) {
    if (state.loading) return;
    state.loading = true;
    setBusy(true);
    setStatus('Pobieram jednostki, pojazdy i dane załogi…', 'info');
    try {
      if (force) {
        state.selectedVehicles.clear();
        state.changedBuildings.clear();
      }
      const [rawBuildings, rawVehicles, buildingCatalog, vehicleCatalog] = await Promise.all([
        fetchBuildings(),
        fetchVehicles(),
        fetchCatalog(BUILDING_CATALOG_URL),
        fetchCatalog(VEHICLE_CATALOG_URL),
      ]);
      normalizeData(rawBuildings, rawVehicles, buildingCatalog, vehicleCatalog);
      state.buildingPage = 1;
      state.vehiclePage = 1;
      rebuildFilterOptions();
      updateSummary();
      renderCurrentTab();
      setStatus(`Wczytano ${state.buildings.length} jednostek i ${state.vehicles.length} pojazdów.`, 'ok');
    } catch (error) {
      console.error('[OR Crew Manager] Błąd ładowania:', error);
      setStatus(`Błąd ładowania: ${error.message}`, 'error');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function renderCurrentTab() {
    const unitsPanel = document.getElementById(`${APP_ID}-units-panel`);
    const vehiclesPanel = document.getElementById(`${APP_ID}-vehicles-panel`);
    const unitsTools = document.getElementById(`${APP_ID}-units-tools`);
    const vehiclesTools = document.getElementById(`${APP_ID}-vehicles-tools`);
    const unitsTab = document.getElementById(`${APP_ID}-tab-units`);
    const vehiclesTab = document.getElementById(`${APP_ID}-tab-vehicles`);

    const isUnits = state.activeTab === 'buildings';
    if (unitsPanel) unitsPanel.style.display = isUnits ? 'flex' : 'none';
    if (vehiclesPanel) vehiclesPanel.style.display = isUnits ? 'none' : 'flex';
    if (unitsTools) unitsTools.style.display = isUnits ? 'flex' : 'none';
    if (vehiclesTools) vehiclesTools.style.display = isUnits ? 'none' : 'flex';
    unitsTab?.classList.toggle('active', isUnits);
    vehiclesTab?.classList.toggle('active', !isUnits);

    if (isUnits) renderBuildings(); else renderVehicles();
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function findStaffingForm(doc) {
    const forms = [...doc.querySelectorAll('form')];
    let best = null;
    let bestScore = -1;
    for (const form of forms) {
      const controls = [...form.querySelectorAll('input[name],select[name]')];
      let score = 0;
      for (const el of controls) {
        const name = (el.name || '').toLocaleLowerCase('pl');
        const id = (el.id || '').toLocaleLowerCase('pl');
        const text = `${name} ${id}`;
        if (/personal_count_target|personnel_count_target/.test(text)) score += 10;
        if (/hiring_phase/.test(text)) score += 6;
        if (/hiring_automatic/.test(text)) score += 6;
        if (/rekrut|hiring|personal|personnel/.test(text)) score += 1;
      }
      if (score > bestScore) { best = form; bestScore = score; }
    }
    return bestScore > 0 ? { form: best, score: bestScore } : null;
  }

  function findControl(form, patterns, type = null) {
    for (const el of form.querySelectorAll('input[name],select[name]')) {
      if (type && el.type !== type) continue;
      const text = `${el.name || ''} ${el.id || ''}`.toLocaleLowerCase('pl');
      if (patterns.some(re => re.test(text))) return el;
    }
    return null;
  }

  async function findNativeBuildingStaffingPage(buildingId) {
    const checked = new Set();
    const queue = [`/buildings/${encodeURIComponent(buildingId)}/edit`, `/buildings/${encodeURIComponent(buildingId)}`];

    while (queue.length && checked.size < 8) {
      const url = queue.shift();
      if (!url || checked.has(url)) continue;
      checked.add(url);
      let html;
      try { html = await fetchText(url); } catch (_) { continue; }
      const doc = parseHtml(html);
      const found = findStaffingForm(doc);
      if (found) return { url, doc, form: found.form };

      if (checked.size <= 2) {
        for (const a of doc.querySelectorAll('a[href]')) {
          let href;
          try { href = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
          if (href.origin !== location.origin) continue;
          const text = `${a.textContent || ''} ${href.pathname}`.toLocaleLowerCase('pl');
          if (!/rekrut|hiring|personal|personnel|personel|pracown|zalog|załog/.test(text)) continue;
          if (!href.pathname.includes(String(buildingId))) continue;
          const path = href.pathname + href.search;
          if (!checked.has(path) && !queue.includes(path)) queue.push(path);
        }
      }
    }
    return null;
  }

  async function submitNativeForm(pageUrl, form, mutateFn) {
    mutateFn(form);
    const actionRaw = form.getAttribute('action') || pageUrl;
    const actionUrl = new URL(actionRaw, location.origin);
    const action = actionUrl.pathname + actionUrl.search;
    const method = (form.getAttribute('method') || 'post').toUpperCase();
    const data = new FormData(form);
    const response = await fetch(action, {
      method: method === 'GET' ? 'POST' : method,
      body: data,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Thirdparty-Script': 'OR-Crew-Manager',
        Accept: 'text/html,application/json,text/javascript,*/*;q=0.01',
      },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Zapis nieudany (HTTP ${response.status}).`);
  }

  async function saveBuildingStaffing(buildingId, button) {
    if (state.saving) return;
    const b = state.buildings.find(x => x.id === String(buildingId));
    if (!b) return;
    rememberBuildingDraft(buildingId);
    const draft = state.changedBuildings.get(String(buildingId)) || { target: b.personnelTarget, phase: b.hiringPhase, automatic: b.hiringAutomatic };

    state.saving = true;
    setBusy(true);
    const old = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '…'; }
    setStatus(`Szukam natywnego formularza personelu: ${b.name}…`, 'info');
    try {
      const native = await findNativeBuildingStaffingPage(buildingId);
      if (!native) throw new Error('Nie znaleziono natywnego formularza celu personelu/rekrutacji tej jednostki.');

      const targetInput = findControl(native.form, [/personal_count_target/, /personnel_count_target/]);
      const phaseInput = findControl(native.form, [/hiring_phase/]);
      const autoInput = findControl(native.form, [/hiring_automatic/]);
      if (!targetInput && !phaseInput && !autoInput) throw new Error('Formularz nie zawiera pól personelu.');

      await submitNativeForm(native.url, native.form, form => {
        const t = findControl(form, [/personal_count_target/, /personnel_count_target/]);
        const p = findControl(form, [/hiring_phase/]);
        const a = findControl(form, [/hiring_automatic/]);
        if (t) t.value = String(draft.target);
        if (p) p.value = String(draft.phase);
        if (a) {
          if (a.type === 'checkbox') a.checked = !!draft.automatic;
          else a.value = draft.automatic ? '1' : '0';
        }
      });

      b.personnelTarget = draft.target;
      b.hiringPhase = draft.phase;
      b.hiringAutomatic = draft.automatic;
      state.changedBuildings.delete(String(buildingId));
      renderBuildings();
      setStatus(`Zapisano ustawienia personelu: ${b.name}.`, 'ok');
    } catch (error) {
      console.error('[OR Crew Manager] Zapis personelu nieudany:', error);
      setStatus(`Nie zapisano „${b.name}”: ${error.message}`, 'error');
      if (confirm(`Nie udało się zapisać automatycznie:\n\n${error.message}\n\nOtworzyć jednostkę w nowej karcie?`)) {
        window.open(`/buildings/${encodeURIComponent(buildingId)}`, '_blank', 'noopener');
      }
    } finally {
      state.saving = false;
      setBusy(false);
      if (button && document.contains(button)) { button.disabled = false; button.textContent = old || '💾 Zapisz'; }
    }
  }

  function personnelControlsInForm(form) {
    const checkbox = [...form.querySelectorAll('input[type="checkbox"][name]')].filter(el => /person|personal|personnel|zalog|załog/.test(`${el.name} ${el.id}`.toLocaleLowerCase('pl')));
    const multi = [...form.querySelectorAll('select[multiple][name]')].filter(el => /person|personal|personnel|zalog|załog/.test(`${el.name} ${el.id}`.toLocaleLowerCase('pl')));
    return { checkbox, multi };
  }

  function scorePersonnelForm(form) {
    const { checkbox, multi } = personnelControlsInForm(form);
    return checkbox.length + multi.reduce((s, el) => s + el.options.length, 0);
  }

  async function findNativeVehiclePersonnelPage(vehicleId) {
    const checked = new Set();
    const queue = [`/vehicles/${encodeURIComponent(vehicleId)}/edit`, `/vehicles/${encodeURIComponent(vehicleId)}`];
    while (queue.length && checked.size < 10) {
      const url = queue.shift();
      if (!url || checked.has(url)) continue;
      checked.add(url);
      let html;
      try { html = await fetchText(url); } catch (_) { continue; }
      const doc = parseHtml(html);
      const forms = [...doc.querySelectorAll('form')].map(form => ({ form, score: scorePersonnelForm(form) })).sort((a, b) => b.score - a.score);
      if (forms[0]?.score > 0) return { url, doc, form: forms[0].form };

      for (const a of doc.querySelectorAll('a[href]')) {
        let href;
        try { href = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
        if (href.origin !== location.origin) continue;
        const text = `${a.textContent || ''} ${href.pathname}`.toLocaleLowerCase('pl');
        if (!/person|personal|personnel|personel|pracown|zalog|załog|przydz/.test(text)) continue;
        if (!href.pathname.includes(String(vehicleId)) && !href.search.includes(String(vehicleId))) continue;
        const path = href.pathname + href.search;
        if (!checked.has(path) && !queue.includes(path)) queue.push(path);
      }
    }
    return null;
  }

  async function openVehicleAssignment(vehicleId) {
    setStatus(`Szukam formularza przydziału dla pojazdu ${vehicleId}…`, 'info');
    try {
      const native = await findNativeVehiclePersonnelPage(vehicleId);
      const url = native?.url || `/vehicles/${encodeURIComponent(vehicleId)}`;
      window.open(url, '_blank', 'noopener');
      setStatus(native ? 'Otwarto natywny formularz przydziału.' : 'Nie znaleziono osobnego formularza — otwarto pojazd.', native ? 'ok' : 'warn');
    } catch (error) {
      window.open(`/vehicles/${encodeURIComponent(vehicleId)}`, '_blank', 'noopener');
      setStatus(`Nie znaleziono formularza przydziału: ${error.message}`, 'warn');
    }
  }

  async function fillVehicleToMax(vehicleId, button = null, silent = false) {
    const v = state.vehicles.find(x => x.id === String(vehicleId));
    if (!v) return { ok: false, reason: 'Nie znaleziono pojazdu.' };
    if (v.maxCrew <= 0) return { ok: true, skipped: true, reason: 'Pojazd ma maksymalną załogę 0.' };

    const old = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '…'; }
    try {
      const native = await findNativeVehiclePersonnelPage(vehicleId);
      if (!native) throw new Error('Nie znaleziono natywnego formularza przydziału personelu.');
      const { checkbox, multi } = personnelControlsInForm(native.form);
      let selected = 0;

      if (checkbox.length) {
        selected = checkbox.filter(x => x.checked).length;
        for (const cb of checkbox) {
          if (selected >= v.maxCrew) break;
          if (cb.checked || cb.disabled) continue;
          cb.checked = true;
          selected += 1;
        }
      } else if (multi.length) {
        const select = multi[0];
        selected = [...select.options].filter(o => o.selected).length;
        for (const opt of select.options) {
          if (selected >= v.maxCrew) break;
          if (opt.selected || opt.disabled) continue;
          opt.selected = true;
          selected += 1;
        }
      }

      if (selected <= 0) throw new Error('Formularz nie udostępnia personelu możliwego do przydzielenia.');
      await submitNativeForm(native.url, native.form, () => {});
      v.assignedCrew = Math.min(v.maxCrew, selected);
      v.missingCrew = Math.max(0, v.maxCrew - v.assignedCrew);
      if (!silent) {
        renderVehicles();
        setStatus(`Przydzielono załogę do maksimum dla „${v.name}” (${v.assignedCrew}/${v.maxCrew}).`, 'ok');
      }
      return { ok: true, selected: v.assignedCrew };
    } catch (error) {
      console.warn('[OR Crew Manager] Przydział załogi nieudany:', v, error);
      if (!silent) setStatus(`Nie udało się przydzielić do „${v.name}”: ${error.message}`, 'error');
      return { ok: false, reason: error.message };
    } finally {
      if (button && document.contains(button)) { button.disabled = false; button.textContent = old || '👥 Do max'; }
    }
  }

  async function fillSelectedVehicles() {
    if (state.saving) return;
    const ids = [...state.selectedVehicles];
    if (!ids.length) {
      alert('Najpierw zaznacz pojazdy.');
      return;
    }
    if (!confirm(`Przydzielić personel do maksymalnej obsady dla ${ids.length} zaznaczonych pojazdów?\n\nSkrypt użyje natywnych formularzy gry i pominie pojazdy, dla których formularza nie uda się znaleźć.`)) return;

    state.saving = true;
    setBusy(true);
    const failed = [];
    let done = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const v = state.vehicles.find(x => x.id === id);
        setStatus(`Przydział ${i + 1}/${ids.length}: ${v?.name || id}…`, 'info');
        const result = await fillVehicleToMax(id, null, true);
        if (result.ok) done += 1;
        else failed.push({ id, reason: result.reason });
        await new Promise(r => setTimeout(r, 350));
      }
      renderVehicles();
      updateSummary();
      if (failed.length) {
        setStatus(`Zakończono: ${done} OK, ${failed.length} pominięto/nie zapisano.`, 'warn');
        console.warn('[OR Crew Manager] Nieudane przydziały:', failed);
      } else {
        setStatus(`Zakończono przydział dla ${done} pojazdów.`, 'ok');
      }
    } finally {
      state.saving = false;
      setBusy(false);
    }
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #${APP_ID}-button{position:fixed;right:260px;bottom:18px;z-index:2147483000;border:0;border-radius:999px;background:#455a64;color:#fff;padding:8px 12px;font:700 13px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer}
      #${APP_ID}-button:hover{background:#37474f}
      #${APP_ID}-modal{display:none;position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.52);align-items:center;justify-content:center;font-family:Arial,sans-serif}
      #${APP_ID}-modal.or-cm-open{display:flex}
      .or-cm-window{width:min(1600px,96vw);height:min(900px,92vh);background:#fff;border-radius:9px;box-shadow:0 10px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}
      .or-cm-header{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#263238;color:#fff}.or-cm-header h2{font-size:18px;margin:0;flex:1}.or-cm-close{border:0;background:transparent;color:#fff;font-size:25px;cursor:pointer}
      .or-cm-tabs{display:flex;gap:0;background:#37474f}.or-cm-tab{border:0;background:transparent;color:#dce4e8;padding:10px 18px;font-weight:700;cursor:pointer}.or-cm-tab.active{background:#fff;color:#263238}
      .or-cm-cards{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:8px;padding:10px;background:#f5f7f8;border-bottom:1px solid #ddd}.or-cm-card{background:#fff;border:1px solid #d6dde0;border-radius:6px;padding:7px 10px}.or-cm-card span{display:block;font-size:11px;color:#607d8b}.or-cm-card b{font-size:19px}.or-cm-card-good{background:#e8f5e9}.or-cm-card-bad{background:#ffebee}
      .or-cm-toolbar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:8px 10px;border-bottom:1px solid #ddd;background:#fafafa}.or-cm-toolbar input,.or-cm-toolbar select{min-height:31px;border:1px solid #b0bec5;border-radius:4px;padding:4px 7px}.or-cm-search{min-width:280px;flex:1 1 300px}
      .or-cm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:31px;border:1px solid #90a4ae;border-radius:4px;background:#fff;color:#263238;padding:5px 9px;text-decoration:none;cursor:pointer}.or-cm-btn:hover:not(:disabled){background:#eceff1}.or-cm-btn:disabled{opacity:.55;cursor:default}.or-cm-btn-primary{background:#1976d2;color:#fff;border-color:#1565c0}.or-cm-btn-primary:hover:not(:disabled){background:#1565c0}.or-cm-btn-small{min-height:27px;padding:3px 7px;font-size:12px}
      .or-cm-panel{min-height:0;flex:1;display:flex;flex-direction:column}.or-cm-table-wrap{overflow:auto;flex:1}.or-cm-table{width:100%;border-collapse:collapse;font-size:12px}.or-cm-table th{position:sticky;top:0;z-index:2;background:#eceff1;border-bottom:1px solid #b0bec5;padding:7px;white-space:nowrap;text-align:left}.or-cm-table td{border-bottom:1px solid #eceff1;padding:5px 7px;vertical-align:middle}.or-cm-table tr:hover td{background:#f8fbfd}.or-cm-center{text-align:center}.or-cm-actions{white-space:nowrap;display:flex;gap:4px}.or-cm-empty{text-align:center;padding:30px!important;color:#78909c}
      .or-cm-target{width:76px;padding:4px}.or-cm-phase{min-width:90px}.or-cm-inline-check{display:inline-flex;align-items:center;gap:3px;margin-left:5px;white-space:nowrap}
      .or-cm-pill{display:inline-block;padding:2px 7px;border-radius:10px;font-weight:700}.or-cm-pill-shortage{background:#ffcdd2;color:#b71c1c}.or-cm-pill-ok{background:#c8e6c9;color:#1b5e20}.or-cm-pill-surplus{background:#bbdefb;color:#0d47a1}.or-cm-pill-unknown{background:#e0e0e0;color:#424242}
      .or-cm-balance-shortage{background:#fff3e0}.or-cm-balance-ok{background:#e8f5e9}.or-cm-balance-surplus{background:#e3f2fd}
      .or-cm-footer{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:8px 10px;border-top:1px solid #ddd;background:#fafafa}.or-cm-footer>span{margin-right:auto}
      .or-cm-status{padding:7px 11px;border-top:1px solid #ddd;font-size:12px}.or-cm-status-info{background:#e3f2fd;color:#0d47a1}.or-cm-status-ok{background:#e8f5e9;color:#1b5e20}.or-cm-status-warn{background:#fff3e0;color:#e65100}.or-cm-status-error{background:#ffebee;color:#b71c1c}
      #${APP_ID}-modal.or-cm-busy button:not(.or-cm-close){opacity:.65}
      @media(max-width:1000px){.or-cm-cards{grid-template-columns:repeat(3,1fr)}.or-cm-window{width:100vw;height:100vh;border-radius:0}}
    `;
    document.head.appendChild(style);
  }

  function positionButton() {
    const btn = document.getElementById(`${APP_ID}-button`);
    if (!btn) return;

    // Priorytet: przycisk Menedżera ZR Lista. Załoga OR ma być zawsze po jego lewej stronie.
    const zrButton = document.getElementById('orzr-launcher') ||
      [...document.querySelectorAll('button')].find(el => /menedżer\s*zr/i.test(el.textContent || ''));

    if (zrButton) {
      const rect = zrButton.getBoundingClientRect();
      btn.style.right = `${Math.max(10, Math.round(window.innerWidth - rect.left + 10))}px`;
      btn.style.bottom = `${Math.max(10, Math.round(window.innerHeight - rect.bottom))}px`;
      return;
    }

    // Fallback, gdy Menedżer ZR nie zdążył się jeszcze załadować.
    const candidates = [
      document.getElementById('or-building-manager-v01-button'),
      document.getElementById('or-fleet-manager-v01-button'),
      document.querySelector('[id*="building-manager"][id$="button"]'),
      document.querySelector('[id*="fleet-manager"][id$="button"]'),
    ].filter(Boolean);
    if (!candidates.length) { btn.style.right = '260px'; btn.style.bottom = '18px'; return; }
    const leftmost = candidates.reduce((a, b) => a.getBoundingClientRect().left < b.getBoundingClientRect().left ? a : b);
    const rect = leftmost.getBoundingClientRect();
    btn.style.right = `${Math.max(10, Math.round(window.innerWidth - rect.left + 10))}px`;
    btn.style.bottom = `${Math.max(10, Math.round(window.innerHeight - rect.bottom))}px`;
  }

  function createUi() {
    injectStyles();
    const button = document.createElement('button');
    button.id = `${APP_ID}-button`;
    button.type = 'button';
    button.textContent = '👥 Załoga OR';
    document.body.appendChild(button);

    const modal = document.createElement('div');
    modal.id = `${APP_ID}-modal`;
    modal.innerHTML = `
      <div class="or-cm-window" role="dialog" aria-modal="true" aria-label="Menedżer załogi OR">
        <div class="or-cm-header"><h2>👥 Menedżer załogi OR <span style="font-size:12px;color:#b0bec5">v${VERSION}</span></h2><button type="button" class="or-cm-close" title="Zamknij">×</button></div>
        <div class="or-cm-tabs"><button type="button" class="or-cm-tab active" id="${APP_ID}-tab-units">Jednostki</button><button type="button" class="or-cm-tab" id="${APP_ID}-tab-vehicles">Pojazdy</button></div>
        <div class="or-cm-cards" id="${APP_ID}-summary-cards"></div>
        <div class="or-cm-toolbar">
          <input id="${APP_ID}-search" class="or-cm-search" type="search" placeholder="Szukaj jednostki, pojazdu, typu lub ID…">
          <button type="button" class="or-cm-btn" id="${APP_ID}-reload">↻ Odśwież</button>
        </div>
        <div class="or-cm-toolbar" id="${APP_ID}-units-tools">
          <select id="${APP_ID}-building-type"><option value="">Wszystkie typy jednostek</option></select>
          <select id="${APP_ID}-building-status"><option value="all">Wszystkie stany</option><option value="shortage">Brakuje załogi</option><option value="ok">Obsada OK</option><option value="surplus">Za dużo załogi</option><option value="recruiting">Trwa rekrutacja</option></select>
          <span style="font-size:12px;color:#546e7a">Potrzeba załogi = suma maksymalnych załóg pojazdów w jednostce.</span>
        </div>
        <div class="or-cm-toolbar" id="${APP_ID}-vehicles-tools" style="display:none">
          <select id="${APP_ID}-vehicle-building"><option value="">Wszystkie jednostki</option></select>
          <select id="${APP_ID}-vehicle-type"><option value="">Wszystkie typy pojazdów</option></select>
          <select id="${APP_ID}-vehicle-status"><option value="all">Wszystkie stany</option><option value="shortage">Brakuje załogi</option><option value="ok">Obsada OK</option><option value="surplus">Nadmiar</option><option value="unknown">Brak danych o przydziale</option></select>
          <button type="button" class="or-cm-btn or-cm-btn-small" id="${APP_ID}-select-visible">Zaznacz stronę</button>
          <button type="button" class="or-cm-btn or-cm-btn-small" id="${APP_ID}-select-filtered">Zaznacz filtrowane</button>
          <button type="button" class="or-cm-btn or-cm-btn-small" id="${APP_ID}-clear-selection">Wyczyść</button>
          <button type="button" class="or-cm-btn or-cm-btn-primary" id="${APP_ID}-fill-selected">👥 Przydziel do max</button>
          <b id="${APP_ID}-vehicle-selection">Zaznaczone: 0</b>
        </div>
        <div class="or-cm-panel" id="${APP_ID}-units-panel">
          <div class="or-cm-table-wrap"><table class="or-cm-table"><thead><tr><th>ID</th><th>Typ</th><th>Jednostka</th><th>Pojazdy</th><th>Pracownicy obecnie</th><th>Docelowo</th><th>Potrzeba załogi</th><th>Bilans</th><th>Rekrutacja</th><th>Status</th><th>Akcje</th></tr></thead><tbody id="${APP_ID}-building-body"><tr><td colspan="11" class="or-cm-empty">Otwórz menedżer, aby pobrać dane.</td></tr></tbody></table></div>
          <div class="or-cm-footer" id="${APP_ID}-building-pager"></div>
        </div>
        <div class="or-cm-panel" id="${APP_ID}-vehicles-panel" style="display:none">
          <div class="or-cm-table-wrap"><table class="or-cm-table"><thead><tr><th></th><th>ID</th><th>Typ</th><th>Pojazd</th><th>Jednostka</th><th>Max załogi</th><th>Przydzielona</th><th>Brakuje</th><th>Status</th><th>Akcje</th></tr></thead><tbody id="${APP_ID}-vehicle-body"><tr><td colspan="10" class="or-cm-empty">Otwórz menedżer, aby pobrać dane.</td></tr></tbody></table></div>
          <div class="or-cm-footer" id="${APP_ID}-vehicle-pager"></div>
        </div>
        <div id="${APP_ID}-status" class="or-cm-status or-cm-status-info">Gotowy.</div>
      </div>`;
    document.body.appendChild(modal);

    button.addEventListener('click', () => {
      modal.classList.add('or-cm-open');
      if (!state.buildings.length && !state.loading) loadData(false);
    });
    modal.querySelector('.or-cm-close').addEventListener('click', () => { if (!state.saving) modal.classList.remove('or-cm-open'); });
    modal.addEventListener('click', e => { if (e.target === modal && !state.saving) modal.classList.remove('or-cm-open'); });

    document.getElementById(`${APP_ID}-tab-units`).addEventListener('click', () => { state.activeTab = 'buildings'; renderCurrentTab(); });
    document.getElementById(`${APP_ID}-tab-vehicles`).addEventListener('click', () => { state.activeTab = 'vehicles'; renderCurrentTab(); });
    document.getElementById(`${APP_ID}-reload`).addEventListener('click', () => loadData(true));

    let searchTimer = null;
    document.getElementById(`${APP_ID}-search`).addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = e.target.value;
        state.buildingPage = 1;
        state.vehiclePage = 1;
        renderCurrentTab();
      }, 120);
    });

    document.getElementById(`${APP_ID}-building-type`).addEventListener('change', e => { state.buildingTypeId = e.target.value; state.buildingPage = 1; renderBuildings(); });
    document.getElementById(`${APP_ID}-building-status`).addEventListener('change', e => { state.buildingStatus = e.target.value; state.buildingPage = 1; renderBuildings(); });
    document.getElementById(`${APP_ID}-vehicle-building`).addEventListener('change', e => { state.vehicleBuildingId = e.target.value; state.vehiclePage = 1; state.selectedVehicles.clear(); renderVehicles(); });
    document.getElementById(`${APP_ID}-vehicle-type`).addEventListener('change', e => { state.vehicleTypeId = e.target.value; state.vehiclePage = 1; state.selectedVehicles.clear(); renderVehicles(); });
    document.getElementById(`${APP_ID}-vehicle-status`).addEventListener('change', e => { state.vehicleStatus = e.target.value; state.vehiclePage = 1; state.selectedVehicles.clear(); renderVehicles(); });

    document.getElementById(`${APP_ID}-select-visible`).addEventListener('click', () => {
      const filtered = filteredVehicles();
      const start = (state.vehiclePage - 1) * PAGE_SIZE;
      filtered.slice(start, start + PAGE_SIZE).forEach(v => state.selectedVehicles.add(v.id));
      renderVehicles();
    });
    document.getElementById(`${APP_ID}-select-filtered`).addEventListener('click', () => { filteredVehicles().forEach(v => state.selectedVehicles.add(v.id)); renderVehicles(); });
    document.getElementById(`${APP_ID}-clear-selection`).addEventListener('click', () => { state.selectedVehicles.clear(); renderVehicles(); });
    document.getElementById(`${APP_ID}-fill-selected`).addEventListener('click', fillSelectedVehicles);

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('or-cm-open') && !state.saving) modal.classList.remove('or-cm-open'); });

    positionButton();
    let tries = 0;
    const timer = setInterval(() => { tries++; positionButton(); if (tries > 40) clearInterval(timer); }, 250);
    window.addEventListener('resize', positionButton);
  }

  createUi();
  console.log(`[OR Crew Manager] Wersja ${VERSION} załadowana.`);
})();
