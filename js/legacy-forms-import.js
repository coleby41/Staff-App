/* ===========================================================
   LEGACY FORMS IMPORT (Form Logs' "Submit Old Forms" feature)

   Client-side parsing of old VPO/BC "Work Authorization" PDFs into the
   fields the new IR->VPO/BC schema expects, so ~100 old records can be
   migrated without hand-typing each one (Coleby, 2026-09-26/28). No AI
   API, no server call -- these are clean digitally-generated PDFs (not
   scans, confirmed against a real sample), so pdf.js's text layer +
   known label positions is enough. Loaded once by pages/project-form-
   logs.html; used by js/project-form-logs.js's "Submit Old Forms" flow.

   Kind (BC/VPO) is auto-detected from the "VPO-..."/"BC-..." id text
   embedded on the page itself, not asked of the user -- Coleby: batch
   upload, not one at a time, and this is one less thing to pick per file.

   VPO layout confirmed against a real sample (VPO-HC-11-11-56, sent in
   chat 2026-09-28) -- Coleby confirmed this "Work Authorization" layout
   is standard across his ~100 old VPOs. The extraction logic below was
   built and verified against that real file's actual pdf.js output
   (every field read back correctly) before being wired into the app.

   BC layout is NOT YET implemented -- no real BC sample has been seen.
   parseLegacyBcPage() is a stub that always returns `unsupported: true`;
   BC files still show up in the batch review table (nothing silently
   disappears) but can't be created until a real BC sample comes in and
   this gets filled in the same way VPO was.

   A note on the text layer, for whoever touches this next: these PDFs
   were produced by a fill-in tool ("Pdftools SDK" per their own
   metadata) that mangles a few labels through a font-ligature bug --
   "Effective" extracts as "Eﬀec/ve", "Reason/Explanation:" splits into
   separate "Reason"/"/Explana/on"/":" items. The regexes below match
   loosely around this rather than expecting exact label text.

   The other real quirk this form has: a field's VALUE sits a few points
   ABOVE its own label's line (not beside or below it, the way a form
   normally reads) -- e.g. "MAC Products Company Inc." renders above the
   "Vendor Name" label with a blank line under it. Every helper below
   searches upward from the label for a first value line, then downward
   from THAT for any wrapped continuation lines.
=========================================================== */

window.LegacyFormsImport = (function () {
    "use strict";

    const PDFJS_VERSION = "3.11.174";
    let pdfjsReadyPromise = null;

    // Loaded lazily -- only the first time "Submit Old Forms" is actually
    // used, not on every Form Logs page load.
    function ensurePdfJsLoaded() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (pdfjsReadyPromise) return pdfjsReadyPromise;

        pdfjsReadyPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
            script.onload = () => {
                try {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
                    resolve(window.pdfjsLib);
                } catch (err) {
                    reject(err);
                }
            };
            script.onerror = () => reject(new Error("Couldn't load the PDF reader library — check your connection and try again."));
            document.head.appendChild(script);
        });
        return pdfjsReadyPromise;
    }

    // Every item on the page, positioned top-down (y = distance from the
    // top of the page) so the coordinates read the same way the page
    // visually looks -- pdf.js's own transform gives a bottom-up y.
    async function getPageItems(pdfDoc, pageNum) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        return content.items
            .map(item => ({ str: item.str, x: item.transform[4], y: viewport.height - item.transform[5] }))
            .filter(it => it.str && it.str.trim());
    }

    /* ---------- generic field-finding helpers ---------- */

    function findKindAndId(fullText) {
        const match = /\b(VPO|BC)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/.exec(fullText);
        if (!match) return { kind: null, id: null };
        return { kind: match[1].toLowerCase(), id: match[0] };
    }

    const ALL_LABEL_PATTERNS = [
        /^Vendor$/,
        /^Name$/,
        /^Project Name:$/,
        /^E.+ec.+ve$/i,
        /^Date(\(s\))?:?$/i,
        /^Requested By:$/i,
        /^Reason$/i,
        /^Reason.{0,3}Explan/i,
        /^\/Explan/i,
    ];

    function isLabelItem(item) {
        const str = item.str.trim();
        if (/^[:;,.\-]+$/.test(str)) return true; // a leftover bare punctuation mark, not a real value
        return ALL_LABEL_PATTERNS.some(p => p.test(str));
    }

    function findOne(items, pattern) {
        return items.find(it => pattern.test(it.str.trim())) || null;
    }

    // See the module comment above: a value's first line sits `aboveMin`-
    // `aboveMax` points ABOVE the label, to the right of it (xMin bounds
    // how close, xMax bounds how far -- keeping a sibling column's own
    // label/value on the same row from getting swept in); wrapped
    // continuation lines then run downward from that first line.
    function valueNear(items, label, { xMin = 15, xMax = 450, aboveMin = 4, aboveMax = 16, maxLines = 1 } = {}) {
        const firstLine = items.find(it =>
            it !== label && !isLabelItem(it) &&
            it.x > label.x + xMin && it.x <= label.x + xMax &&
            (label.y - it.y) >= aboveMin && (label.y - it.y) <= aboveMax
        );
        if (!firstLine) return "";

        const collected = [firstLine.str.trim()];
        let cursorY = firstLine.y;
        for (let i = 1; i < maxLines; i++) {
            const nextLine = items.find(it =>
                !isLabelItem(it) &&
                it.x > label.x - 10 && it.x <= label.x + xMax &&
                (it.y - cursorY) > 6 && (it.y - cursorY) <= 20
            );
            if (!nextLine) break;
            collected.push(nextLine.str.trim());
            cursorY = nextLine.y;
        }
        return collected.join(" ").trim();
    }

    function findTotalsAmount(items) {
        const totals = findOne(items, /^Totals$/);
        if (!totals) return "";
        const amount = items.find(it => (totals.y - it.y) >= 4 && (totals.y - it.y) <= 12 && /^\$[\d,]+\.\d{2}$/.test(it.str.trim()));
        return amount ? amount.str.trim() : "";
    }

    function findBuildingNumbers(items) {
        const header = findOne(items, /^Building No\.?$/);
        const totals = findOne(items, /^Totals$/);
        if (!header) return "";
        const yCeiling = totals ? totals.y - 5 : header.y + 300;
        const values = items.filter(it =>
            it.y > header.y + 5 && it.y < yCeiling &&
            it.x >= header.x - 15 && it.x <= header.x + 60 &&
            /^[A-Za-z0-9.\-]+$/.test(it.str.trim())
        );
        const unique = [...new Set(values.map(it => it.str.trim()))];
        return unique.join(", ");
    }

    function parseMoney(str) {
        if (!str) return null;
        const n = parseFloat(str.replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) ? n : null;
    }

    function parseDateGuess(str) {
        const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str || "");
        if (!m) return "";
        const [, mo, day, yr] = m;
        return `${yr}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    /* ---------- VPO (confirmed against a real sample) ---------- */

    function parseLegacyVpoPage(items, fullText) {
        const { id } = findKindAndId(fullText);

        const vendorLabel = findOne(items, /^Name$/); // second line of stacked "Vendor" / "Name"
        const vendorName = vendorLabel ? valueNear(items, vendorLabel, { xMin: 20, xMax: 450, aboveMin: 4, aboveMax: 40 }) : "";

        const projectLabel = findOne(items, /^Project Name:$/);
        // Narrow xMax -- this table cell is only ~80pt of actual text
        // wide; a wide window here reaches into the Effective Date cell
        // sitting in the same row, just further right.
        const projectNameGuess = projectLabel ? valueNear(items, projectLabel, { xMax: 140, maxLines: 2 }) : "";

        const effectiveLabel = findOne(items, /^E.+ec.+ve$/i);
        const effectiveRaw = effectiveLabel ? valueNear(items, effectiveLabel, { xMax: 300 }) : "";

        const reasonLabel = findOne(items, /^Reason$/i) || findOne(items, /^Reason.{0,3}Explan/i);
        const reasonRaw = reasonLabel ? valueNear(items, reasonLabel, { maxLines: 3 }) : "";

        const buildings = findBuildingNumbers(items);
        const totalRaw = findTotalsAmount(items);

        return {
            oldId: id || "",
            vendorName: vendorName || "",
            projectNameGuess: projectNameGuess || "",
            reportDate: parseDateGuess(effectiveRaw),
            reasonForReport: reasonRaw || "",
            buildings: buildings || "",
            price: parseMoney(totalRaw),
        };
    }

    /* ---------- BC (not built yet -- no real sample seen) ---------- */

    function parseLegacyBcPage() {
        return { unsupported: true };
    }

    /* ---------- entry point ---------- */

    // Returns one result object per file. Never throws -- a parse failure
    // comes back as { error } so one bad file in a batch doesn't stop the
    // rest from being read.
    async function parseLegacyForm(file) {
        try {
            const pdfjsLib = await ensurePdfJsLoaded();
            const buffer = await file.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
            const items = await getPageItems(pdfDoc, 1);
            const fullText = items.map(it => it.str).join(" ");

            const { kind } = findKindAndId(fullText);
            if (!kind) {
                return { fileName: file.name, file, kind: null, error: "Couldn't find a VPO-/BC- id on this PDF — is it one of the old forms?" };
            }

            const parsed = kind === "vpo" ? parseLegacyVpoPage(items, fullText) : parseLegacyBcPage(items, fullText);
            return { fileName: file.name, file, kind, pageCount: pdfDoc.numPages, ...parsed };
        } catch (err) {
            console.error("Failed to parse", file.name, err);
            return { fileName: file.name, file, kind: null, error: err.message || "Couldn't read this PDF." };
        }
    }

    return { parseLegacyForm };
})();
