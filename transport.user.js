// ==UserScript==
// @name         Transport
// @namespace    operatorratunkowy.local.transport
// @version      1.0
// @description  Ukrywa wszystkie ZR w oknie misji, gdy pojawią się więźniowie do transportu.
// @author       ChatGPT + użytkownik
// @homepageURL  https://github.com/esem4022-wq/OperatorRatunkowy
// @updateURL    https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/transport.user.js
// @downloadURL  https://raw.githubusercontent.com/esem4022-wq/OperatorRatunkowy/main/transport.user.js
// @match        https://operatorratunkowy.pl/*
// @match        https://www.operatorratunkowy.pl/*
// @match        https://policja.operatorratunkowy.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const HIDE_CLASS = 'or-transport-hide-zr';
    let scanTimer = null;

    function normalize(text) {
        return String(text ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function ensureStyle() {
        if (document.getElementById('or-transport-style')) return;

        const style = document.createElement('style');
        style.id = 'or-transport-style';
        style.textContent = `
            #mission-aao-group.${HIDE_CLASS} {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function prisonersNeedTransport() {
        const text = normalize(document.body?.innerText || '');

        if (!text) return false;

        // Komunikat widoczny w sekcji transportu więźniów.
        if (text.includes('wiezniowie powinni zostac umieszczeni w celi')) {
            return true;
        }

        // Przycisk awaryjnego zwolnienia więźniów.
        if (text.includes('zwolnij wiezniow')) {
            return true;
        }

        // Dodatkowy fallback na układ:
        // "4 więźniów" + "Wybierz właściwy pojazd i celę".
        const hasPrisonerCount =
            /\b\d+\s+wiezniow\b/.test(text) ||
            /\b1\s+wiezien\b/.test(text);

        const hasTransportInstruction =
            text.includes('wybierz wlasciwy pojazd i cele');

        return hasPrisonerCount && hasTransportInstruction;
    }

    function updateZRVisibility() {
        ensureStyle();

        const aaoGroup = document.getElementById('mission-aao-group');
        if (!aaoGroup) return;

        aaoGroup.classList.toggle(HIDE_CLASS, prisonersNeedTransport());
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(updateZRVisibility, 80);
    }

    ensureStyle();
    updateZRVisibility();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });

    window.addEventListener('hashchange', scheduleScan);
    window.addEventListener('popstate', scheduleScan);
})();
