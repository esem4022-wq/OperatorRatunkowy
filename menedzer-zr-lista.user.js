// ==UserScript==
// @name         Menedżer ZR Lista
// @namespace    https://www.operatorratunkowy.pl/
// @version      0.15
// @description  Osobny menedżer ZR: lista, szybka edycja, kopiowanie, kontrola i synchronizacja AZR, porządkowanie, duplikaty, usuwanie i eksport CSV.
// @author       ChatGPT + użytkownik
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zr-lista.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/menedzer-zr-lista.user.js
// @match        https://www.operatorratunkowy.pl/*
// @match        https://operatorratunkowy.pl/*
// @match        https://policja.operatorratunkowy.pl/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const TAG = '[OR Menedżer ZR - lista]';
    const VERSION = '0.15';

    // Przycisk Menedżera ZR Lista ma działać tylko na głównej stronie gry.
    // Nie uruchamiamy skryptu w iframe'ach ani na podstronach/oknach gry.
    if (window.top !== window.self) return;
    if (location.pathname !== '/') return;

    const state = {
        aaos: [],
        categories: new Map(),
        dirty: new Map(),
        saving: false,
        filter: '',
        categoryFilter: 'all',
        sort: 'caption-asc',
        activeTab: 'list',
        copyTargets: new Map(),
        copying: false,
        cleanupResults: [],
        cleanupMode: null,
        cleanupSelected: new Set(),
        deleting: false,
        azrVehicleSyncing: false,
        azrUpdateErrors: []
    };

    const log = (...args) => console.log(TAG, ...args);

    function normalize(text) {
        return String(text ?? '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    function escapeHTML(text) {
        return String(text ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    async function fetchJSON(path) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
        return response.json();
    }

    function unwrapArray(data) {
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.result)) return data.result;
        if (Array.isArray(data?.aaos)) return data.aaos;
        return [];
    }

    function unwrapCategoryObject(data) {
        if (!data || typeof data !== 'object') return {};
        if (data.result && typeof data.result === 'object' && !Array.isArray(data.result)) return data.result;
        return data;
    }

    async function loadData() {
        setStatus('Pobieram listę ZR…', 'info');
        const [aaosRaw, categoriesRaw] = await Promise.all([
            fetchJSON('/api/v1/aaos'),
            fetchJSON('/api/v1/aao_categories')
        ]);

        state.aaos = unwrapArray(aaosRaw).map(aao => ({
            ...aao,
            id: Number(aao.id),
            caption: String(aao.caption ?? ''),
            column: Number(aao.column ?? 1),
            aao_category_id: aao.aao_category_id == null || aao.aao_category_id === ''
                ? null : Number(aao.aao_category_id)
        })).filter(aao => Number.isFinite(aao.id));

        state.categories = new Map();
        for (const [idRaw, nameRaw] of Object.entries(unwrapCategoryObject(categoriesRaw))) {
            const id = Number(idRaw);
            if (Number.isFinite(id)) state.categories.set(id, String(nameRaw ?? `Kategoria ${id}`));
        }

        state.dirty.clear();
        state.copyTargets.clear();
        state.cleanupResults = [];
        state.cleanupMode = null;
        state.cleanupSelected.clear();
        state.azrUpdateErrors = [];
        populateCategoryFilter();
        renderActiveTable();
        updateStats();
        updateSaveAllButton();
        setStatus(`Wczytano ${state.aaos.length} ZR.`, 'success');
    }

    function getCategoryName(id) {
        if (id == null) return 'Bez kategorii';
        return state.categories.get(Number(id)) ?? `Kategoria ${id}`;
    }

    function currentRowValues(id) {
        const base = state.aaos.find(x => x.id === id);
        if (!base) return null;
        const dirty = state.dirty.get(id) || {};
        return {
            caption: dirty.caption ?? base.caption,
            column: dirty.column ?? base.column,
            aao_category_id: Object.prototype.hasOwnProperty.call(dirty, 'aao_category_id')
                ? dirty.aao_category_id : base.aao_category_id
        };
    }

    function markDirty(id, key, value) {
        const base = state.aaos.find(x => x.id === id);
        if (!base) return;
        const current = { ...(state.dirty.get(id) || {}), [key]: value };
        const v = {
            caption: current.caption ?? base.caption,
            column: current.column ?? base.column,
            aao_category_id: Object.prototype.hasOwnProperty.call(current, 'aao_category_id')
                ? current.aao_category_id : base.aao_category_id
        };
        const unchanged = v.caption === base.caption &&
            Number(v.column) === Number(base.column) &&
            v.aao_category_id === base.aao_category_id;
        if (unchanged) state.dirty.delete(id); else state.dirty.set(id, current);
        document.querySelector(`tr[data-zr-id="${id}"]`)?.classList.toggle('orzr-dirty', state.dirty.has(id));
        updateStats();
        updateSaveAllButton();
    }

    function valuesForView(aao, mode = state.activeTab) {
        if (mode === 'copy') {
            return {
                caption: aao.caption,
                column: aao.column,
                aao_category_id: aao.aao_category_id
            };
        }
        return currentRowValues(aao.id);
    }

    function sortedFilteredAAOs(mode = state.activeTab) {
        const q = normalize(state.filter);
        const rows = state.aaos.filter(aao => {
            const v = valuesForView(aao, mode);
            if (!v) return false;
            if (state.categoryFilter === 'none' && v.aao_category_id !== null) return false;
            if (state.categoryFilter === 'with' && v.aao_category_id === null) return false;
            if (!['all', 'none', 'with'].includes(state.categoryFilter) &&
                Number(state.categoryFilter) !== Number(v.aao_category_id)) return false;
            if (q) {
                const haystack = normalize(`${v.caption} ${v.column} ${getCategoryName(v.aao_category_id)} ${aao.id}`);
                if (!haystack.includes(q)) return false;
            }
            return true;
        });

        rows.sort((a, b) => {
            const av = valuesForView(a, mode), bv = valuesForView(b, mode);
            switch (state.sort) {
                case 'caption-desc': return bv.caption.localeCompare(av.caption, 'pl', { numeric: true, sensitivity: 'base' });
                case 'column-asc': return Number(av.column) - Number(bv.column) || av.caption.localeCompare(bv.caption, 'pl');
                case 'column-desc': return Number(bv.column) - Number(av.column) || av.caption.localeCompare(bv.caption, 'pl');
                case 'category-asc': return getCategoryName(av.aao_category_id).localeCompare(getCategoryName(bv.aao_category_id), 'pl', { numeric: true, sensitivity: 'base' }) || av.caption.localeCompare(bv.caption, 'pl');
                case 'id-asc': return a.id - b.id;
                default: return av.caption.localeCompare(bv.caption, 'pl', { numeric: true, sensitivity: 'base' });
            }
        });
        return rows;
    }

    function categoryOptions(selected) {
        const out = [`<option value="" ${selected === null ? 'selected' : ''}>Bez kategorii</option>`];
        for (const [id, name] of [...state.categories.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pl'))) {
            out.push(`<option value="${id}" ${Number(selected) === id ? 'selected' : ''}>${escapeHTML(name)}</option>`);
        }
        return out.join('');
    }

    function renderTable() {
        const tbody = document.getElementById('orzr-list-body');
        if (!tbody) return;
        const rows = sortedFilteredAAOs();
        tbody.innerHTML = '';
        const empty = document.getElementById('orzr-empty');
        if (empty) empty.hidden = rows.length > 0;

        for (const aao of rows) {
            const v = currentRowValues(aao.id);
            const tr = document.createElement('tr');
            tr.dataset.zrId = aao.id;
            if (state.dirty.has(aao.id)) tr.classList.add('orzr-dirty');
            tr.innerHTML = `
                <td class="orzr-id">${aao.id}</td>
                <td><input type="text" class="form-control input-sm orzr-caption" value="${escapeHTML(v.caption)}" data-id="${aao.id}"></td>
                <td><input type="number" class="form-control input-sm orzr-column" value="${Number(v.column) || 1}" min="1" step="1" data-id="${aao.id}"></td>
                <td><select class="form-control input-sm orzr-category" data-id="${aao.id}">${categoryOptions(v.aao_category_id)}</select></td>
                <td class="orzr-actions">
                    <button type="button" class="btn btn-success btn-sm orzr-save-row" data-id="${aao.id}">💾 Zapisz</button>
                    <a class="btn btn-default btn-sm" href="/aaos/${aao.id}/edit">✎ Edycja</a>
                </td>`;
            tbody.appendChild(tr);
        }
        bindRowEvents();
        updateStats();
    }

    function bindRowEvents() {
        document.querySelectorAll('.orzr-caption').forEach(el => el.addEventListener('input', () => markDirty(Number(el.dataset.id), 'caption', el.value)));
        document.querySelectorAll('.orzr-column').forEach(el => el.addEventListener('input', () => markDirty(Number(el.dataset.id), 'column', Math.max(1, Number.parseInt(el.value, 10) || 1))));
        document.querySelectorAll('.orzr-category').forEach(el => el.addEventListener('change', () => markDirty(Number(el.dataset.id), 'aao_category_id', el.value === '' ? null : Number(el.value))));
        document.querySelectorAll('.orzr-save-row').forEach(el => el.addEventListener('click', () => saveOne(Number(el.dataset.id), el)));
    }

    function getCopyTarget(id) {
        const base = state.aaos.find(x => x.id === id);
        if (!base) return null;
        if (!state.copyTargets.has(id)) {
            state.copyTargets.set(id, {
                column: Number(base.column) || 1,
                aao_category_id: base.aao_category_id
            });
        }
        return state.copyTargets.get(id);
    }

    function setCopyTarget(id, key, value) {
        const target = getCopyTarget(id);
        if (!target) return;
        target[key] = value;
    }

    function getVisibleCopyRows() {
        return sortedFilteredAAOs('copy');
    }

    function applyCopyColumnToAllVisible() {
        if (state.copying) return;
        const input = document.getElementById('orzr-copy-all-column');
        if (!input) return;
        const column = Math.max(1, Number.parseInt(input.value, 10) || 1);
        input.value = String(column);
        const rows = getVisibleCopyRows();
        if (!rows.length) {
            setStatus('Brak widocznych ZR, dla których można ustawić docelowy numer kolumny.', 'warning');
            return;
        }
        for (const aao of rows) setCopyTarget(aao.id, 'column', column);
        renderCopyTable();
        setStatus(`Ustawiono docelowy nr kolumny ${column} dla ${rows.length} widocznych ZR.`, 'success');
    }

    function applyCopyCategoryToAllVisible() {
        if (state.copying) return;
        const select = document.getElementById('orzr-copy-all-category');
        if (!select) return;
        const categoryId = select.value === '' ? null : Number(select.value);
        const rows = getVisibleCopyRows();
        if (!rows.length) {
            setStatus('Brak widocznych ZR, dla których można ustawić kategorię docelową.', 'warning');
            return;
        }
        for (const aao of rows) setCopyTarget(aao.id, 'aao_category_id', categoryId);
        renderCopyTable();
        setStatus(`Ustawiono docelową kategorię „${getCategoryName(categoryId)}” dla ${rows.length} widocznych ZR.`, 'success');
    }

    async function copyAllVisible() {
        if (state.copying) return;

        // Robimy migawkę listy przed startem, aby nowo utworzone kopie
        // nie zostały ponownie skopiowane w tym samym przebiegu.
        const rows = getVisibleCopyRows().map(aao => ({
            id: aao.id,
            caption: aao.caption,
            target: { ...getCopyTarget(aao.id) }
        }));

        if (!rows.length) {
            setStatus('Brak widocznych ZR do skopiowania.', 'warning');
            return;
        }

        if (!confirm(`Skopiować wszystkie aktualnie widoczne ZR (${rows.length})?`)) return;

        const button = document.getElementById('orzr-copy-all-visible');
        const oldText = button?.textContent;
        state.copying = true;
        if (button) button.textContent = `Kopiuję 0/${rows.length}…`;
        updateCopyButtons();

        let ok = 0;
        let failed = 0;

        try {
            for (let i = 0; i < rows.length; i++) {
                const item = rows[i];
                const target = {
                    column: Math.max(1, Number.parseInt(item.target.column, 10) || 1),
                    aao_category_id: item.target.aao_category_id == null
                        ? null : Number(item.target.aao_category_id)
                };

                if (button) button.textContent = `Kopiuję ${i + 1}/${rows.length}…`;
                setStatus(
                    `Kopiuję ${i + 1}/${rows.length}: „${item.caption}” → kolumna ${target.column}, ${getCategoryName(target.aao_category_id)}…`,
                    'info'
                );

                try {
                    await copyViaNativeEditor(item.id, target);
                    ok++;
                } catch (e) {
                    console.error(TAG, `Błąd kopiowania ZR ${item.id}`, e);
                    failed++;
                }
            }

            // Po całej operacji odświeżamy listę z API, żeby nowe kopie
            // od razu pojawiły się w Menedżerze.
            try {
                state.aaos = await fetchAAOListNormalized();
            } catch (e) {
                console.warn(TAG, 'Nie udało się odświeżyć listy ZR po kopiowaniu zbiorczym:', e);
            }

            renderCopyTable();
            setStatus(
                failed
                    ? `Kopiowanie zakończone. Skopiowano: ${ok}. Błędy: ${failed}.`
                    : `Skopiowano wszystkie widoczne ZR: ${ok}.`,
                failed ? 'warning' : 'success'
            );
        } finally {
            state.copying = false;
            if (button && document.contains(button)) button.textContent = oldText || '⧉ Kopiuj wszystkie';
            updateCopyButtons();
        }
    }

    function renderCopyTable() {
        const tbody = document.getElementById('orzr-copy-body');
        if (!tbody) return;
        const rows = sortedFilteredAAOs('copy');
        tbody.innerHTML = '';
        const empty = document.getElementById('orzr-empty');
        if (empty) empty.hidden = rows.length > 0;

        for (const aao of rows) {
            const target = getCopyTarget(aao.id);
            const tr = document.createElement('tr');
            tr.dataset.zrId = aao.id;
            tr.innerHTML = `
                <td class="orzr-id">${aao.id}</td>
                <td><input type="text" class="form-control input-sm" value="${escapeHTML(aao.caption)}" readonly></td>
                <td><input type="number" class="form-control input-sm" value="${Number(aao.column) || 1}" readonly></td>
                <td><select class="form-control input-sm" disabled>${categoryOptions(aao.aao_category_id)}</select></td>
                <td class="orzr-copy-action">
                    <button type="button" class="btn btn-primary btn-sm orzr-copy-row" data-id="${aao.id}">⧉ Kopiuj</button>
                </td>
                <td><input type="number" class="form-control input-sm orzr-copy-column" value="${Number(target.column) || 1}" min="1" step="1" data-id="${aao.id}"></td>
                <td><select class="form-control input-sm orzr-copy-category" data-id="${aao.id}">${categoryOptions(target.aao_category_id)}</select></td>`;
            tbody.appendChild(tr);
        }
        bindCopyEvents();
        updateStats();
        updateCopyButtons();
    }

    function bindCopyEvents() {
        document.querySelectorAll('.orzr-copy-column').forEach(el => el.addEventListener('input', () => {
            setCopyTarget(Number(el.dataset.id), 'column', Math.max(1, Number.parseInt(el.value, 10) || 1));
        }));
        document.querySelectorAll('.orzr-copy-category').forEach(el => el.addEventListener('change', () => {
            setCopyTarget(Number(el.dataset.id), 'aao_category_id', el.value === '' ? null : Number(el.value));
        }));
        document.querySelectorAll('.orzr-copy-row').forEach(el => el.addEventListener('click', () => copyOne(Number(el.dataset.id), el)));
    }

    function updateCopyButtons() {
        document.querySelectorAll('.orzr-copy-row').forEach(btn => {
            btn.disabled = state.copying;
        });
        document.querySelectorAll('.orzr-copy-bulk-apply').forEach(btn => {
            btn.disabled = state.copying;
        });
    }

    async function fetchAAOListNormalized() {
        const raw = await fetchJSON('/api/v1/aaos');
        return unwrapArray(raw).map(aao => ({
            ...aao,
            id: Number(aao.id),
            caption: String(aao.caption ?? ''),
            column: Number(aao.column ?? 1),
            aao_category_id: aao.aao_category_id == null || aao.aao_category_id === ''
                ? null : Number(aao.aao_category_id)
        })).filter(aao => Number.isFinite(aao.id));
    }

    async function copyViaNativeEditor(id, target) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:10px;height:10px;border:0;opacity:0;pointer-events:none';
        frame.src = `/aaos/${id}/copy`;
        document.body.appendChild(frame);
        try {
            await waitForFrameLoad(frame);
            const doc = frame.contentDocument;
            if (!doc) throw new Error('Nie można otworzyć formularza kopiowania ZR.');
            const form = doc.querySelector('form[action*="/aaos"]') || doc.querySelector('form');
            if (!form) throw new Error('Nie znaleziono formularza kopiowania ZR.');
            const column = findColumnField(doc);
            const category = findCategoryField(doc);
            if (!column) throw new Error('Nie znaleziono pola docelowego numeru kolumny.');
            if (!category) throw new Error('Nie znaleziono pola docelowej kategorii.');

            setNativeValue(column, target.column);
            setNativeValue(category, target.aao_category_id);

            const secondLoad = waitForFrameLoad(frame);
            const submit = doc.querySelector('#save-button') || form.querySelector('button[type="submit"], input[type="submit"]');
            if (submit) submit.click();
            else if (form.requestSubmit) form.requestSubmit();
            else form.submit();
            await secondLoad;

            const resultDoc = frame.contentDocument;
            const errorBox = resultDoc?.querySelector('.alert-danger,.alert-error,.has-error .help-block,.field_with_errors');
            if (errorBox && normalize(errorBox.textContent)) {
                throw new Error(errorBox.textContent.replace(/\s+/g, ' ').trim());
            }
        } finally {
            setTimeout(() => frame.remove(), 50);
        }
    }

    async function findNewCopy(source, target, knownIds) {
        for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt) await new Promise(r => setTimeout(r, 250));
            try {
                const list = await fetchAAOListNormalized();
                const candidates = list.filter(aao =>
                    !knownIds.has(aao.id) &&
                    aao.caption === source.caption &&
                    Number(aao.column) === Number(target.column) &&
                    aao.aao_category_id === target.aao_category_id
                );
                if (candidates.length) {
                    candidates.sort((a, b) => b.id - a.id);
                    return candidates[0];
                }
            } catch (e) {
                console.warn(TAG, 'Weryfikacja kopii przez API nie powiodła się:', e);
                return null;
            }
        }
        return null;
    }


    function getAZRCategoryId() {
        for (const [id, name] of state.categories.entries()) {
            if (name === 'AZR') return Number(id);
        }
        return null;
    }

    function getMissingInAZRRows() {
        const azrCategoryId = getAZRCategoryId();
        if (azrCategoryId == null) return [];

        // Menedżer ZR OR szuka po dokładnej nazwie, dlatego tutaj również
        // porównujemy nazwy 1:1. „Bez kategorii” nie bierze udziału w kontroli.
        const azrNames = new Set(
            state.aaos
                .filter(aao => aao.aao_category_id === azrCategoryId)
                .map(aao => String(aao.caption ?? ''))
        );

        const sources = state.aaos
            .filter(aao =>
                aao.aao_category_id != null &&
                aao.aao_category_id !== azrCategoryId &&
                !azrNames.has(String(aao.caption ?? ''))
            )
            .sort((a, b) =>
                a.caption.localeCompare(b.caption, 'pl', { numeric: true, sensitivity: 'base' }) ||
                getCategoryName(a.aao_category_id).localeCompare(getCategoryName(b.aao_category_id), 'pl', { numeric: true, sensitivity: 'base' }) ||
                a.id - b.id
            );

        // Jeżeli ta sama dokładna nazwa występuje w kilku zwykłych kategoriach,
        // do AZR potrzebna jest tylko jedna kopia. Pokazujemy więc jeden wiersz
        // i informujemy, w ilu/kilku kategoriach źródłowych nazwa występuje.
        const grouped = new Map();
        for (const aao of sources) {
            const key = String(aao.caption ?? '');
            if (!grouped.has(key)) {
                grouped.set(key, {
                    aao,
                    sourceCategories: new Set(),
                    sourceIds: []
                });
            }
            const group = grouped.get(key);
            group.sourceCategories.add(getCategoryName(aao.aao_category_id));
            group.sourceIds.push(aao.id);
        }

        return [...grouped.values()].sort((a, b) =>
            a.aao.caption.localeCompare(b.aao.caption, 'pl', { numeric: true, sensitivity: 'base' }) ||
            a.aao.id - b.aao.id
        );
    }

    function updateMissingAZRButtons() {
        const rows = getMissingInAZRRows();
        const azrCategoryId = getAZRCategoryId();
        const all = document.getElementById('orzr-missing-azr-copy-all');
        if (all) {
            all.disabled = state.copying || state.azrVehicleSyncing || azrCategoryId == null || rows.length === 0;
            all.textContent = state.copying
                ? 'Kopiowanie…'
                : `⧉ Kopiuj wszystkie do AZR (${rows.length})`;
        }
        document.querySelectorAll('.orzr-missing-azr-copy').forEach(btn => {
            btn.disabled = state.copying || state.azrVehicleSyncing || azrCategoryId == null;
        });

        const sync = document.getElementById('orzr-missing-azr-sync-vehicles');
        if (sync) {
            sync.disabled = state.copying || state.azrVehicleSyncing || azrCategoryId == null;
            if (!state.azrVehicleSyncing) sync.textContent = '🔄 Sprawdź i aktualizuj pojazdy AZR';
        }
    }

    function renderMissingAZRTable() {
        const tbody = document.getElementById('orzr-missing-azr-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const empty = document.getElementById('orzr-missing-azr-empty');
        const azrCategoryId = getAZRCategoryId();
        const rows = getMissingInAZRRows();

        if (empty) {
            empty.hidden = rows.length > 0;
            if (azrCategoryId == null) {
                empty.textContent = 'Nie znaleziono kategorii o dokładnej nazwie „AZR”. Utwórz ją lub popraw jej nazwę.';
            } else {
                empty.textContent = 'W kategorii AZR są już ZR o wszystkich dokładnych nazwach występujących w pozostałych kategoriach. „Bez kategorii” jest pomijane.';
            }
        }

        for (const item of rows) {
            const aao = item.aao;
            const categories = [...item.sourceCategories].sort((a, b) => a.localeCompare(b, 'pl', { numeric: true, sensitivity: 'base' }));
            const sourceInfo = categories.join(', ');
            const duplicateNote = item.sourceIds.length > 1
                ? `<div class="orzr-missing-note">Ta sama nazwa występuje w ${item.sourceIds.length} ZR źródłowych — do AZR zostanie utworzona jedna kopia.</div>`
                : '';

            const tr = document.createElement('tr');
            tr.dataset.zrId = aao.id;
            tr.innerHTML = `
                <td class="orzr-id">${aao.id}</td>
                <td class="orzr-missing-name">${escapeHTML(aao.caption)}${duplicateNote}</td>
                <td>${Number(aao.column) || 1}</td>
                <td>${escapeHTML(sourceInfo)}</td>
                <td class="orzr-actions">
                    <button type="button" class="btn btn-primary btn-sm orzr-missing-azr-copy" data-id="${aao.id}">⧉ Kopiuj do AZR</button>
                    <a class="btn btn-default btn-sm" href="/aaos/${aao.id}/edit">✎ Edycja</a>
                </td>`;
            tbody.appendChild(tr);
        }

        document.querySelectorAll('.orzr-missing-azr-copy').forEach(btn => {
            btn.addEventListener('click', () => copyOneMissingToAZR(Number(btn.dataset.id), btn));
        });

        updateMissingAZRButtons();
        updateStats();
    }

    async function copyOneMissingToAZR(id, button = null) {
        if (state.copying) return;
        const azrCategoryId = getAZRCategoryId();
        if (azrCategoryId == null) {
            setStatus('Nie znaleziono kategorii o dokładnej nazwie „AZR”.', 'danger');
            return;
        }

        const source = state.aaos.find(x => x.id === id);
        if (!source || source.aao_category_id == null || source.aao_category_id === azrCategoryId) return;

        // Nie kopiujemy ponownie, jeśli dokładna nazwa już zdążyła pojawić się w AZR.
        const alreadyExists = state.aaos.some(aao =>
            aao.aao_category_id === azrCategoryId && aao.caption === source.caption
        );
        if (alreadyExists) {
            renderMissingAZRTable();
            setStatus(`ZR „${source.caption}” już znajduje się w kategorii AZR.`, 'success');
            return;
        }

        const oldText = button?.textContent;
        state.copying = true;
        if (button) button.textContent = 'Kopiuję…';
        updateCopyButtons();
        updateMissingAZRButtons();

        try {
            const target = {
                column: 1,
                aao_category_id: azrCategoryId
            };
            setStatus(`Kopiuję „${source.caption}” do kategorii AZR, kolumna 1…`, 'info');
            await copyViaNativeEditor(source.id, target);
            state.aaos = await fetchAAOListNormalized();
            renderMissingAZRTable();
            setStatus(`Skopiowano „${source.caption}” do AZR.`, 'success');
        } catch (e) {
            console.error(TAG, e);
            setStatus(`Błąd kopiowania „${source.caption}” do AZR: ${e.message || e}`, 'danger');
        } finally {
            state.copying = false;
            if (button && document.contains(button)) button.textContent = oldText || '⧉ Kopiuj do AZR';
            updateCopyButtons();
            updateMissingAZRButtons();
        }
    }

    async function copyAllMissingToAZR() {
        if (state.copying) return;
        const azrCategoryId = getAZRCategoryId();
        if (azrCategoryId == null) {
            setStatus('Nie znaleziono kategorii o dokładnej nazwie „AZR”.', 'danger');
            return;
        }

        const rows = getMissingInAZRRows().map(item => ({
            id: item.aao.id,
            caption: item.aao.caption,
            column: 1
        }));

        if (!rows.length) {
            setStatus('Nic nie brakuje w AZR.', 'success');
            return;
        }
        if (!confirm(`Skopiować do kategorii AZR wszystkie brakujące ZR (${rows.length})?\n\n„Bez kategorii” jest pomijane.`)) return;

        const button = document.getElementById('orzr-missing-azr-copy-all');
        state.copying = true;
        updateCopyButtons();
        updateMissingAZRButtons();

        let ok = 0;
        let failed = 0;
        try {
            for (let i = 0; i < rows.length; i++) {
                const item = rows[i];
                if (button) button.textContent = `Kopiuję ${i + 1}/${rows.length}…`;
                setStatus(`Kopiuję ${i + 1}/${rows.length}: „${item.caption}” → AZR, kolumna 1…`, 'info');

                try {
                    // Przed każdym kopiowaniem sprawdzamy aktualną listę w pamięci,
                    // aby nie stworzyć dwóch kopii tej samej dokładnej nazwy.
                    const exists = state.aaos.some(aao =>
                        aao.aao_category_id === azrCategoryId && aao.caption === item.caption
                    );
                    if (exists) continue;

                    await copyViaNativeEditor(item.id, {
                        column: item.column,
                        aao_category_id: azrCategoryId
                    });
                    ok++;

                    // Po każdej udanej kopii dokładamy nazwę do pamięci przez pełne
                    // odświeżenie dopiero na końcu; tymczasowy wpis chroni przed duplikatem.
                    state.aaos.push({
                        id: -1000000 - i,
                        caption: item.caption,
                        column: item.column,
                        aao_category_id: azrCategoryId,
                        __temporaryAZR: true
                    });
                } catch (e) {
                    console.error(TAG, `Błąd kopiowania ZR ${item.id} do AZR`, e);
                    failed++;
                }
            }

            state.aaos = await fetchAAOListNormalized();
            renderMissingAZRTable();
            setStatus(
                failed
                    ? `Kopiowanie do AZR zakończone. Skopiowano: ${ok}. Błędy: ${failed}.`
                    : `Skopiowano do AZR wszystkie brakujące ZR: ${ok}.`,
                failed ? 'warning' : 'success'
            );
        } catch (e) {
            console.error(TAG, e);
            // Usuwamy ewentualne tymczasowe wpisy po błędzie odświeżenia.
            state.aaos = state.aaos.filter(aao => !aao.__temporaryAZR);
            setStatus(`Błąd końcowego odświeżenia po kopiowaniu do AZR: ${e.message || e}`, 'danger');
        } finally {
            state.copying = false;
            updateCopyButtons();
            updateMissingAZRButtons();
            updateStats();
        }
    }



    function labelForAAOField(doc, field) {
        if (field.id) {
            try {
                const label = doc.querySelector(`label[for="${CSS.escape(field.id)}"]`);
                if (label) return label.textContent.replace(/\s+/g, ' ').trim();
            } catch {}
        }

        const group = field.closest('.form-group,.control-group,.row,[class*="form"]');
        const label = group?.querySelector('label');
        return label ? label.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    function isVehicleRequirementField(doc, field) {
        if (!field || field.disabled || !field.name) return false;
        if (field.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(field.type)) return false;

        const name = String(field.name || '').trim();
        const nn = normalize(name);
        const label = labelForAAOField(doc, field);
        const nl = normalize(label);

        // Pola techniczne i organizacyjne ZR nie są wymaganiami pojazdów.
        if (
            name === 'authenticity_token' || name === 'utf8' || name === '_method' || name === 'commit' ||
            nn.includes('caption') || nn.includes('aao category') || nn.includes('category id') ||
            nn.includes('column') || nn.includes('column number') ||
            nl === 'nazwa' || nl.includes('nazwa zr') || nl.includes('nazwa reguly') ||
            nl.includes('kategoria') || nl.includes('kolumna')
        ) return false;

        // Użytkownik chce synchronizować wyłącznie pojazdy, bez zasobów i personelu.
        if (
            nl.includes('wod') || nl.includes('pian') || nn.includes('water') || nn.includes('foam') ||
            nl.includes('personel') || nl.includes('strazak') || nl.includes('policjant') ||
            nl.includes('ratownik') || nl.includes('pacjent') || nl.includes('odleglosc') || nl.includes('dystans')
        ) return false;

        if (/^vehicle_type_ids\[/.test(name) || /^vehicle_type_caption\[/.test(name)) return true;
        if (/^aao\[/.test(name) && field.tagName === 'INPUT') {
            const raw = String(field.value ?? '').trim();
            if (field.type === 'number' || raw === '' || /^-?\d+(?:[.,]\d+)?$/.test(raw)) return true;
        }
        if (field.tagName === 'INPUT' && field.type === 'number') return true;

        return false;
    }

    function normalizeVehicleRequirementValue(value) {
        const raw = String(value ?? '').replace(/\u00a0/g, ' ').trim();
        if (!raw) return '0';
        const numeric = Number(raw.replace(',', '.'));
        return Number.isFinite(numeric) ? String(numeric) : raw;
    }

    function collectVehicleRequirementSnapshot(doc) {
        const controls = [...doc.querySelectorAll('input[name],select[name],textarea[name]')]
            .filter(field => isVehicleRequirementField(doc, field));

        const occurrences = new Map();
        const fields = [];

        for (const field of controls) {
            const name = String(field.name || '').trim();
            const index = occurrences.get(name) || 0;
            occurrences.set(name, index + 1);
            const key = `${name}@@${index}`;
            const rawValue = field.value == null ? '' : String(field.value);
            fields.push({
                key,
                name,
                index,
                label: labelForAAOField(doc, field) || name,
                rawValue,
                value: normalizeVehicleRequirementValue(rawValue)
            });
        }

        fields.sort((a, b) => a.key.localeCompare(b.key));
        const signature = fields.map(f => `${f.key}=${f.value}`).join('\n');
        return { fields, signature };
    }

    async function fetchAAOEditorDocument(id) {
        const response = await fetch(`/aaos/${id}/edit`, {
            credentials: 'same-origin',
            headers: { Accept: 'text/html' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} podczas pobierania ZR ${id}.`);
        const html = await response.text();
        return new DOMParser().parseFromString(html, 'text/html');
    }

    async function readVehicleRequirementSnapshot(id) {
        const doc = await fetchAAOEditorDocument(id);
        const snapshot = collectVehicleRequirementSnapshot(doc);
        if (!snapshot.fields.length) {
            throw new Error(`Nie znaleziono pól pojazdów w ZR ${id}.`);
        }
        return snapshot;
    }

    function vehicleSnapshotsEqual(a, b) {
        return String(a?.signature ?? '') === String(b?.signature ?? '');
    }

    function getAZRVehicleComparisonGroups() {
        const azrCategoryId = getAZRCategoryId();
        if (azrCategoryId == null) return [];

        const byName = new Map();
        for (const aao of state.aaos) {
            if (aao.aao_category_id == null) continue; // Bez kategorii pomijamy.
            const name = String(aao.caption ?? '');
            if (!name) continue;
            if (!byName.has(name)) byName.set(name, { name, sources: [], targets: [] });
            const group = byName.get(name);
            if (aao.aao_category_id === azrCategoryId) group.targets.push(aao);
            else group.sources.push(aao);
        }

        return [...byName.values()]
            .filter(group => group.sources.length && group.targets.length)
            .map(group => ({
                ...group,
                sources: [...group.sources].sort((a, b) =>
                    getCategoryName(a.aao_category_id).localeCompare(getCategoryName(b.aao_category_id), 'pl', { numeric: true, sensitivity: 'base' }) ||
                    a.id - b.id
                ),
                targets: [...group.targets].sort((a, b) => a.id - b.id)
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'pl', { numeric: true, sensitivity: 'base' }));
    }

    async function applyVehicleSnapshotToAZR(targetId, sourceSnapshot) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:10px;height:10px;border:0;opacity:0;pointer-events:none';
        frame.src = `/aaos/${targetId}/edit`;
        document.body.appendChild(frame);

        try {
            await waitForFrameLoad(frame);
            const doc = frame.contentDocument;
            if (!doc) throw new Error('Nie można otworzyć formularza edycji AZR.');
            const form = doc.querySelector('form[action*="/aaos/"]') || doc.querySelector('form');
            if (!form) throw new Error('Nie znaleziono formularza edycji AZR.');

            const targetControls = [...doc.querySelectorAll('input[name],select[name],textarea[name]')]
                .filter(field => isVehicleRequirementField(doc, field));
            const occurrences = new Map();
            const targetByKey = new Map();

            for (const field of targetControls) {
                const name = String(field.name || '').trim();
                const index = occurrences.get(name) || 0;
                occurrences.set(name, index + 1);
                targetByKey.set(`${name}@@${index}`, field);
            }

            const sourceByKey = new Map(sourceSnapshot.fields.map(field => [field.key, field]));
            let changed = 0;

            for (const [key, targetField] of targetByKey.entries()) {
                const sourceField = sourceByKey.get(key);
                const newValue = sourceField ? sourceField.rawValue : '';
                if (normalizeVehicleRequirementValue(targetField.value) !== normalizeVehicleRequirementValue(newValue)) {
                    setNativeValue(targetField, newValue);
                    changed++;
                }
            }

            if (!changed) return 0;

            const secondLoad = waitForFrameLoad(frame);
            const submit = doc.querySelector('#save-button') || form.querySelector('button[type="submit"], input[type="submit"]');
            if (submit) submit.click();
            else if (form.requestSubmit) form.requestSubmit();
            else form.submit();
            await secondLoad;

            const resultDoc = frame.contentDocument;
            const errorBox = resultDoc?.querySelector('.alert-danger,.alert-error,.has-error .help-block,.field_with_errors');
            if (errorBox && normalize(errorBox.textContent)) {
                throw new Error(errorBox.textContent.replace(/\s+/g, ' ').trim());
            }
            return changed;
        } finally {
            setTimeout(() => frame.remove(), 50);
        }
    }

    function renderAZRUpdateErrors() {
        const section = document.getElementById('orzr-azr-update-errors');
        const tbody = document.getElementById('orzr-azr-update-errors-body');
        const count = document.getElementById('orzr-azr-update-errors-count');
        if (!section || !tbody) return;

        const errors = Array.isArray(state.azrUpdateErrors) ? state.azrUpdateErrors : [];
        section.hidden = state.activeTab !== 'missing-azr' || errors.length === 0;
        if (count) count.textContent = errors.length;
        tbody.innerHTML = '';

        for (const error of errors) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="orzr-id">${Number(error.targetId) || ''}</td>
                <td>${escapeHTML(error.name || '')}</td>
                <td class="orzr-id">${Number(error.sourceId) || ''}</td>
                <td>${escapeHTML(error.sourceCategory || '')}</td>
                <td class="orzr-azr-error-message">${escapeHTML(error.message || 'Nieznany błąd')}</td>
                <td class="orzr-actions"><a class="btn btn-default btn-sm" href="/aaos/${Number(error.targetId) || ''}/edit">✎ Edycja AZR</a></td>`;
            tbody.appendChild(tr);
        }
    }

    async function syncAZRVehicleRequirements() {
        if (state.copying || state.azrVehicleSyncing) return;
        const azrCategoryId = getAZRCategoryId();
        if (azrCategoryId == null) {
            setStatus('Nie znaleziono kategorii o dokładnej nazwie „AZR”.', 'danger');
            return;
        }

        // Najpierw pobieramy świeżą listę, aby porównywać aktualny stan.
        try {
            state.aaos = await fetchAAOListNormalized();
            renderMissingAZRTable();
        } catch (e) {
            setStatus(`Błąd odświeżania listy przed kontrolą AZR: ${e.message || e}`, 'danger');
            return;
        }

        const groups = getAZRVehicleComparisonGroups();
        if (!groups.length) {
            setStatus('Brak ZR o tych samych dokładnych nazwach w AZR i w innych kategoriach.', 'warning');
            return;
        }

        const button = document.getElementById('orzr-missing-azr-sync-vehicles');
        state.azrVehicleSyncing = true;
        state.azrUpdateErrors = [];
        renderAZRUpdateErrors();
        updateMissingAZRButtons();

        const snapshotCache = new Map();
        const getSnapshot = async id => {
            if (!snapshotCache.has(id)) snapshotCache.set(id, readVehicleRequirementSnapshot(id));
            return snapshotCache.get(id);
        };

        const mismatches = [];
        const conflicts = [];
        let checkedTargets = 0;
        let sameTargets = 0;
        let scanErrors = 0;

        try {
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                if (button) button.textContent = `Sprawdzam ${i + 1}/${groups.length}…`;
                setStatus(`Sprawdzam pojazdy AZR ${i + 1}/${groups.length}: „${group.name}”…`, 'info');

                try {
                    const sourceSnapshots = [];
                    for (const source of group.sources) {
                        sourceSnapshots.push({ source, snapshot: await getSnapshot(source.id) });
                    }

                    const canonical = sourceSnapshots[0];
                    const differingSources = sourceSnapshots.filter(item => !vehicleSnapshotsEqual(item.snapshot, canonical.snapshot));
                    if (differingSources.length) {
                        conflicts.push(group);
                        continue;
                    }

                    for (const target of group.targets) {
                        const targetSnapshot = await getSnapshot(target.id);
                        checkedTargets++;
                        if (vehicleSnapshotsEqual(canonical.snapshot, targetSnapshot)) {
                            sameTargets++;
                        } else {
                            mismatches.push({
                                name: group.name,
                                source: canonical.source,
                                target,
                                sourceSnapshot: canonical.snapshot
                            });
                        }
                    }
                } catch (e) {
                    console.error(TAG, `Błąd sprawdzania pojazdów dla „${group.name}”`, e);
                    scanErrors++;
                }
            }

            if (!mismatches.length) {
                const extra = [
                    conflicts.length ? `Konflikty źródeł: ${conflicts.length}.` : '',
                    scanErrors ? `Błędy odczytu: ${scanErrors}.` : ''
                ].filter(Boolean).join(' ');
                setStatus(`Sprawdzono ${checkedTargets} ZR w AZR. Wszystkie mają takie same pojazdy jak ZR źródłowe. ${extra}`.trim(), conflicts.length || scanErrors ? 'warning' : 'success');
                return;
            }

            const conflictNote = conflicts.length
                ? `\n\nUwaga: ${conflicts.length} nazw ma różne zestawy pojazdów w kilku kategoriach źródłowych. Te pozycje zostaną pominięte.`
                : '';
            if (!confirm(`Znaleziono ${mismatches.length} ZR w AZR z innym zestawem lub liczbą pojazdów.\n\nZaktualizować je tak, aby pojazdy były dokładnie takie jak w ZR o tej samej nazwie w innych kategoriach?${conflictNote}`)) {
                setStatus(`Sprawdzono ${checkedTargets} ZR w AZR. Do aktualizacji: ${mismatches.length}. Aktualizacja anulowana.`, 'warning');
                return;
            }

            let updated = 0;
            let updateErrors = 0;
            for (let i = 0; i < mismatches.length; i++) {
                const item = mismatches[i];
                if (button) button.textContent = `Aktualizuję ${i + 1}/${mismatches.length}…`;
                setStatus(`Aktualizuję AZR ${i + 1}/${mismatches.length}: „${item.name}”…`, 'info');
                try {
                    await applyVehicleSnapshotToAZR(item.target.id, item.sourceSnapshot);
                    await new Promise(r => setTimeout(r, 120));
                    const verify = await readVehicleRequirementSnapshot(item.target.id);
                    if (!vehicleSnapshotsEqual(item.sourceSnapshot, verify)) {
                        throw new Error('Weryfikacja pojazdów po zapisie nie powiodła się.');
                    }
                    updated++;
                } catch (e) {
                    console.error(TAG, `Błąd aktualizacji pojazdów AZR ${item.target.id}`, e);
                    updateErrors++;
                    state.azrUpdateErrors.push({
                        targetId: item.target.id,
                        name: item.name,
                        sourceId: item.source.id,
                        sourceCategory: getCategoryName(item.source.aao_category_id),
                        message: String(e?.message || e || 'Nieznany błąd')
                    });
                    renderAZRUpdateErrors();
                }
            }

            state.aaos = await fetchAAOListNormalized();
            renderMissingAZRTable();
            const parts = [
                `Sprawdzono: ${checkedTargets}`,
                `bez zmian: ${sameTargets}`,
                `zaktualizowano: ${updated}`,
                conflicts.length ? `konflikty źródeł: ${conflicts.length}` : '',
                scanErrors ? `błędy odczytu: ${scanErrors}` : '',
                updateErrors ? `błędy aktualizacji: ${updateErrors}` : ''
            ].filter(Boolean);
            setStatus(`Synchronizacja pojazdów AZR zakończona. ${parts.join(' • ')}.`, conflicts.length || scanErrors || updateErrors ? 'warning' : 'success');
            renderAZRUpdateErrors();
        } finally {
            state.azrVehicleSyncing = false;
            if (button && document.contains(button)) button.textContent = '🔄 Sprawdź i aktualizuj pojazdy AZR';
            updateMissingAZRButtons();
            updateStats();
        }
    }

    function duplicateNameKey(caption) {
        // Przy duplikatach nie usuwamy spacji z końca nazwy — do tego służy
        // osobne wyszukiwanie. Ignorujemy jedynie wielkość liter.
        return String(caption ?? '').toLocaleLowerCase('pl-PL');
    }

    function isAZRCategory(aao) {
        // AZR rozpoznajemy wyłącznie po dokładnej nazwie kategorii.
        return aao.aao_category_id != null && getCategoryName(aao.aao_category_id) === 'AZR';
    }

    function duplicateScopeRows(scope) {
        if (scope === 'exclude-azr-none') {
            return state.aaos.filter(aao => aao.aao_category_id != null && !isAZRCategory(aao));
        }
        if (scope === 'only-azr') {
            return state.aaos.filter(isAZRCategory);
        }
        return [...state.aaos];
    }

    function duplicateScopeLabel(scope) {
        if (scope === 'exclude-azr-none') return 'z pominięciem AZR i Bez kategorii';
        if (scope === 'only-azr') return 'tylko w kategorii AZR';
        return 'we wszystkich kategoriach';
    }

    function findDuplicateNames(scope = 'all') {
        const sourceRows = duplicateScopeRows(scope);
        const groups = new Map();
        for (const aao of sourceRows) {
            if (!String(aao.caption ?? '').length) continue;
            const key = duplicateNameKey(aao.caption);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(aao);
        }

        const results = [];
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const sorted = [...group].sort((a, b) => a.id - b.id);
            for (const aao of sorted) {
                results.push({
                    aao,
                    issue: `Duplikat nazwy — ${group.length} ZR`,
                    groupSize: group.length
                });
            }
        }

        results.sort((a, b) =>
            a.aao.caption.localeCompare(b.aao.caption, 'pl', { numeric: true, sensitivity: 'base' }) ||
            a.aao.id - b.aao.id
        );
        state.cleanupResults = results;
        state.cleanupMode = `duplicates:${scope}`;
        state.cleanupSelected.clear();
        renderCleanupTable();
        const scopeLabel = duplicateScopeLabel(scope);
        setStatus(
            results.length
                ? `Znaleziono ${results.length} ZR należących do grup duplikatów nazw — ${scopeLabel}.`
                : `Nie znaleziono duplikatów nazw ZR — ${scopeLabel}.`,
            results.length ? 'warning' : 'success'
        );
    }

    function trailingWhitespaceCount(text) {
        const match = String(text ?? '').match(/[\s\u00a0]+$/u);
        return match ? [...match[0]].length : 0;
    }

    function visibleNameWithTrailingMarks(text) {
        const raw = String(text ?? '');
        const match = raw.match(/[\s\u00a0]+$/u);
        if (!match) return escapeHTML(raw);
        const body = raw.slice(0, raw.length - match[0].length);
        const marks = [...match[0]].map(ch => ch === '\u00a0' ? '⍽' : ch === '\t' ? '⇥' : '␠').join('');
        return `${escapeHTML(body)}<span class="orzr-whitespace-mark">${escapeHTML(marks)}</span>`;
    }

    function findTrailingSpaces() {
        const results = state.aaos
            .map(aao => ({ aao, count: trailingWhitespaceCount(aao.caption) }))
            .filter(x => x.count > 0)
            .map(x => ({
                aao: x.aao,
                issue: `Białe znaki na końcu nazwy: ${x.count}`,
                trailingCount: x.count
            }))
            .sort((a, b) =>
                a.aao.caption.localeCompare(b.aao.caption, 'pl', { numeric: true, sensitivity: 'base' }) ||
                a.aao.id - b.aao.id
            );

        state.cleanupResults = results;
        state.cleanupMode = 'trailing';
        state.cleanupSelected.clear();
        renderCleanupTable();
        setStatus(
            results.length
                ? `Znaleziono ${results.length} ZR ze spacją lub innym białym znakiem na końcu nazwy.`
                : 'Nie znaleziono spacji ani innych białych znaków na końcu nazw ZR.',
            results.length ? 'warning' : 'success'
        );
    }


    function removeTrailingWhitespaceFromName(text) {
        return String(text ?? '').replace(/[\s\u00a0]+$/u, '');
    }

    async function removeTrailingWhitespaceFromAll() {
        if (state.saving) return;
        const targets = state.aaos
            .map(aao => ({ aao, cleaned: removeTrailingWhitespaceFromName(aao.caption) }))
            .filter(x => x.cleaned !== x.aao.caption);

        if (!targets.length) {
            state.cleanupResults = [];
            state.cleanupMode = 'trailing';
            state.cleanupSelected.clear();
            renderCleanupTable();
            setStatus('Nie znaleziono białych znaków ani spacji na końcu nazw ZR.', 'success');
            return;
        }

        if (!confirm(`Usunąć białe znaki i spacje z końca nazw ${targets.length} ZR?\n\nNormalne spacje wewnątrz nazw pozostaną bez zmian.`)) return;

        const button = document.getElementById('orzr-remove-trailing-spaces');
        const oldText = button?.textContent;
        state.saving = true;
        updateSaveAllButton();
        if (button) {
            button.disabled = true;
            button.textContent = `Czyszczę 0/${targets.length}…`;
        }

        let ok = 0;
        let failed = 0;
        try {
            for (let i = 0; i < targets.length; i++) {
                const { aao, cleaned } = targets[i];
                if (button) button.textContent = `Czyszczę ${i + 1}/${targets.length}…`;
                setStatus(`Czyszczę ${i + 1}/${targets.length}: „${aao.caption}”…`, 'info');
                const values = {
                    caption: cleaned,
                    column: Number(aao.column) || 1,
                    aao_category_id: aao.aao_category_id
                };
                try {
                    await saveViaNativeEditor(aao.id, values);
                    await new Promise(r => setTimeout(r, 120));
                    if (!await verifySaved(aao.id, values)) throw new Error('Weryfikacja zapisu nie powiodła się.');
                    aao.caption = cleaned;
                    state.dirty.delete(aao.id);
                    ok++;
                } catch (e) {
                    console.error(TAG, `Błąd czyszczenia nazwy ZR ${aao.id}`, e);
                    failed++;
                }
            }

            const remaining = state.aaos
                .map(aao => ({ aao, count: trailingWhitespaceCount(aao.caption) }))
                .filter(x => x.count > 0)
                .map(x => ({
                    aao: x.aao,
                    issue: `Białe znaki na końcu nazwy: ${x.count}`,
                    trailingCount: x.count
                }))
                .sort((a, b) => a.aao.caption.localeCompare(b.aao.caption, 'pl', { numeric: true, sensitivity: 'base' }) || a.aao.id - b.aao.id);
            state.cleanupResults = remaining;
            state.cleanupMode = 'trailing';
            state.cleanupSelected.clear();
            renderCleanupTable();
            setStatus(
                failed
                    ? `Usunięto białe znaki i spacje z ${ok} nazw. Błędy: ${failed}.`
                    : `Usunięto białe znaki i spacje z końca ${ok} nazw ZR.`,
                failed ? 'warning' : 'success'
            );
        } finally {
            state.saving = false;
            updateSaveAllButton();
            if (button && document.contains(button)) {
                button.disabled = false;
                button.textContent = oldText || 'Usuń białe znaki i spacje';
            }
            updateStats();
        }
    }

    function csvCell(value) {
        const text = String(value ?? '').replace(/\r?\n/g, ' ');
        return `"${text.replaceAll('"', '""')}"`;
    }

    function exportAllAAOsToCSV() {
        if (!state.aaos.length) {
            setStatus('Brak ZR do eksportu.', 'warning');
            return;
        }

        const rows = [...state.aaos].sort((a, b) =>
            a.caption.localeCompare(b.caption, 'pl', { numeric: true, sensitivity: 'base' }) || a.id - b.id
        );
        const lines = [
            ['ID', 'Nazwa ZR', 'Nr kolumny', 'Kategoria', 'ID kategorii'].map(csvCell).join(';'),
            ...rows.map(aao => [
                aao.id,
                aao.caption,
                aao.column,
                getCategoryName(aao.aao_category_id),
                aao.aao_category_id == null ? '' : aao.aao_category_id
            ].map(csvCell).join(';'))
        ];
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const d = new Date();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        link.href = url;
        link.download = `menedzer-zr-lista-${date}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(`Wyeksportowano ${rows.length} ZR do CSV.`, 'success');
    }

    function cleanupVisibleIds() {
        return state.cleanupResults.map(item => Number(item.aao.id)).filter(Number.isFinite);
    }

    function updateCleanupSelectionUI() {
        const ids = cleanupVisibleIds();
        for (const id of [...state.cleanupSelected]) {
            if (!ids.includes(id)) state.cleanupSelected.delete(id);
        }

        const selectedCount = ids.filter(id => state.cleanupSelected.has(id)).length;
        const deleteSelected = document.getElementById('orzr-delete-selected');
        if (deleteSelected) {
            deleteSelected.disabled = state.deleting || selectedCount === 0;
            deleteSelected.textContent = state.deleting
                ? 'Usuwanie…'
                : `🗑 Usuń zaznaczone (${selectedCount})`;
        }

        document.querySelectorAll('.orzr-delete-row').forEach(btn => {
            btn.disabled = state.deleting;
        });
        document.querySelectorAll('.orzr-cleanup-select').forEach(cb => {
            cb.disabled = state.deleting;
        });

        const all = document.getElementById('orzr-cleanup-select-all');
        if (all) {
            all.disabled = state.deleting || ids.length === 0;
            all.checked = ids.length > 0 && selectedCount === ids.length;
            all.indeterminate = selectedCount > 0 && selectedCount < ids.length;
        }
    }

    function bindCleanupEvents() {
        document.querySelectorAll('.orzr-cleanup-select').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = Number(cb.dataset.id);
                if (cb.checked) state.cleanupSelected.add(id);
                else state.cleanupSelected.delete(id);
                updateCleanupSelectionUI();
            });
        });

        document.querySelectorAll('.orzr-delete-row').forEach(btn => {
            btn.addEventListener('click', () => deleteOneCleanup(Number(btn.dataset.id), btn));
        });

        const all = document.getElementById('orzr-cleanup-select-all');
        if (all) {
            all.onchange = () => {
                const ids = cleanupVisibleIds();
                for (const id of ids) {
                    if (all.checked) state.cleanupSelected.add(id);
                    else state.cleanupSelected.delete(id);
                }
                renderCleanupTable();
            };
        }
    }

    function renderCleanupTable() {
        const tbody = document.getElementById('orzr-cleanup-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        const empty = document.getElementById('orzr-cleanup-empty');
        if (empty) {
            empty.hidden = state.cleanupResults.length > 0;
            if (!state.cleanupMode) empty.textContent = 'Wybierz jedną z operacji porządkowania powyżej.';
            else if (String(state.cleanupMode).startsWith('duplicates:')) empty.textContent = 'Nie znaleziono duplikatów nazw ZR.';
            else empty.textContent = 'Nie znaleziono spacji ani innych białych znaków na końcu nazw ZR.';
        }

        const resultIds = new Set(cleanupVisibleIds());
        for (const id of [...state.cleanupSelected]) {
            if (!resultIds.has(id)) state.cleanupSelected.delete(id);
        }

        for (const item of state.cleanupResults) {
            const aao = item.aao;
            const tr = document.createElement('tr');
            tr.dataset.zrId = aao.id;
            const name = state.cleanupMode === 'trailing'
                ? visibleNameWithTrailingMarks(aao.caption)
                : escapeHTML(aao.caption);
            tr.innerHTML = `
                <td class="orzr-cleanup-check"><input type="checkbox" class="orzr-cleanup-select" data-id="${aao.id}" ${state.cleanupSelected.has(aao.id) ? 'checked' : ''}></td>
                <td class="orzr-id">${aao.id}</td>
                <td class="orzr-cleanup-name">${name}</td>
                <td>${Number(aao.column) || 1}</td>
                <td>${escapeHTML(getCategoryName(aao.aao_category_id))}</td>
                <td>${escapeHTML(item.issue)}</td>
                <td class="orzr-actions">
                    <a class="btn btn-default btn-sm" href="/aaos/${aao.id}/edit">✎ Edycja</a>
                    <button type="button" class="btn btn-danger btn-sm orzr-delete-row" data-id="${aao.id}">🗑 Usuń</button>
                </td>`;
            tbody.appendChild(tr);
        }
        bindCleanupEvents();
        updateCleanupSelectionUI();
        updateStats();
    }

    async function submitDeleteRequestFromDocument(id, doc) {
        const expectedPath = `/aaos/${id}`;
        const forms = [...doc.querySelectorAll('form')];
        const deleteForm = forms.find(form => {
            let path = '';
            try { path = new URL(form.getAttribute('action') || form.action || '', location.origin).pathname; } catch (_) {}
            const override = form.querySelector('input[name="_method"]')?.value || '';
            const text = `${form.textContent || ''} ${form.querySelector('input[type="submit"]')?.value || ''}`;
            return path === expectedPath && (/delete/i.test(override) || /usuń|delete/i.test(text));
        });

        if (deleteForm) {
            const action = deleteForm.getAttribute('action') || deleteForm.action || expectedPath;
            const method = (deleteForm.getAttribute('method') || 'post').toUpperCase();
            const body = new FormData(deleteForm);
            if (!body.get('_method') && method === 'POST') body.set('_method', 'delete');
            const response = await fetch(action, {
                method,
                body,
                credentials: 'same-origin',
                redirect: 'follow',
                headers: { Accept: 'text/html,application/xhtml+xml' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} podczas usuwania ZR.`);
            return;
        }

        const deleteLink = [...doc.querySelectorAll('a[href]')].find(link => {
            let path = '';
            try { path = new URL(link.href, location.origin).pathname; } catch (_) {}
            const method = link.getAttribute('data-method') || link.getAttribute('data-turbo-method') || '';
            return path === expectedPath && (/delete/i.test(method) || /usuń|delete/i.test(link.textContent || ''));
        });

        const href = deleteLink?.href || expectedPath;
        const token = doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
            || document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
            || '';
        const params = new URLSearchParams();
        params.set('_method', 'delete');
        if (token) params.set('authenticity_token', token);
        const headers = {
            Accept: 'text/html,application/xhtml+xml',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        };
        if (token) headers['X-CSRF-Token'] = token;
        const response = await fetch(href, {
            method: 'POST',
            body: params.toString(),
            credentials: 'same-origin',
            redirect: 'follow',
            headers
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} podczas usuwania ZR.`);
    }

    async function deleteViaNativeEditor(id) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:10px;height:10px;border:0;opacity:0;pointer-events:none';
        frame.src = `/aaos/${id}/edit`;
        document.body.appendChild(frame);
        try {
            await waitForFrameLoad(frame);
            const doc = frame.contentDocument;
            if (!doc) throw new Error('Nie można otworzyć formularza edycji ZR.');
            await submitDeleteRequestFromDocument(id, doc);

            // Sprawdzamy na liście API, czy ZR rzeczywiście zniknął.
            for (let attempt = 0; attempt < 6; attempt++) {
                if (attempt) await new Promise(r => setTimeout(r, 180));
                const list = await fetchAAOListNormalized();
                if (!list.some(aao => aao.id === id)) return list;
            }
            throw new Error('ZR nadal znajduje się na liście po próbie usunięcia.');
        } finally {
            setTimeout(() => frame.remove(), 50);
        }
    }

    function refreshCleanupResultsAfterDelete() {
        const mode = state.cleanupMode;
        if (String(mode).startsWith('duplicates:')) {
            const scope = String(mode).split(':')[1] || 'all';
            findDuplicateNames(scope);
            return;
        }
        if (mode === 'trailing') {
            findTrailingSpaces();
            return;
        }
        state.cleanupResults = state.cleanupResults.filter(item => state.aaos.some(aao => aao.id === item.aao.id));
        state.cleanupSelected.clear();
        renderCleanupTable();
    }

    async function deleteOneCleanup(id, button = null) {
        if (state.deleting) return;
        const aao = state.aaos.find(x => x.id === id);
        if (!aao) return;
        if (!confirm(`Usunąć ZR „${aao.caption}” (ID ${aao.id})?\n\nTej operacji nie można cofnąć.`)) return;

        state.deleting = true;
        const oldText = button?.textContent;
        if (button) button.textContent = 'Usuwam…';
        updateCleanupSelectionUI();
        try {
            setStatus(`Usuwam ZR „${aao.caption}”…`, 'info');
            state.aaos = await deleteViaNativeEditor(id);
            state.dirty.delete(id);
            state.copyTargets.delete(id);
            state.cleanupSelected.delete(id);
            refreshCleanupResultsAfterDelete();
            setStatus(`Usunięto ZR „${aao.caption}” (ID ${id}).`, 'success');
        } catch (e) {
            console.error(TAG, e);
            setStatus(`Błąd usuwania ZR ${id}: ${e.message || e}`, 'danger');
        } finally {
            state.deleting = false;
            if (button && document.contains(button)) button.textContent = oldText || '🗑 Usuń';
            updateCleanupSelectionUI();
            updateStats();
        }
    }

    async function deleteSelectedCleanup() {
        if (state.deleting) return;
        const ids = cleanupVisibleIds().filter(id => state.cleanupSelected.has(id));
        if (!ids.length) {
            setStatus('Nie zaznaczono żadnych ZR do usunięcia.', 'warning');
            return;
        }
        if (!confirm(`Usunąć zaznaczone ZR (${ids.length})?\n\nTej operacji nie można cofnąć.`)) return;

        state.deleting = true;
        updateCleanupSelectionUI();
        let ok = 0;
        let failed = 0;
        const failedIds = [];
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                const aao = state.aaos.find(x => x.id === id);
                setStatus(`Usuwam ${i + 1}/${ids.length}: „${aao?.caption ?? `ID ${id}`}”…`, 'info');
                try {
                    state.aaos = await deleteViaNativeEditor(id);
                    state.dirty.delete(id);
                    state.copyTargets.delete(id);
                    state.cleanupSelected.delete(id);
                    ok++;
                } catch (e) {
                    console.error(TAG, `Błąd usuwania ZR ${id}`, e);
                    failed++;
                    failedIds.push(id);
                }
            }

            refreshCleanupResultsAfterDelete();
            setStatus(
                failed
                    ? `Usunięto ${ok} ZR. Błędy: ${failed}${failedIds.length ? ` (ID: ${failedIds.join(', ')})` : ''}.`
                    : `Usunięto wszystkie zaznaczone ZR: ${ok}.`,
                failed ? 'warning' : 'success'
            );
        } finally {
            state.deleting = false;
            updateCleanupSelectionUI();
            updateStats();
        }
    }

    async function copyOne(id, button = null) {
        if (state.copying) return;
        const source = state.aaos.find(x => x.id === id);
        const target = getCopyTarget(id);
        if (!source || !target) return;

        state.copying = true;
        const oldText = button?.textContent;
        if (button) button.textContent = 'Kopiuję…';
        updateCopyButtons();

        const knownIds = new Set(state.aaos.map(x => x.id));
        try {
            setStatus(
                `Kopiuję ZR „${source.caption}” → kolumna ${target.column}, ${getCategoryName(target.aao_category_id)}…`,
                'info'
            );
            await copyViaNativeEditor(id, target);
            const created = await findNewCopy(source, target, knownIds);
            if (created) {
                state.aaos.push(created);
                setStatus(
                    `Skopiowano „${source.caption}” do kolumny ${target.column}, ${getCategoryName(target.aao_category_id)}. Nowe ID: ${created.id}.`,
                    'success'
                );
            } else {
                setStatus(
                    `Kopiowanie „${source.caption}” zostało wysłane. Jeśli nowa kopia nie pojawi się od razu, użyj „Odśwież”.`,
                    'success'
                );
            }
            renderCopyTable();
        } catch (e) {
            console.error(TAG, e);
            setStatus(`Błąd kopiowania ZR ${id}: ${e.message || e}`, 'danger');
        } finally {
            state.copying = false;
            if (button && document.contains(button)) button.textContent = oldText || '⧉ Kopiuj';
            updateCopyButtons();
        }
    }

    function renderActiveTable() {
        const listTable = document.getElementById('orzr-table');
        const copyTable = document.getElementById('orzr-copy-table');
        const cleanupTable = document.getElementById('orzr-cleanup-table');
        const missingAZRTable = document.getElementById('orzr-missing-azr-table');
        const saveAll = document.getElementById('orzr-save-all');
        const changedStat = document.getElementById('orzr-changed-stat');
        const copyBulk = document.getElementById('orzr-copy-bulk');
        const cleanupTools = document.getElementById('orzr-cleanup-tools');
        const missingAZRTools = document.getElementById('orzr-missing-azr-tools');
        const azrUpdateErrors = document.getElementById('orzr-azr-update-errors');
        const toolbar = document.getElementById('orzr-toolbar');
        const normalEmpty = document.getElementById('orzr-empty');
        const cleanupEmpty = document.getElementById('orzr-cleanup-empty');
        const missingAZREmpty = document.getElementById('orzr-missing-azr-empty');
        const shownLabel = document.getElementById('orzr-shown-label');

        const copying = state.activeTab === 'copy';
        const cleaning = state.activeTab === 'cleanup';
        const missingAZR = state.activeTab === 'missing-azr';
        const listing = state.activeTab === 'list';

        if (listTable) listTable.hidden = !listing;
        if (copyTable) copyTable.hidden = !copying;
        if (cleanupTable) cleanupTable.hidden = !cleaning;
        if (missingAZRTable) missingAZRTable.hidden = !missingAZR;
        if (copyBulk) copyBulk.hidden = !copying;
        if (cleanupTools) cleanupTools.hidden = !cleaning;
        if (missingAZRTools) missingAZRTools.hidden = !missingAZR;
        if (azrUpdateErrors) azrUpdateErrors.hidden = !missingAZR || state.azrUpdateErrors.length === 0;
        if (toolbar) toolbar.hidden = cleaning || missingAZR;
        if (saveAll) saveAll.hidden = !listing;
        if (changedStat) changedStat.hidden = !listing;
        if (normalEmpty && (cleaning || missingAZR)) normalEmpty.hidden = true;
        if (cleanupEmpty && !cleaning) cleanupEmpty.hidden = true;
        if (missingAZREmpty && !missingAZR) missingAZREmpty.hidden = true;
        if (shownLabel) shownLabel.textContent = cleaning ? 'Wyników' : missingAZR ? 'Brakuje w AZR' : 'Widocznych';

        if (copying) renderCopyTable();
        else if (cleaning) renderCleanupTable();
        else if (missingAZR) {
            renderMissingAZRTable();
            renderAZRUpdateErrors();
        } else renderTable();

        document.querySelectorAll('.orzr-tab').forEach(btn => {
            btn.classList.toggle('orzr-tab-active', btn.dataset.tab === state.activeTab);
        });
    }

    function setActiveTab(tab) {
        if (!['list', 'copy', 'cleanup', 'missing-azr'].includes(tab)) return;
        state.activeTab = tab;
        setStatus('', 'info');
        renderActiveTable();
    }

    function setStatus(text, type = 'info') {
        const el = document.getElementById('orzr-status');
        if (!el) return;
        el.hidden = !text;
        el.className = `orzr-status orzr-status-${type}`;
        el.textContent = text;
    }

    function updateStats() {
        const total = document.getElementById('orzr-stat-total');
        const shown = document.getElementById('orzr-stat-shown');
        const changed = document.getElementById('orzr-stat-changed');
        if (total) total.textContent = state.aaos.length;
        if (shown) shown.textContent = state.activeTab === 'cleanup'
            ? state.cleanupResults.length
            : state.activeTab === 'missing-azr'
                ? getMissingInAZRRows().length
                : sortedFilteredAAOs(state.activeTab).length;
        if (changed) changed.textContent = state.dirty.size;
    }

    function updateSaveAllButton() {
        const btn = document.getElementById('orzr-save-all');
        if (!btn) return;
        btn.disabled = state.saving || state.dirty.size === 0;
        btn.textContent = state.saving ? 'Zapisywanie…' : `💾 Zapisz zmienione (${state.dirty.size})`;
    }

    function populateCategoryFilter() {
        const select = document.getElementById('orzr-filter-category');
        if (!select) return;
        const old = state.categoryFilter;
        select.innerHTML = '<option value="all">Wszystkie kategorie</option><option value="with">Wszystkie z kategorią</option><option value="none">Bez kategorii</option>';
        for (const [id, name] of [...state.categories.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pl'))) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name;
            select.appendChild(opt);
        }
        select.value = [...select.options].some(o => o.value === old) ? old : 'all';

        const bulkCategory = document.getElementById('orzr-copy-all-category');
        if (bulkCategory) {
            const previous = bulkCategory.value;
            bulkCategory.innerHTML = categoryOptions(previous === '' ? null : Number(previous));
            if ([...bulkCategory.options].some(o => o.value === previous)) bulkCategory.value = previous;
        }
    }

    function waitForFrameLoad(frame, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Przekroczono czas ładowania edycji ZR.')), timeoutMs);
            frame.addEventListener('load', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
        });
    }

    const findCaptionField = doc => doc.querySelector('#aao_caption, input[name="aao[caption]"]');
    const findColumnField = doc => doc.querySelector('#aao_column_number, select[name="aao[column]"], input[name="aao[column]"], select[name="aao[column_number]"], input[name="aao[column_number]"]');
    const findCategoryField = doc => doc.querySelector('#aao_category_id, #aao_aao_category_id, select[name="aao[aao_category_id]"], select[name="aao_category_id"]');

    function setNativeValue(el, value) {
        el.value = value == null ? '' : String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function saveViaNativeEditor(id, values) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:10px;height:10px;border:0;opacity:0;pointer-events:none';
        frame.src = `/aaos/${id}/edit`;
        document.body.appendChild(frame);
        try {
            await waitForFrameLoad(frame);
            const doc = frame.contentDocument;
            if (!doc) throw new Error('Nie można otworzyć formularza edycji ZR.');
            const form = doc.querySelector('form[action*="/aaos/"]') || doc.querySelector('form');
            if (!form) throw new Error('Nie znaleziono formularza edycji ZR.');
            const caption = findCaptionField(doc), column = findColumnField(doc), category = findCategoryField(doc);
            if (!caption) throw new Error('Nie znaleziono pola nazwy ZR.');
            if (!column) throw new Error('Nie znaleziono pola numeru kolumny.');
            if (!category) throw new Error('Nie znaleziono pola kategorii.');
            setNativeValue(caption, values.caption);
            setNativeValue(column, values.column);
            setNativeValue(category, values.aao_category_id);
            const secondLoad = waitForFrameLoad(frame);
            const submit = doc.querySelector('#save-button') || form.querySelector('button[type="submit"], input[type="submit"]');
            if (submit) submit.click();
            else if (form.requestSubmit) form.requestSubmit();
            else form.submit();
            await secondLoad;
        } finally {
            setTimeout(() => frame.remove(), 50);
        }
    }

    async function verifySaved(id, expected) {
        try {
            const raw = await fetchJSON(`/api/v1/aaos/${id}`);
            const actual = raw?.result ?? raw;
            if (!actual || typeof actual !== 'object') return true;
            const cat = actual.aao_category_id == null || actual.aao_category_id === '' ? null : Number(actual.aao_category_id);
            return String(actual.caption ?? '') === String(expected.caption) &&
                Number(actual.column) === Number(expected.column) &&
                cat === expected.aao_category_id;
        } catch (e) {
            console.warn(TAG, 'Weryfikacja API nie powiodła się:', e);
            return true;
        }
    }

    async function saveOne(id, button = null) {
        if (state.saving) return;
        const base = state.aaos.find(x => x.id === id);
        if (!base || !state.dirty.has(id)) return;
        const values = currentRowValues(id);
        const old = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = 'Zapisywanie…';
        }
        try {
            setStatus(`Zapisuję ZR „${base.caption}”…`, 'info');
            await saveViaNativeEditor(id, values);
            await new Promise(r => setTimeout(r, 250));
            if (!await verifySaved(id, values)) throw new Error('Gra nie zwróciła zapisanych wartości.');
            Object.assign(base, {
                caption: values.caption,
                column: Number(values.column),
                aao_category_id: values.aao_category_id
            });
            state.dirty.delete(id);
            setStatus(`Zapisano: ${base.caption}`, 'success');
            renderActiveTable();
            updateSaveAllButton();
        } catch (e) {
            console.error(TAG, e);
            setStatus(`Błąd zapisu ZR ${id}: ${e.message || e}`, 'danger');
            if (button) {
                button.disabled = false;
                button.textContent = old || '💾 Zapisz';
            }
        }
    }

    async function saveAllChanged() {
        if (state.saving || !state.dirty.size) return;
        state.saving = true;
        updateSaveAllButton();
        const ids = [...state.dirty.keys()];
        let ok = 0, failed = 0;
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                const base = state.aaos.find(x => x.id === id);
                const values = currentRowValues(id);
                if (!base || !values) continue;
                setStatus(`Zapisuję ${i + 1}/${ids.length}: ${base.caption}…`, 'info');
                try {
                    await saveViaNativeEditor(id, values);
                    await new Promise(r => setTimeout(r, 150));
                    if (!await verifySaved(id, values)) throw new Error('Weryfikacja zapisu nie powiodła się.');
                    Object.assign(base, {
                        caption: values.caption,
                        column: Number(values.column),
                        aao_category_id: values.aao_category_id
                    });
                    state.dirty.delete(id);
                    ok++;
                } catch (e) {
                    console.error(TAG, `Błąd ZR ${id}`, e);
                    failed++;
                }
            }
            renderActiveTable();
            setStatus(
                failed ? `Zapisano ${ok}. Błędy: ${failed}.` : `Zapisano wszystkie zmiany: ${ok} ZR.`,
                failed ? 'warning' : 'success'
            );
        } finally {
            state.saving = false;
            updateSaveAllButton();
        }
    }

    function createStyles() {
        if (document.getElementById('orzr-manager-style')) return;
        const style = document.createElement('style');
        style.id = 'orzr-manager-style';
        style.textContent = `
#orzr-launcher{
    position:fixed;
    right:360px;
    bottom:18px;
    z-index:99990;
    border:0;
    border-radius:999px;
    padding:11px 16px;
    background:#337ab7;
    color:#fff;
    font:600 13px/1.2 Arial,sans-serif;
    font-weight:700;
    box-shadow:0 4px 16px rgba(0,0,0,.28);
    cursor:pointer;
}
#orzr-launcher:hover{filter:brightness(1.08)}
#orzr-manager-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);padding:22px;display:none}
#orzr-manager-overlay.orzr-open{display:block}
#orzr-manager{max-width:1750px;height:calc(100vh - 44px);margin:0 auto;background:#fff;color:#222;border-radius:7px;box-shadow:0 4px 20px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;font-family:Arial,sans-serif}
#orzr-manager-header{padding:12px 14px;background:#333;color:#fff;display:flex;align-items:center;gap:12px}
#orzr-manager-header h3{margin:0;font-size:20px;flex:1}
#orzr-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid #ddd;background:#f7f7f7}
.orzr-tab{border:1px solid #ccc;border-bottom:0;border-radius:5px 5px 0 0;background:#e9e9e9;padding:8px 16px;font-weight:700;cursor:pointer}
.orzr-tab.orzr-tab-active{background:#fff;color:#337ab7;position:relative;top:1px}
#orzr-close{border:0;background:transparent;color:#fff;font-size:26px;cursor:pointer}
#orzr-toolbar{display:grid;grid-template-columns:minmax(280px,1fr) 240px 230px auto auto;gap:8px;padding:10px 12px;border-bottom:1px solid #ddd;align-items:center}
#orzr-toolbar input,#orzr-toolbar select{width:100%}
#orzr-toolbar[hidden]{display:none}
#orzr-stats{padding:7px 12px;background:#f5f5f5;border-bottom:1px solid #ddd;font-size:12px}
#orzr-copy-bulk{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:9px 12px;background:#f7f7f7;border-bottom:1px solid #ddd}
#orzr-copy-bulk[hidden]{display:none}
#orzr-cleanup-tools,#orzr-missing-azr-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;background:#f7f7f7;border-bottom:1px solid #ddd}
#orzr-cleanup-tools[hidden],#orzr-missing-azr-tools[hidden]{display:none}
#orzr-cleanup-tools .btn{white-space:nowrap}
.orzr-cleanup-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-right:10px;border-right:1px solid #ddd}
.orzr-cleanup-group:last-child{border-right:0}
.orzr-copy-bulk-group{display:flex;align-items:center;gap:7px;flex-wrap:nowrap}
.orzr-copy-bulk-group strong{white-space:nowrap}
#orzr-copy-all-column{width:95px}
#orzr-copy-all-category{width:300px;min-width:220px;max-width:300px}
#orzr-copy-all-visible{white-space:nowrap}
.orzr-copy-bulk-note{font-size:12px;color:#666;flex-basis:100%}
.orzr-status{margin:8px 12px 0;padding:8px 10px;border-radius:4px;font-size:13px}
.orzr-status-info{background:#d9edf7;border:1px solid #bce8f1}
.orzr-status-success{background:#dff0d8;border:1px solid #d6e9c6}
.orzr-status-warning{background:#fcf8e3;border:1px solid #faebcc}
.orzr-status-danger{background:#f2dede;border:1px solid #ebccd1}
#orzr-table-wrap{flex:1;overflow:auto;padding:8px 12px 12px}
#orzr-table,#orzr-copy-table,#orzr-cleanup-table,#orzr-missing-azr-table,#orzr-azr-update-errors-table{width:100%;border-collapse:collapse;table-layout:fixed}
#orzr-table th,#orzr-copy-table th,#orzr-cleanup-table th,#orzr-missing-azr-table th,#orzr-azr-update-errors-table th{position:sticky;top:0;z-index:2;background:#eee;border:1px solid #ccc;padding:7px;text-align:left}
#orzr-table td,#orzr-copy-table td,#orzr-cleanup-table td,#orzr-missing-azr-table td,#orzr-azr-update-errors-table td{border:1px solid #ddd;padding:5px 7px;vertical-align:middle}
#orzr-table tbody tr.orzr-dirty td{background:#fff8dc}
#orzr-table th:nth-child(1),#orzr-table td:nth-child(1){width:85px}
#orzr-table th:nth-child(3),#orzr-table td:nth-child(3){width:120px}
#orzr-table th:nth-child(4),#orzr-table td:nth-child(4){width:280px}
#orzr-table th:nth-child(5),#orzr-table td:nth-child(5){width:210px}
#orzr-copy-table th:nth-child(1),#orzr-copy-table td:nth-child(1){width:80px}
#orzr-copy-table th:nth-child(3),#orzr-copy-table td:nth-child(3){width:110px}
#orzr-copy-table th:nth-child(4),#orzr-copy-table td:nth-child(4){width:230px}
#orzr-copy-table th:nth-child(5),#orzr-copy-table td:nth-child(5){width:115px;text-align:center}
#orzr-copy-table th:nth-child(6),#orzr-copy-table td:nth-child(6){width:155px}
#orzr-copy-table th:nth-child(7),#orzr-copy-table td:nth-child(7){width:250px}
#orzr-copy-table select:disabled,#orzr-copy-table input:read-only{background:#f7f7f7;color:#555;opacity:1}
#orzr-cleanup-table th:nth-child(1),#orzr-cleanup-table td:nth-child(1){width:62px;text-align:center}
#orzr-cleanup-table th:nth-child(2),#orzr-cleanup-table td:nth-child(2){width:85px}
#orzr-cleanup-table th:nth-child(4),#orzr-cleanup-table td:nth-child(4){width:120px}
#orzr-cleanup-table th:nth-child(5),#orzr-cleanup-table td:nth-child(5){width:240px}
#orzr-cleanup-table th:nth-child(6),#orzr-cleanup-table td:nth-child(6){width:240px}
#orzr-cleanup-table th:nth-child(7),#orzr-cleanup-table td:nth-child(7){width:190px}
.orzr-cleanup-check input{width:18px;height:18px;cursor:pointer}
.orzr-cleanup-name{white-space:pre-wrap;overflow-wrap:anywhere}
.orzr-whitespace-mark{background:#f2dede;color:#a94442;font-family:monospace;font-weight:700;padding:0 2px;border-radius:2px}
#orzr-cleanup-empty,#orzr-missing-azr-empty{padding:30px;text-align:center;color:#777}
#orzr-missing-azr-table th:nth-child(1),#orzr-missing-azr-table td:nth-child(1){width:85px}
#orzr-missing-azr-table th:nth-child(3),#orzr-missing-azr-table td:nth-child(3){width:120px}
#orzr-missing-azr-table th:nth-child(4),#orzr-missing-azr-table td:nth-child(4){width:320px}
#orzr-missing-azr-table th:nth-child(5),#orzr-missing-azr-table td:nth-child(5){width:260px}
.orzr-missing-name{overflow-wrap:anywhere}
.orzr-missing-note{margin-top:3px;font-size:11px;color:#777}
#orzr-missing-azr-copy-all{white-space:nowrap}
.orzr-missing-azr-info{font-size:12px;color:#555}
#orzr-azr-update-errors{margin:0 12px 8px;border:1px solid #ebccd1;background:#fff;border-radius:4px;overflow:hidden}
#orzr-azr-update-errors[hidden]{display:none}
.orzr-azr-update-errors-title{padding:8px 10px;background:#f2dede;color:#a94442;font-weight:700;border-bottom:1px solid #ebccd1}
#orzr-azr-update-errors-table th:nth-child(1),#orzr-azr-update-errors-table td:nth-child(1){width:90px}
#orzr-azr-update-errors-table th:nth-child(3),#orzr-azr-update-errors-table td:nth-child(3){width:90px}
#orzr-azr-update-errors-table th:nth-child(4),#orzr-azr-update-errors-table td:nth-child(4){width:220px}
#orzr-azr-update-errors-table th:nth-child(6),#orzr-azr-update-errors-table td:nth-child(6){width:125px}
.orzr-azr-error-message{white-space:pre-wrap;overflow-wrap:anywhere;color:#a94442}
.orzr-copy-action{white-space:nowrap}
.orzr-actions{white-space:nowrap}
.orzr-actions .btn+.btn{margin-left:4px}
#orzr-empty{padding:30px;text-align:center;color:#777}
@media(max-width:900px){
    #orzr-toolbar{grid-template-columns:1fr 1fr}
    #orzr-manager-overlay{padding:5px}
    #orzr-manager{height:calc(100vh - 10px)}
}`;
        document.head.appendChild(style);
    }

    function findBuildingManagerButton() {
        return document.getElementById('or-building-manager-v01-button') ||
            [...document.querySelectorAll('button')].find(el => /Budynki\s*OR/i.test(el.textContent || '')) ||
            null;
    }

    function positionLauncherNextToBuildings() {
        const launcher = document.getElementById('orzr-launcher');
        if (!launcher) return;

        const buildingButton = findBuildingManagerButton();
        if (!buildingButton) {
            // Awaryjna pozycja: ten sam dolny rząd, z zapasem po lewej.
            launcher.style.right = '360px';
            launcher.style.bottom = '18px';
            return;
        }

        const rect = buildingButton.getBoundingClientRect();
        const gap = 8;
        const right = Math.max(8, window.innerWidth - rect.left + gap);
        const bottom = Math.max(8, window.innerHeight - rect.bottom);

        // ZR Lista trafia bezpośrednio po lewej stronie przycisku Budynki OR.
        launcher.style.right = `${Math.round(right)}px`;
        launcher.style.bottom = `${Math.round(bottom)}px`;
    }

    function startLauncherPositioning() {
        positionLauncherNextToBuildings();
        [100, 300, 700, 1500, 3000].forEach(delay => {
            setTimeout(positionLauncherNextToBuildings, delay);
        });
        window.addEventListener('resize', positionLauncherNextToBuildings, { passive: true });
    }

    function createUI() {
        createStyles();

        if (!document.getElementById('orzr-launcher')) {
            const b = document.createElement('button');
            b.id = 'orzr-launcher';
            b.type = 'button';
            b.textContent = '📋 Menedżer ZR';
            b.title = 'Otwórz Menedżer ZR Lista';
            b.addEventListener('click', openManager);
            document.body.appendChild(b);
            startLauncherPositioning();
        }

        if (document.getElementById('orzr-manager-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'orzr-manager-overlay';
        overlay.innerHTML = `
<div id="orzr-manager">
    <div id="orzr-manager-header">
        <h3>📋 Menedżer ZR Lista <small style="opacity:.7">v${VERSION}</small></h3>
        <button id="orzr-close" type="button">×</button>
    </div>
    <div id="orzr-tabs">
        <button type="button" class="orzr-tab orzr-tab-active" data-tab="list">✎ Lista / edycja</button>
        <button type="button" class="orzr-tab" data-tab="copy">⧉ Kopiuj</button>
        <button type="button" class="orzr-tab" data-tab="missing-azr">🔎 Brakuje w AZR</button>
        <button type="button" class="orzr-tab" data-tab="cleanup">🧹 Porządkowanie</button>
    </div>
    <div id="orzr-toolbar">
        <input id="orzr-search" type="search" class="form-control" placeholder="Szukaj po nazwie, kategorii, kolumnie lub ID…">
        <select id="orzr-filter-category" class="form-control">
            <option value="all">Wszystkie kategorie</option>
            <option value="with">Wszystkie z kategorią</option>
            <option value="none">Bez kategorii</option>
        </select>
        <select id="orzr-sort" class="form-control">
            <option value="caption-asc">Nazwa A → Z</option>
            <option value="caption-desc">Nazwa Z → A</option>
            <option value="column-asc">Kolumna rosnąco</option>
            <option value="column-desc">Kolumna malejąco</option>
            <option value="category-asc">Kategoria A → Z</option>
            <option value="id-asc">ID rosnąco</option>
        </select>
        <button id="orzr-refresh" type="button" class="btn btn-default">↻ Odśwież</button>
        <button id="orzr-save-all" type="button" class="btn btn-success" disabled>💾 Zapisz zmienione (0)</button>
    </div>
    <div id="orzr-copy-bulk" hidden>
        <div class="orzr-copy-bulk-group">
            <strong>Docelowy nr kolumny dla wszystkich:</strong>
            <input id="orzr-copy-all-column" type="number" class="form-control input-sm" min="1" step="1" value="1">
            <button id="orzr-copy-all-column-apply" type="button" class="btn btn-primary btn-sm orzr-copy-bulk-apply">Ustaw dla wszystkich</button>
        </div>
        <div class="orzr-copy-bulk-group">
            <strong>Docelowa kategoria dla wszystkich:</strong>
            <select id="orzr-copy-all-category" class="form-control input-sm">
                <option value="">Bez kategorii</option>
            </select>
            <button id="orzr-copy-all-category-apply" type="button" class="btn btn-primary btn-sm orzr-copy-bulk-apply">Ustaw dla wszystkich</button>
        </div>
        <div class="orzr-copy-bulk-group">
            <button id="orzr-copy-all-visible" type="button" class="btn btn-success btn-sm orzr-copy-bulk-apply">⧉ Kopiuj wszystkie</button>
        </div>
        <div class="orzr-copy-bulk-note">„Dla wszystkich” oznacza wszystkie ZR aktualnie widoczne po zastosowaniu wyszukiwania i filtrów. „Kopiuj wszystkie” kopiuje dokładnie tę widoczną listę.</div>
    </div>
    <div id="orzr-missing-azr-tools" hidden>
        <button id="orzr-missing-azr-copy-all" type="button" class="btn btn-success">⧉ Kopiuj wszystkie do AZR (0)</button>
        <button id="orzr-missing-azr-sync-vehicles" type="button" class="btn btn-primary">🔄 Sprawdź i aktualizuj pojazdy AZR</button>
        <button id="orzr-missing-azr-refresh" type="button" class="btn btn-default">↻ Sprawdź ponownie</button>
        <span class="orzr-missing-azr-info">Porównanie po dokładnej nazwie ZR. Źródła: wszystkie kategorie poza „AZR” i „Bez kategorii”. Każda nowa kopia do AZR jest zawsze ustawiana w kolumnie 1. Synchronizacja porównuje wyłącznie pojazdy i ich liczby.</span>
    </div>
    <div id="orzr-cleanup-tools" hidden>
        <div class="orzr-cleanup-group">
            <strong>Wyszukaj duplikaty:</strong>
            <button id="orzr-find-duplicates-exclude" type="button" class="btn btn-warning">Pomiń AZR i Bez kategorii</button>
            <button id="orzr-find-duplicates-azr" type="button" class="btn btn-warning">Tylko AZR</button>
            <button id="orzr-find-duplicates-all" type="button" class="btn btn-warning">Szukaj wszędzie</button>
        </div>
        <div class="orzr-cleanup-group">
            <button id="orzr-find-trailing-spaces" type="button" class="btn btn-warning">Poszukaj spacji na końcu nazwy</button>
            <button id="orzr-remove-trailing-spaces" type="button" class="btn btn-danger">Usuń białe znaki i spacje</button>
        </div>
        <div class="orzr-cleanup-group">
            <button id="orzr-delete-selected" type="button" class="btn btn-danger" disabled>🗑 Usuń zaznaczone (0)</button>
        </div>
        <div class="orzr-cleanup-group">
            <button id="orzr-export-csv" type="button" class="btn btn-success">Eksportuj wszystkie ZR do CSV</button>
        </div>
    </div>
    <div id="orzr-stats">
        Wszystkich ZR: <strong id="orzr-stat-total">0</strong>
        &nbsp;|&nbsp; <span id="orzr-shown-label">Widocznych</span>: <strong id="orzr-stat-shown">0</strong>
        <span id="orzr-changed-stat">&nbsp;|&nbsp; Zmienionych: <strong id="orzr-stat-changed">0</strong></span>
    </div>
    <div id="orzr-status" class="orzr-status orzr-status-info" hidden></div>
    <div id="orzr-azr-update-errors" hidden>
        <div class="orzr-azr-update-errors-title">⚠ Błędy aktualizacji AZR: <span id="orzr-azr-update-errors-count">0</span></div>
        <table id="orzr-azr-update-errors-table">
            <thead><tr><th>ID AZR</th><th>Nazwa ZR</th><th>ID źródła</th><th>Kategoria źródłowa</th><th>Błąd</th><th>Akcje</th></tr></thead>
            <tbody id="orzr-azr-update-errors-body"></tbody>
        </table>
    </div>
    <div id="orzr-table-wrap">
        <table id="orzr-table">
            <thead><tr><th>ID</th><th>Nazwa ZR</th><th>Nr kolumny</th><th>Kategoria</th><th>Akcje</th></tr></thead>
            <tbody id="orzr-list-body"></tbody>
        </table>
        <table id="orzr-copy-table" hidden>
            <thead><tr>
                <th>ID</th><th>Nazwa ZR</th><th>Nr kolumny</th><th>Kategoria</th>
                <th>Kopiuj</th><th>Docelowy nr kolumny</th><th>Docelowa kategoria</th>
            </tr></thead>
            <tbody id="orzr-copy-body"></tbody>
        </table>
        <table id="orzr-missing-azr-table" hidden>
            <thead><tr>
                <th>ID źródła</th><th>Nazwa ZR</th><th>Nr kolumny</th><th>Kategoria źródłowa</th><th>Akcje</th>
            </tr></thead>
            <tbody id="orzr-missing-azr-body"></tbody>
        </table>
        <table id="orzr-cleanup-table" hidden>
            <thead><tr>
                <th><input id="orzr-cleanup-select-all" type="checkbox" title="Zaznacz / odznacz wszystkie wyniki"></th>
                <th>ID</th><th>Nazwa ZR</th><th>Nr kolumny</th><th>Kategoria</th><th>Wynik</th><th>Akcje</th>
            </tr></thead>
            <tbody id="orzr-cleanup-body"></tbody>
        </table>
        <div id="orzr-missing-azr-empty" hidden></div>
        <div id="orzr-cleanup-empty" hidden>Wybierz jedną z operacji porządkowania powyżej.</div>
        <div id="orzr-empty" hidden>Brak ZR spełniających wybrane filtry.</div>
    </div>
</div>`;
        document.body.appendChild(overlay);

        document.querySelectorAll('.orzr-tab').forEach(btn => {
            btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
        });
        document.getElementById('orzr-close').addEventListener('click', closeManager);
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeManager();
        });
        document.getElementById('orzr-search').addEventListener('input', e => {
            state.filter = e.target.value;
            renderActiveTable();
        });
        document.getElementById('orzr-filter-category').addEventListener('change', e => {
            state.categoryFilter = e.target.value;
            renderActiveTable();
        });
        document.getElementById('orzr-sort').addEventListener('change', e => {
            state.sort = e.target.value;
            renderActiveTable();
        });
        document.getElementById('orzr-refresh').addEventListener('click', async () => {
            if (state.dirty.size && !confirm('Masz niezapisane zmiany. Odświeżyć listę i je odrzucić?')) return;
            try {
                await loadData();
            } catch (e) {
                console.error(TAG, e);
                setStatus(`Błąd pobierania listy: ${e.message || e}`, 'danger');
            }
        });
        document.getElementById('orzr-save-all').addEventListener('click', saveAllChanged);
        document.getElementById('orzr-copy-all-column-apply').addEventListener('click', applyCopyColumnToAllVisible);
        document.getElementById('orzr-copy-all-category-apply').addEventListener('click', applyCopyCategoryToAllVisible);
        document.getElementById('orzr-copy-all-visible').addEventListener('click', copyAllVisible);
        document.getElementById('orzr-missing-azr-copy-all').addEventListener('click', copyAllMissingToAZR);
        document.getElementById('orzr-missing-azr-sync-vehicles').addEventListener('click', syncAZRVehicleRequirements);
        document.getElementById('orzr-missing-azr-refresh').addEventListener('click', async () => {
            if (state.copying || state.azrVehicleSyncing) return;
            try {
                state.aaos = await fetchAAOListNormalized();
                renderMissingAZRTable();
                setStatus(`Sprawdzono ponownie. Brakuje w AZR: ${getMissingInAZRRows().length}.`, 'success');
            } catch (e) {
                console.error(TAG, e);
                setStatus(`Błąd ponownego sprawdzania AZR: ${e.message || e}`, 'danger');
            }
        });
        document.getElementById('orzr-find-duplicates-exclude').addEventListener('click', () => findDuplicateNames('exclude-azr-none'));
        document.getElementById('orzr-find-duplicates-azr').addEventListener('click', () => findDuplicateNames('only-azr'));
        document.getElementById('orzr-find-duplicates-all').addEventListener('click', () => findDuplicateNames('all'));
        document.getElementById('orzr-find-trailing-spaces').addEventListener('click', findTrailingSpaces);
        document.getElementById('orzr-remove-trailing-spaces').addEventListener('click', removeTrailingWhitespaceFromAll);
        document.getElementById('orzr-delete-selected').addEventListener('click', deleteSelectedCleanup);
        document.getElementById('orzr-export-csv').addEventListener('click', exportAllAAOsToCSV);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.classList.contains('orzr-open')) closeManager();
        });
    }

    async function openManager() {
        createUI();
        document.getElementById('orzr-manager-overlay').classList.add('orzr-open');
        document.body.style.overflow = 'hidden';
        if (!state.aaos.length) {
            try {
                await loadData();
            } catch (e) {
                console.error(TAG, e);
                setStatus(`Błąd pobierania listy: ${e.message || e}`, 'danger');
            }
        } else {
            renderActiveTable();
            updateStats();
            updateSaveAllButton();
        }
    }

    function closeManager() {
        const overlay = document.getElementById('orzr-manager-overlay');
        if (!overlay) return;
        if (state.dirty.size && !confirm(`Masz ${state.dirty.size} niezapisanych zmian. Zamknąć bez zapisywania?`)) return;
        overlay.classList.remove('orzr-open');
        document.body.style.overflow = '';
    }

    function init() {
        log(`Start v${VERSION}`);
        createUI();
        try {
            GM_registerMenuCommand('Otwórz Menedżer ZR Lista', openManager);
        } catch {}
        updateSaveAllButton();
    }

    init();
})();
