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

   BC layout confirmed against a real sample (BC-HC-016, sent in chat
   2026-09-30) -- built and verified the same way VPO was, against that
   file's actual pdf.js output. BC's labels fragment across pdf.js items
   more unpredictably than VPO's (see parseLegacyBcPage() below for how
   that's handled), and its "Reason/Explanation:" field sits embedded mid-
   paragraph rather than cleanly above/below its value, unlike every other
   field on either form.

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
        // pdf.js sometimes splits a hyphenated id like "VPO-HC-12-11-55" into
        // separate text items at the kerning gaps around each hyphen, so the
        // concatenated fullText can read "VPO - HC - 12 - 11 - 55" with stray
        // spaces around every dash instead of a tight token. Tolerate that
        // whitespace when matching, then strip it back out of the id itself
        // so downstream code still sees the clean "VPO-HC-12-11-55" form.
        const match = /\b(VPO|BC)\s*-\s*[A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+)*\b/.exec(fullText);
        if (!match) return { kind: null, id: null };
        return { kind: match[1].toLowerCase(), id: match[0].replace(/\s+/g, "") };
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
        // BC's "Vendor /Trade to Be Back Charged:" label, as pdf.js
        // fragments it (see parseLegacyBcPage()'s header comment) --
        // widening valueNear()'s search window (above) means these stray
        // fragments now fall inside it too, so they need to be recognized
        // as label text rather than mistaken for the vendor value.
        /^Vend$/,
        /^or$/,
        /^\/Trade to$/,
        /^Be Ba$/,
        /^ck$/,
        /^d$/,
    ];

    function isLabelItem(item) {
        const str = item.str.trim();
        if (/^[:;,.\-_]+$/.test(str)) return true; // a leftover bare punctuation/underline mark, not a real value
        return ALL_LABEL_PATTERNS.some(p => p.test(str));
    }

    function findOne(items, pattern) {
        return items.find(it => pattern.test(it.str.trim())) || null;
    }

    // See the module comment above: a value's first line normally sits a
    // few points ABOVE the label, to the right of it (xMin bounds how
    // close, xMax bounds how far -- keeping a sibling column's own
    // label/value on the same row from getting swept in). Some of Coleby's
    // older forms instead render the value essentially on the SAME line as
    // the label (offset ~0, occasionally a touch below), so the window is
    // wide enough to catch both layouts -- picking whichever candidate row
    // sits closest to the label rather than assuming a fixed gap.
    //
    // pdf.js can also split one compact value (a date, a dollar amount)
    // into several items on that same row around a kerning gap -- e.g.
    // "6/5" + "/2026". Every item on the chosen row is merged left to
    // right, with no space when the next fragment starts with something
    // other than a letter (still the same token) and a space when it
    // starts with a letter (a genuinely new word).
    function valueNear(items, label, { xMin = 15, xMax = 450, aboveMin = -5, aboveMax = 16, maxLines = 1 } = {}) {
        const candidates = items.filter(it =>
            it !== label && !isLabelItem(it) &&
            it.x > label.x + xMin && it.x <= label.x + xMax &&
            (label.y - it.y) >= aboveMin && (label.y - it.y) <= aboveMax
        );
        if (!candidates.length) return "";

        candidates.sort((a, b) => Math.abs(label.y - a.y) - Math.abs(label.y - b.y));
        const anchor = candidates[0];

        const row = candidates
            .filter(it => Math.abs(it.y - anchor.y) <= 2)
            .sort((a, b) => a.x - b.x);
        let firstLineStr = "";
        row.forEach((it, i) => {
            const str = it.str.trim();
            if (i > 0 && /^[A-Za-z]/.test(str)) firstLineStr += " ";
            firstLineStr += str;
        });

        const collected = [firstLineStr.trim()];
        let cursorY = anchor.y;
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
        // The grand total can render as one item ("$439.77") or, on some of
        // Coleby's older forms, land exactly on the Totals row instead of a
        // few points above it, and/or get split by pdf.js into several items
        // around the "$" or a comma (e.g. "$" + "2" + ",040.00"). Gather
        // everything in that row band, concatenate it left to right (the
        // "Project Additional Cost" label text riding the same row is
        // harmless -- it just doesn't match the amount pattern), and search
        // the combined string instead of requiring one item to match outright.
        const rowText = items
            .filter(it => (totals.y - it.y) >= -5 && (totals.y - it.y) <= 12)
            .sort((a, b) => a.x - b.x)
            .map(it => it.str.trim())
            .join("");
        const match = /\$[\d,]+\.\d{2}/.exec(rowText);
        return match ? match[0] : "";
    }

    function findBuildingNumbers(items, headerPattern = /^Building No\.?$/) {
        const header = findOne(items, headerPattern);
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
        // Accept a 2-digit year too -- some of Coleby's older forms write
        // the effective date as "6/5/26" rather than "6/5/2026".
        const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(str || "");
        if (!m) return "";
        let [, mo, day, yr] = m;
        if (yr.length === 2) yr = `20${yr}`;
        return `${yr}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    /* ---------- VPO (confirmed against a real sample) ---------- */

    function parseLegacyVpoPage(items, fullText) {
        const { id } = findKindAndId(fullText);

        const vendorLabel = findOne(items, /^Name$/); // second line of stacked "Vendor" / "Name"
        const vendorName = vendorLabel ? valueNear(items, vendorLabel, { xMin: 20, xMax: 450, aboveMin: -5, aboveMax: 40 }) : "";

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

    /* ---------- BC (confirmed against a real sample) ---------- */

    // BC's static label text fragments unpredictably at the pdf.js item
    // level in ways VPO's doesn't (e.g. "Vendor /Trade to Be Back Charged:"
    // -> "Vend"/"or"/"/Trade to"/"Be Ba"/"ck"/"Charge"/"d"/":") -- since
    // this is static template text (not user input), the fragmentation is
    // deterministic and repeats identically on every BC PDF from this
    // template, so anchoring on a short unique fragment is safe and
    // repeatable. /^Charge$/ is case-sensitive on purpose, to avoid
    // colliding with the page title's own lowercase "charge".
    function parseLegacyBcPage(items, fullText) {
        const { id } = findKindAndId(fullText);

        const chargeLabel = findOne(items, /^Charge$/);
        const vendorToChargeName = chargeLabel ? valueNear(items, chargeLabel) : "";

        const creditLabel = findOne(items, /^Credit:$/i);
        const vendorToCrBackName = creditLabel ? valueNear(items, creditLabel) : "";

        const projectLabel = findOne(items, /^Project Name:$/);
        const projectNameGuess = projectLabel ? valueNear(items, projectLabel, { xMax: 220 }) : "";

        const effectiveLabel = findOne(items, /ective\s+Date/i);
        const effectiveRaw = effectiveLabel ? valueNear(items, effectiveLabel, { xMax: 200 }) : "";

        // Unlike VPO's "Reason", this form's "Reason/Explanation:" label
        // sits vertically embedded in the middle of a variable-length
        // wrapped paragraph rather than cleanly above/below it -- so
        // instead of valueNear()'s fixed y-offset window, this scans every
        // item in the bounded region between the row above (Requested By)
        // and the row below (the Building table header) and reads them
        // top-to-bottom.
        const requestedByLabel = findOne(items, /^Requested By:$/i);
        const buildingHeader = findOne(items, /^Building$/);
        const reasonRaw = (requestedByLabel && buildingHeader)
            ? items
                .filter(it => it.x > 150 && it.y > requestedByLabel.y && it.y < buildingHeader.y)
                .sort((a, b) => a.y - b.y)
                .map(it => it.str.trim())
                .join(" ")
            : "";

        const buildings = findBuildingNumbers(items, /^Building$/);
        const totalRaw = findTotalsAmount(items);

        return {
            oldId: id || "",
            vendorToChargeName: vendorToChargeName || "",
            vendorToCrBackName: vendorToCrBackName || "",
            projectNameGuess: projectNameGuess || "",
            reportDate: parseDateGuess(effectiveRaw),
            reasonForReport: reasonRaw || "",
            buildings: buildings || "",
            price: parseMoney(totalRaw),
        };
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
