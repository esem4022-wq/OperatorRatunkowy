// ==UserScript==
// @name         Menedżer ZR Lista
// @namespace    https://www.operatorratunkowy.pl/
// @version      0.5
// @description  Osobny menedżer ZR: lista, szybka edycja oraz kopiowanie ZR do wybranej kolumny i kategorii.
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
    const VERSION = '0.5';

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
        copying: false
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
            if (state.categoryFilter !== 'all' && state.categoryFilter !== 'none' &&
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
        const saveAll = document.getElementById('orzr-save-all');
        const changedStat = document.getElementById('orzr-changed-stat');

        const copying = state.activeTab === 'copy';
        if (listTable) listTable.hidden = copying;
        if (copyTable) copyTable.hidden = !copying;
        if (saveAll) saveAll.hidden = copying;
        if (changedStat) changedStat.hidden = copying;

        if (copying) renderCopyTable();
        else renderTable();

        document.querySelectorAll('.orzr-tab').forEach(btn => {
            btn.classList.toggle('orzr-tab-active', btn.dataset.tab === state.activeTab);
        });
    }

    function setActiveTab(tab) {
        if (!['list', 'copy'].includes(tab)) return;
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
        if (shown) shown.textContent = sortedFilteredAAOs().length;
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
        select.innerHTML = '<option value="all">Wszystkie kategorie</option><option value="none">Bez kategorii</option>';
        for (const [id, name] of [...state.categories.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pl'))) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name;
            select.appendChild(opt);
        }
        select.value = [...select.options].some(o => o.value === old) ? old : 'all';
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
#orzr-stats{padding:7px 12px;background:#f5f5f5;border-bottom:1px solid #ddd;font-size:12px}
.orzr-status{margin:8px 12px 0;padding:8px 10px;border-radius:4px;font-size:13px}
.orzr-status-info{background:#d9edf7;border:1px solid #bce8f1}
.orzr-status-success{background:#dff0d8;border:1px solid #d6e9c6}
.orzr-status-warning{background:#fcf8e3;border:1px solid #faebcc}
.orzr-status-danger{background:#f2dede;border:1px solid #ebccd1}
#orzr-table-wrap{flex:1;overflow:auto;padding:8px 12px 12px}
#orzr-table,#orzr-copy-table{width:100%;border-collapse:collapse;table-layout:fixed}
#orzr-table th,#orzr-copy-table th{position:sticky;top:0;z-index:2;background:#eee;border:1px solid #ccc;padding:7px;text-align:left}
#orzr-table td,#orzr-copy-table td{border:1px solid #ddd;padding:5px 7px;vertical-align:middle}
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
    </div>
    <div id="orzr-toolbar">
        <input id="orzr-search" type="search" class="form-control" placeholder="Szukaj po nazwie, kategorii, kolumnie lub ID…">
        <select id="orzr-filter-category" class="form-control">
            <option value="all">Wszystkie kategorie</option>
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
    <div id="orzr-stats">
        Wszystkich ZR: <strong id="orzr-stat-total">0</strong>
        &nbsp;|&nbsp; Widocznych: <strong id="orzr-stat-shown">0</strong>
        <span id="orzr-changed-stat">&nbsp;|&nbsp; Zmienionych: <strong id="orzr-stat-changed">0</strong></span>
    </div>
    <div id="orzr-status" class="orzr-status orzr-status-info" hidden></div>
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
