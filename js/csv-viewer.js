// CSV Viewer functionality
//
// Rendering choice: a small hand-written windowed renderer instead of Tabulator.
// The site has no build step and styles everything with Tailwind; Tabulator adds
// ~400 KB of JS + its own theme CSS that would clash with the rest of the page,
// while the features needed here (sticky header, sort, filter, resize, hide
// columns) fit in a few hundred lines on top of a plain <table>. Only the rows
// inside the scroll viewport (plus a small overscan) are in the DOM, so 100k+
// row files stay smooth.
(function () {
    const LARGE_FILE_BYTES = 5 * 1024 * 1024; // Above this, parse in a worker with progress
    const OVERSCAN = 12;
    const MAX_ERRORS_SHOWN = 5;
    const DELIMITER_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
    const HINT_STORAGE_KEY = 'csvInstallHintDismissed';

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    const state = {
        source: null,        // { kind: 'file' | 'text', file?, text?, name, size }
        rawRows: [],         // All parsed rows (arrays of strings), header included
        delimiter: '',
        delimiterAuto: true,
        hasHeader: true,
        headers: [],
        data: [],            // Data rows (header removed when hasHeader)
        columnCount: 0,
        hidden: new Set(),
        colWidths: [],
        sortCol: -1,
        sortDir: 0,          // 1 asc, -1 desc, 0 none
        sortedAll: null,     // Row indices in sort order (cached across filter changes)
        sortKeyCache: new Map(),
        filter: '',
        view: [],            // Row indices currently shown (filtered + sorted)
        rowHeight: 32,
        renderedStart: -1,
        renderedEnd: -1,
        activeCell: null,    // { r, c } r = view index, c = visible column index
        parseId: 0,
        parser: null
    };

    let installPromptEvent = null;
    let filterTimer = null;
    let pasteTimer = null;
    let scrollFrame = 0;

    const $ = (id) => document.getElementById(id);

    // ---------- Small helpers ----------

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatCount(n) {
        return n.toLocaleString();
    }

    function setNotice(html, type = 'info') {
        const container = $('csv-message');
        if (!html) {
            container.innerHTML = '';
            return;
        }
        const colors = {
            error: 'bg-red-50 border-red-200 text-red-800',
            warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
            success: 'bg-green-50 border-green-200 text-green-800',
            info: 'bg-blue-50 border-blue-200 text-blue-800'
        };
        container.innerHTML = `<div class="${colors[type] || colors.info} border p-4 rounded-lg text-sm">${html}</div>`;
    }

    function delimiterLabel(delimiter) {
        if (DELIMITER_NAMES[delimiter]) return DELIMITER_NAMES[delimiter];
        return delimiter ? `"${delimiter}"` : 'unknown';
    }

    // ---------- Loading ----------

    // Render a File/Blob (drag & drop, file picker, launchQueue, or URL download)
    function renderCsvFile(file) {
        loadSource({
            kind: 'file',
            file,
            name: file.name || 'Untitled',
            size: file.size
        });
    }

    function loadText(text, name) {
        loadSource({
            kind: 'text',
            text,
            name,
            size: new Blob([text]).size
        });
    }

    function loadSource(source) {
        state.source = source;
        parseSource();
    }

    function cancelParse() {
        state.parseId++;
        if (state.parser) {
            try { state.parser.abort(); } catch (e) { /* already finished */ }
            state.parser = null;
        }
        showProgress(false);
    }

    function parseSource() {
        const source = state.source;
        if (!source) return;
        if (typeof window.Papa === 'undefined') {
            showParseError('The CSV parser (Papa Parse) failed to load. Check your connection and reload the page.');
            return;
        }

        cancelParse();
        const parseId = state.parseId;
        const manualDelimiter = $('csv-delimiter').value;
        const config = {
            delimiter: manualDelimiter,           // '' = auto-detect
            delimitersToGuess: [',', ';', '\t', '|'],
            skipEmptyLines: true
        };

        setNotice('');

        if (source.kind === 'text') {
            const results = Papa.parse(source.text.replace(/^﻿/, ''), config);
            finishParse(parseId, results.data, results.meta.delimiter, results.errors);
            return;
        }

        if (source.size <= LARGE_FILE_BYTES) {
            source.file.text().then((text) => {
                if (parseId !== state.parseId) return;
                const results = Papa.parse(text.replace(/^﻿/, ''), config);
                finishParse(parseId, results.data, results.meta.delimiter, results.errors);
            }).catch((error) => {
                if (parseId === state.parseId) showParseError(`Could not read the file: ${escapeHtml(error.message)}`);
            });
            return;
        }

        // Large file: stream it through a worker in 1 MB chunks so the UI never freezes
        const rows = [];
        const errors = [];
        let delimiter = manualDelimiter;
        showProgress(true, 0, 0);

        Papa.parse(source.file, Object.assign({}, config, {
            worker: true,
            chunkSize: 1024 * 1024,
            chunk(results, parser) {
                if (parseId !== state.parseId) {
                    parser.abort();
                    return;
                }
                state.parser = parser;
                results.errors.forEach((error) => {
                    errors.push(Object.assign({}, error, {
                        row: typeof error.row === 'number' ? error.row + rows.length : error.row
                    }));
                });
                for (let i = 0; i < results.data.length; i++) rows.push(results.data[i]);
                if (results.meta.delimiter) delimiter = results.meta.delimiter;
                const percent = Math.min(99, Math.round((results.meta.cursor / source.size) * 100));
                showProgress(true, percent, rows.length);
            },
            complete() {
                if (parseId !== state.parseId) return;
                state.parser = null;
                showProgress(false);
                finishParse(parseId, rows, delimiter, errors);
            },
            error(error) {
                if (parseId !== state.parseId) return;
                state.parser = null;
                showProgress(false);
                showParseError(`Could not read the file: ${escapeHtml(error.message || String(error))}`);
            }
        }));
    }

    function showProgress(visible, percent = 0, rowCount = 0) {
        const wrap = $('csv-progress');
        wrap.style.display = visible ? 'block' : 'none';
        if (!visible) return;
        const bar = $('csv-progress-bar');
        bar.style.width = `${percent}%`;
        bar.parentElement.setAttribute('aria-valuenow', String(percent));
        $('csv-progress-text').textContent =
            `Parsing ${state.source ? state.source.name : ''}… ${percent}% (${formatCount(rowCount)} rows)`;
    }

    function finishParse(parseId, rows, delimiter, errors) {
        if (parseId !== state.parseId) return;

        // Papa reports an undetectable delimiter for single-column files; it falls back to comma
        const realErrors = errors.filter((error) => error.code !== 'UndetectableDelimiter');

        if (rows.length && rows[0].length && typeof rows[0][0] === 'string') {
            rows[0][0] = rows[0][0].replace(/^﻿/, '');
        }

        state.rawRows = rows;
        state.delimiter = delimiter || ',';
        state.delimiterAuto = !$('csv-delimiter').value;

        if (!rows.length) {
            if (realErrors.length) {
                showParseError(formatErrors(realErrors));
            } else {
                resetTable();
                setNotice('The CSV is empty — no rows were found.', 'warning');
            }
            return;
        }

        buildTable();

        if (realErrors.length) {
            setNotice(`Parsed with ${formatCount(realErrors.length)} warning${realErrors.length === 1 ? '' : 's'}; some rows may be malformed.${formatErrors(realErrors)}`, 'warning');
        }
    }

    function formatErrors(errors) {
        const offset = $('csv-has-header').checked ? 1 : 0;
        const items = errors.slice(0, MAX_ERRORS_SHOWN).map((error) => {
            const where = typeof error.row === 'number'
                ? `Row ${formatCount(error.row + 1)}${offset && error.row > 0 ? ` (data row ${formatCount(error.row)})` : ''}: `
                : '';
            return `<li>${where}${escapeHtml(error.message)} <span class="opacity-70">[${escapeHtml(error.code || error.type)}]</span></li>`;
        }).join('');
        const more = errors.length > MAX_ERRORS_SHOWN
            ? `<li>…and ${formatCount(errors.length - MAX_ERRORS_SHOWN)} more</li>`
            : '';
        return `<ul class="list-disc ml-5 mt-2 space-y-1">${items}${more}</ul>`;
    }

    function showParseError(html) {
        resetTable();
        setNotice(`<strong>Could not parse the CSV.</strong> ${html}`, 'error');
    }

    async function loadFromUrl(rawUrl) {
        let url;
        try {
            url = new URL(rawUrl.trim());
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');
        } catch (error) {
            setNotice(`Invalid URL: ${escapeHtml(error.message)}`, 'error');
            return;
        }

        cancelParse();
        const parseId = state.parseId;
        setNotice(`Fetching <span class="font-mono break-all">${escapeHtml(url.href)}</span>…`, 'info');

        let response;
        try {
            response = await fetch(url.href);
        } catch (error) {
            if (parseId !== state.parseId) return;
            setNotice(
                `<strong>Could not fetch the CSV.</strong> The request to <span class="font-mono break-all">${escapeHtml(url.href)}</span> was blocked or failed. ` +
                'This usually means the remote server does not allow cross-origin requests (CORS): it must send an ' +
                '<code>Access-Control-Allow-Origin</code> header for this site to read the file. ' +
                'Try a raw file URL (e.g. raw.githubusercontent.com), or download the file and drop it here instead.',
                'error'
            );
            return;
        }
        if (parseId !== state.parseId) return;
        if (!response.ok) {
            setNotice(`<strong>Could not fetch the CSV.</strong> The server responded with ${response.status} ${escapeHtml(response.statusText)}.`, 'error');
            return;
        }

        const blob = await response.blob();
        if (parseId !== state.parseId) return;
        const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
        renderCsvFile(new File([blob], name, { type: blob.type }));
    }

    // ---------- Table model ----------

    function resetTable() {
        state.rawRows = [];
        state.data = [];
        state.headers = [];
        state.columnCount = 0;
        state.view = [];
        $('csv-results').style.display = 'none';
        $('csv-empty').style.display = 'block';
    }

    function buildTable() {
        const rows = state.rawRows;
        state.hasHeader = $('csv-has-header').checked;

        let columnCount = 0;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].length > columnCount) columnCount = rows[i].length;
        }
        state.columnCount = columnCount;

        const headerRow = state.hasHeader ? rows[0] : [];
        state.headers = [];
        for (let c = 0; c < columnCount; c++) {
            const name = headerRow[c] != null ? String(headerRow[c]).trim() : '';
            state.headers.push(name || `Column ${c + 1}`);
        }
        state.data = state.hasHeader ? rows.slice(1) : rows;

        state.hidden = new Set();
        state.sortCol = -1;
        state.sortDir = 0;
        state.sortedAll = null;
        state.sortKeyCache = new Map();
        state.activeCell = null;
        state.colWidths = estimateColumnWidths();

        $('csv-empty').style.display = 'none';
        $('csv-results').style.display = 'block';

        renderColumnToggles();
        updateView();
        $('csv-table-wrap').scrollTop = 0;
        $('csv-table-wrap').scrollLeft = 0;
    }

    function estimateColumnWidths() {
        const sample = state.data.slice(0, 200);
        const widths = [];
        for (let c = 0; c < state.columnCount; c++) {
            let longest = state.headers[c].length + 2;
            for (let i = 0; i < sample.length; i++) {
                const value = sample[i][c];
                if (value && value.length > longest) longest = value.length;
            }
            widths.push(Math.max(80, Math.min(360, longest * 8 + 28)));
        }
        return widths;
    }

    function visibleColumns() {
        const columns = [];
        for (let c = 0; c < state.columnCount; c++) {
            if (!state.hidden.has(c)) columns.push(c);
        }
        return columns;
    }

    function cellValue(row, c) {
        const value = row[c];
        return value == null ? '' : value;
    }

    const NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;
    const GROUPED_NUMBER_RE = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;

    function toNumber(value) {
        const trimmed = value.trim();
        if (!trimmed) return NaN;
        if (NUMBER_RE.test(trimmed)) return parseFloat(trimmed);
        if (GROUPED_NUMBER_RE.test(trimmed)) return parseFloat(trimmed.replace(/,/g, ''));
        return NaN;
    }

    // Per-column sort keys: kind 0 = number, 1 = text, 2 = empty. Text is ranked
    // by sorting the distinct values once, so the row sort only compares integers.
    function sortKeysFor(c) {
        if (state.sortKeyCache.has(c)) return state.sortKeyCache.get(c);
        const n = state.data.length;
        const kinds = new Uint8Array(n);
        const nums = new Float64Array(n);
        const texts = new Set();
        for (let i = 0; i < n; i++) {
            const value = cellValue(state.data[i], c);
            if (value === '') {
                kinds[i] = 2;
                continue;
            }
            const number = toNumber(value);
            if (number === number) {
                nums[i] = number;
            } else {
                kinds[i] = 1;
                texts.add(value);
            }
        }
        if (texts.size) {
            const rank = new Map();
            Array.from(texts).sort(collator.compare).forEach((value, i) => rank.set(value, i));
            for (let i = 0; i < n; i++) {
                if (kinds[i] === 1) nums[i] = rank.get(state.data[i][c]);
            }
        }
        const keys = { kinds, nums };
        state.sortKeyCache.set(c, keys);
        return keys;
    }

    // Numbers sort numerically and before text; empty cells always go last
    function computeSortedAll() {
        const n = state.data.length;
        const indices = new Array(n);
        for (let i = 0; i < n; i++) indices[i] = i;
        if (state.sortCol < 0 || !state.sortDir) return indices;

        const { kinds, nums } = sortKeysFor(state.sortCol);
        const dir = state.sortDir;
        indices.sort((a, b) => {
            const aKind = kinds[a];
            const bKind = kinds[b];
            if (aKind === 2 || bKind === 2) return aKind === bKind ? a - b : aKind === 2 ? 1 : -1;
            const result = aKind !== bKind ? aKind - bKind : nums[a] - nums[b];
            return result === 0 ? a - b : result * dir;
        });
        return indices;
    }

    function updateView() {
        if (!state.sortedAll) state.sortedAll = computeSortedAll();

        const needle = state.filter.toLowerCase();
        if (!needle) {
            state.view = state.sortedAll;
        } else {
            const columns = visibleColumns();
            const view = [];
            const all = state.sortedAll;
            for (let i = 0; i < all.length; i++) {
                const row = state.data[all[i]];
                for (let j = 0; j < columns.length; j++) {
                    const value = row[columns[j]];
                    if (value && value.toLowerCase().includes(needle)) {
                        view.push(all[i]);
                        break;
                    }
                }
            }
            state.view = view;
        }

        state.activeCell = null;
        renderHeader();
        renderRows(true);
        updateStatus();
    }

    // ---------- Rendering ----------

    function renderHeader() {
        const columns = visibleColumns();
        const table = $('csv-table');
        const rowNumWidth = Math.max(48, String(state.data.length).length * 9 + 24);

        let colgroup = `<col style="width:${rowNumWidth}px">`;
        let total = rowNumWidth;
        columns.forEach((c) => {
            colgroup += `<col data-col="${c}" style="width:${state.colWidths[c]}px">`;
            total += state.colWidths[c];
        });
        $('csv-colgroup').innerHTML = colgroup;
        table.style.width = `${total}px`;
        table.setAttribute('aria-rowcount', String(state.view.length + 1));
        table.setAttribute('aria-colcount', String(columns.length + 1));

        let header = '<tr aria-rowindex="1"><th scope="col" class="csv-rownum" aria-label="Row number">#</th>';
        columns.forEach((c) => {
            const name = state.headers[c];
            const sorted = state.sortCol === c && state.sortDir;
            const ariaSort = sorted ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none';
            const arrow = sorted ? (state.sortDir === 1 ? '▲' : '▼') : '↕';
            header += `<th scope="col" aria-sort="${ariaSort}" title="${escapeHtml(name)}">` +
                `<button type="button" class="csv-sort-btn" data-col="${c}" aria-label="Sort by ${escapeHtml(name)}">` +
                `<span class="truncate">${escapeHtml(name)}</span>` +
                `<span class="csv-sort-arrow ${sorted ? 'text-blue-600' : 'text-gray-300'}" aria-hidden="true">${arrow}</span>` +
                '</button>' +
                `<span class="csv-resizer" data-col="${c}" role="separator" aria-orientation="vertical" tabindex="0" ` +
                `aria-label="Resize column ${escapeHtml(name)}" aria-valuenow="${state.colWidths[c]}" title="Drag (or use ←/→) to resize"></span>` +
                '</th>';
        });
        header += '</tr>';
        $('csv-thead').innerHTML = header;
    }

    function renderRows(force) {
        const wrap = $('csv-table-wrap');
        const tbody = $('csv-tbody');
        const columns = visibleColumns();
        const total = state.view.length;

        if (!total) {
            state.renderedStart = state.renderedEnd = -1;
            const message = state.data.length
                ? 'No rows match your search.'
                : 'The file has a header row but no data rows.';
            tbody.innerHTML = `<tr><td colspan="${columns.length + 1}" class="csv-empty-cell">${message}</td></tr>`;
            return;
        }

        const rowHeight = state.rowHeight;
        const headerHeight = $('csv-thead').offsetHeight || rowHeight;
        const scrollTop = Math.max(0, wrap.scrollTop - headerHeight);
        const viewportRows = Math.ceil(wrap.clientHeight / rowHeight) + 1;
        const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
        const end = Math.min(total, start + viewportRows + OVERSCAN * 2);

        if (!force && start === state.renderedStart && end === state.renderedEnd) return;
        state.renderedStart = start;
        state.renderedEnd = end;

        const colspan = columns.length + 1;
        let html = '';
        if (start > 0) {
            html += `<tr class="csv-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${start * rowHeight}px"></td></tr>`;
        }
        for (let r = start; r < end; r++) {
            const dataIndex = state.view[r];
            const row = state.data[dataIndex];
            const rowNumber = dataIndex + 1;
            html += `<tr aria-rowindex="${r + 2}" class="${r % 2 ? 'csv-odd' : ''}">` +
                `<th scope="row" class="csv-rownum">${rowNumber}</th>`;
            for (let j = 0; j < columns.length; j++) {
                const value = cellValue(row, columns[j]);
                const safe = escapeHtml(value);
                const title = value.length > 40 || value.includes('\n')
                    ? ` title="${value.length > 1000 ? escapeHtml(value.slice(0, 1000)) + '…' : safe}"`
                    : '';
                html += `<td tabindex="-1" data-r="${r}" data-c="${j}"${title}>${safe}</td>`;
            }
            html += '</tr>';
        }
        if (end < total) {
            html += `<tr class="csv-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${(total - end) * rowHeight}px"></td></tr>`;
        }
        tbody.innerHTML = html;

        // Measure the real row height once so spacer maths matches the CSS
        const firstRow = tbody.querySelector('tr[aria-rowindex]');
        if (firstRow && firstRow.offsetHeight && Math.abs(firstRow.offsetHeight - rowHeight) > 0.5) {
            state.rowHeight = firstRow.offsetHeight;
            renderRows(true);
        }
    }

    function updateStatus() {
        const source = state.source;
        const columns = visibleColumns().length;
        const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
        const rowsText = state.filter
            ? `${formatCount(state.view.length)} of ${formatCount(state.data.length)} ${plural(state.data.length, 'row')}`
            : `${formatCount(state.data.length)} ${plural(state.data.length, 'row')}`;
        const columnsText = columns === state.columnCount
            ? `${formatCount(state.columnCount)} ${plural(state.columnCount, 'column')}`
            : `${formatCount(columns)} of ${formatCount(state.columnCount)} ${plural(state.columnCount, 'column')}`;
        const delimiterText = `Delimiter: ${delimiterLabel(state.delimiter)} ${state.delimiterAuto ? '(auto-detected)' : '(manual)'}`;
        const sourceText = source ? `${escapeHtml(source.name)} · ${formatBytes(source.size)}` : '';

        $('csv-status').innerHTML = [
            `<span class="font-semibold text-gray-800">${rowsText} × ${columnsText}</span>`,
            `<span>${delimiterText}</span>`,
            sourceText ? `<span class="break-all">${sourceText}</span>` : ''
        ].filter(Boolean).join('<span class="text-gray-300" aria-hidden="true">|</span>');

        $('csv-match-count').textContent = state.filter
            ? `${formatCount(state.view.length)} match${state.view.length === 1 ? '' : 'es'}`
            : '';
    }

    function renderColumnToggles() {
        const list = $('csv-column-list');
        list.innerHTML = state.headers.map((name, c) => `
            <label class="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-50 cursor-pointer text-sm">
                <input type="checkbox" class="csv-col-toggle rounded" data-col="${c}" ${state.hidden.has(c) ? '' : 'checked'}>
                <span class="truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            </label>
        `).join('');
    }

    // ---------- Interaction ----------

    function toggleSort(c) {
        if (state.sortCol !== c) {
            state.sortCol = c;
            state.sortDir = 1;
        } else {
            state.sortDir = state.sortDir === 1 ? -1 : state.sortDir === -1 ? 0 : 1;
            if (!state.sortDir) state.sortCol = -1;
        }
        state.sortedAll = null;
        updateView();
        const button = document.querySelector(`.csv-sort-btn[data-col="${c}"]`);
        if (button) button.focus();
    }

    function setColumnWidth(c, width) {
        state.colWidths[c] = Math.max(48, Math.min(1200, Math.round(width)));
        const col = document.querySelector(`#csv-colgroup col[data-col="${c}"]`);
        if (col) col.style.width = `${state.colWidths[c]}px`;
        const handle = document.querySelector(`.csv-resizer[data-col="${c}"]`);
        if (handle) handle.setAttribute('aria-valuenow', String(state.colWidths[c]));
        let total = 0;
        document.querySelectorAll('#csv-colgroup col').forEach((el) => { total += parseFloat(el.style.width); });
        $('csv-table').style.width = `${total}px`;
    }

    function startResize(event, c) {
        event.preventDefault();
        const handle = event.target;
        const startX = event.clientX;
        const startWidth = state.colWidths[c];
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('csv-resizing');
        const onMove = (e) => setColumnWidth(c, startWidth + e.clientX - startX);
        const onUp = () => {
            handle.classList.remove('csv-resizing');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    }

    function copyCell(td) {
        const r = Number(td.dataset.r);
        const j = Number(td.dataset.c);
        const c = visibleColumns()[j];
        const value = cellValue(state.data[state.view[r]], c);
        copyToClipboard(value, state.headers[c], td);
    }

    function focusCell(r, c) {
        const columns = visibleColumns();
        if (!state.view.length || !columns.length) return;
        r = Math.max(0, Math.min(state.view.length - 1, r));
        c = Math.max(0, Math.min(columns.length - 1, c));
        state.activeCell = { r, c };

        // Keep the row clear of the sticky header before focusing it
        const wrap = $('csv-table-wrap');
        const headerHeight = $('csv-thead').offsetHeight;
        const rowTop = headerHeight + r * state.rowHeight;
        if (rowTop - headerHeight < wrap.scrollTop) {
            wrap.scrollTop = rowTop - headerHeight;
        } else if (rowTop + state.rowHeight > wrap.scrollTop + wrap.clientHeight) {
            wrap.scrollTop = rowTop + state.rowHeight - wrap.clientHeight;
        }
        renderRows(false);
        const td = $('csv-tbody').querySelector(`td[data-r="${r}"][data-c="${c}"]`);
        if (td) td.focus();
    }

    function handleGridKeydown(event) {
        const td = event.target.closest && event.target.closest('td[data-r]');
        const wrap = $('csv-table-wrap');
        if (!td && event.target !== wrap) return;

        if (td && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            copyCell(td);
            return;
        }

        const current = td
            ? { r: Number(td.dataset.r), c: Number(td.dataset.c) }
            : (state.activeCell || { r: Math.max(0, state.renderedStart + OVERSCAN), c: 0 });
        const pageRows = Math.max(1, Math.floor(wrap.clientHeight / state.rowHeight) - 2);
        const lastColumn = visibleColumns().length - 1;
        let { r, c } = current;

        switch (event.key) {
            case 'ArrowDown': r += td ? 1 : 0; break;
            case 'ArrowUp': r -= td ? 1 : 0; break;
            case 'ArrowRight': c += td ? 1 : 0; break;
            case 'ArrowLeft': c -= td ? 1 : 0; break;
            case 'PageDown': r += pageRows; break;
            case 'PageUp': r -= pageRows; break;
            case 'Home': if (event.ctrlKey || event.metaKey) r = 0; c = 0; break;
            case 'End': if (event.ctrlKey || event.metaKey) r = state.view.length - 1; c = lastColumn; break;
            default: return;
        }
        event.preventDefault();
        focusCell(r, c);
    }

    function handleResizerKeydown(event) {
        const handle = event.target;
        if (!handle.classList.contains('csv-resizer')) return;
        const c = Number(handle.dataset.col);
        const step = event.shiftKey ? 50 : 16;
        if (event.key === 'ArrowLeft') setColumnWidth(c, state.colWidths[c] - step);
        else if (event.key === 'ArrowRight') setColumnWidth(c, state.colWidths[c] + step);
        else return;
        event.preventDefault();
        event.stopPropagation();
    }

    // ---------- Export ----------

    function exportKeys(columns) {
        const used = new Map();
        return columns.map((c) => {
            const base = state.headers[c];
            const count = (used.get(base) || 0) + 1;
            used.set(base, count);
            return count === 1 ? base : `${base}_${count}`;
        });
    }

    function viewAsObjects() {
        const columns = visibleColumns();
        const keys = exportKeys(columns);
        return state.view.map((index) => {
            const row = state.data[index];
            const object = {};
            columns.forEach((c, j) => { object[keys[j]] = cellValue(row, c); });
            return object;
        });
    }

    function viewAsCsv() {
        const columns = visibleColumns();
        const rows = state.view.map((index) => columns.map((c) => cellValue(state.data[index], c)));
        return Papa.unparse({
            fields: columns.map((c) => state.headers[c]),
            data: rows
        }, { newline: '\r\n' });
    }

    function exportBaseName() {
        const name = state.source ? state.source.name : 'data';
        return name.replace(/\.(csv|tsv|txt)$/i, '') || 'data';
    }

    function downloadText(text, fileName, mimeType) {
        const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---------- Install hint / PWA ----------

    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    function setupInstallHint() {
        const hint = $('csv-install-hint');
        let dismissed = false;
        try { dismissed = localStorage.getItem(HINT_STORAGE_KEY) === '1'; } catch (e) { /* storage blocked */ }
        if (dismissed || isStandalone()) return;

        hint.style.display = 'flex';
        $('csv-install-dismiss').addEventListener('click', () => {
            hint.style.display = 'none';
            try { localStorage.setItem(HINT_STORAGE_KEY, '1'); } catch (e) { /* storage blocked */ }
        });

        const installButton = $('csv-install-btn');
        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            installPromptEvent = event;
            installButton.style.display = 'inline-block';
        });
        installButton.addEventListener('click', async () => {
            if (!installPromptEvent) return;
            installPromptEvent.prompt();
            await installPromptEvent.userChoice;
            installPromptEvent = null;
            installButton.style.display = 'none';
        });
        window.addEventListener('appinstalled', () => {
            installButton.style.display = 'none';
        });
    }

    function showCsvTab() {
        if (window.location.hash !== '#csv') {
            history.replaceState(null, '', `${window.location.pathname}${window.location.search}#csv`);
        }
        switchTab('csv');
    }

    // Files opened from Finder/Explorer ("Open With" → Developer Tools) arrive here
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (params) => {
            for (const handle of params.files) {
                const file = await handle.getFile();
                showCsvTab();
                renderCsvFile(file);
            }
        });
    }

    // ---------- Setup ----------

    function toggleCsvInputMethod() {
        const method = $('csv-input-method').value;
        $('csv-file-section').style.display = method === 'file' ? 'block' : 'none';
        $('csv-paste-section').style.display = method === 'paste' ? 'block' : 'none';
        $('csv-url-section').style.display = method === 'url' ? 'block' : 'none';
    }

    function setupCsvViewer() {
        const dropZone = $('csv-file-upload');
        const fileInput = $('csv-file');
        const wrap = $('csv-table-wrap');

        $('csv-input-method').addEventListener('change', toggleCsvInputMethod);

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (file) {
                $('csv-file-info').innerHTML = `<strong>${escapeHtml(file.name)}</strong><br>Size: ${formatBytes(file.size)}`;
                renderCsvFile(file);
            }
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('border-blue-500', 'bg-blue-50');
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-blue-500', 'bg-blue-50');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-blue-500', 'bg-blue-50');
            const file = e.dataTransfer.files[0];
            if (file) {
                $('csv-file-info').innerHTML = `<strong>${escapeHtml(file.name)}</strong><br>Size: ${formatBytes(file.size)}`;
                renderCsvFile(file);
            }
        });

        $('csv-paste-input').addEventListener('input', () => {
            clearTimeout(pasteTimer);
            pasteTimer = setTimeout(() => {
                const text = $('csv-paste-input').value;
                if (text.trim()) loadText(text, 'Pasted text');
            }, 300);
        });
        $('csv-parse-btn').addEventListener('click', () => {
            const text = $('csv-paste-input').value;
            if (text.trim()) loadText(text, 'Pasted text');
            else setNotice('Paste some CSV content first.', 'warning');
        });

        $('csv-url-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const value = $('csv-url-input').value;
            if (!value.trim()) return;
            // Keep the address shareable: ?url=…#csv reloads the same data
            const params = new URLSearchParams(window.location.search);
            params.set('url', value.trim());
            params.delete('open');
            history.replaceState(null, '', `${window.location.pathname}?${params.toString()}#csv`);
            loadFromUrl(value);
        });

        $('csv-delimiter').addEventListener('change', parseSource);
        $('csv-has-header').addEventListener('change', () => {
            if (state.rawRows.length) buildTable();
        });
        $('csv-cancel-btn').addEventListener('click', () => {
            cancelParse();
            setNotice('Parsing cancelled.', 'warning');
        });

        $('csv-search').addEventListener('input', (e) => {
            clearTimeout(filterTimer);
            const value = e.target.value;
            filterTimer = setTimeout(() => {
                state.filter = value;
                updateView();
                wrap.scrollTop = 0;
            }, state.data.length > 50000 ? 250 : 100);
        });

        $('csv-column-list').addEventListener('change', (e) => {
            if (!e.target.classList.contains('csv-col-toggle')) return;
            const c = Number(e.target.dataset.col);
            if (e.target.checked) state.hidden.delete(c);
            else state.hidden.add(c);
            updateView();
        });
        $('csv-show-all-cols').addEventListener('click', () => {
            state.hidden.clear();
            renderColumnToggles();
            updateView();
        });

        $('csv-thead').addEventListener('click', (e) => {
            const button = e.target.closest('.csv-sort-btn');
            if (button) toggleSort(Number(button.dataset.col));
        });
        $('csv-thead').addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('csv-resizer')) startResize(e, Number(e.target.dataset.col));
        });
        $('csv-thead').addEventListener('keydown', handleResizerKeydown);

        $('csv-tbody').addEventListener('click', (e) => {
            const td = e.target.closest('td[data-r]');
            if (!td) return;
            state.activeCell = { r: Number(td.dataset.r), c: Number(td.dataset.c) };
            copyCell(td);
        });
        wrap.addEventListener('keydown', handleGridKeydown);
        wrap.addEventListener('scroll', () => {
            if (scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                renderRows(false);
            });
        });
        // Re-window on viewport changes, including the tab becoming visible after
        // data was loaded while it was hidden (e.g. a file opened from Finder)
        if ('ResizeObserver' in window) {
            new ResizeObserver(() => {
                if (state.view.length) renderRows(true);
            }).observe(wrap);
        } else {
            window.addEventListener('resize', () => {
                if (state.view.length) renderRows(true);
            });
        }

        $('csv-copy-json').addEventListener('click', (e) => {
            copyToClipboard(JSON.stringify(viewAsObjects(), null, 2), 'JSON', e.currentTarget);
        });
        $('csv-download-json').addEventListener('click', () => {
            downloadText(JSON.stringify(viewAsObjects(), null, 2), `${exportBaseName()}.json`, 'application/json');
        });
        $('csv-download-csv').addEventListener('click', () => {
            downloadText(viewAsCsv(), `${exportBaseName()}.csv`, 'text/csv');
        });

        setupInstallHint();

        // ?url=<encoded-url>#csv loads a remote CSV; ?open=csv is the PWA file-handler entry point
        const params = new URLSearchParams(window.location.search);
        const remoteUrl = params.get('url');
        const hash = window.location.hash;
        if (remoteUrl && (hash === '#csv' || !hash)) {
            showCsvTab();
            $('csv-input-method').value = 'url';
            toggleCsvInputMethod();
            $('csv-url-input').value = remoteUrl;
            loadFromUrl(remoteUrl);
        } else if (params.get('open') === 'csv' && !hash) {
            showCsvTab();
        }
    }

    window.setupCsvViewer = setupCsvViewer;
    window.renderCsvFile = renderCsvFile;
})();
