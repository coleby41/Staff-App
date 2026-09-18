/* ===========================================================
   INCIDENT REPORT — PDF generation + attachment merge.

   Shared by pages/account-activity.html (the actual Approve action lives
   there — see approveIncidentReport() in js/account-activity.js). Kept in
   its own file, separate from account-activity.js, since the PDF layout
   is a self-contained concern.

   Two libraries, same split already used elsewhere in this app
   (companies.js's vendor reports use pdfmake to BUILD a PDF from scratch;
   form-builder.js's mergeSubmissionAttachments() uses pdf-lib to COMBINE
   PDFs):
     - pdfmake builds the base Incident Report page (the filled-in form
       itself) as a proper laid-out document — title, letterhead, the
       same three blue-bar sections the paper/Word template uses.
     - pdf-lib then merges that base page with every attached PDF and
       photo (each photo becomes its own full page) into ONE final file.

   Both libraries are already loaded app-wide wherever this file is
   included (see pdf-lib / pdfmake <script> tags already used by
   form-template.html) — this file just needs its own <script> tag added
   next to them on account-activity.html.
=========================================================== */

(function () {
    "use strict";

    // Same "report blue" + logo already used by every other generated PDF
    // in this app (companies.js's vendor reports) — reused here rather
    // than inventing a second shade, so every PDF this app produces reads
    // as one consistent, branded document set.
    const IR_REPORT_RULE_COLOR = "#1E76BD";
    const IR_REPORT_HEADER_TITLE_COLOR = "#595959";
    const IR_REPORT_META_COLOR = "#6B7280";
    const IR_REPORT_LOGO_PATH = "/assets/logos/leewaed-logo.png";

    async function loadIncidentReportLogoDataUrl() {
        try {
            const res = await fetch(IR_REPORT_LOGO_PATH);
            if (!res.ok) return null;
            const blob = await res.blob();
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            console.warn("Couldn't load report logo:", err);
            return null;
        }
    }

    // Matches the original paper/Word template exactly: logo + a single
    // inline "Leeward Construction - Incident Report" heading (not a
    // generic company letterhead with a separate title further down the
    // page).
    function irLetterhead(logoDataUrl) {
        const headerTitle = { text: "Leeward Construction - Incident Report", bold: true, fontSize: 20, color: IR_REPORT_HEADER_TITLE_COLOR, alignment: "left" };
        return {
            margin: [50, 22, 50, 0],
            stack: [
                logoDataUrl
                    ? { columns: [
                          { image: logoDataUrl, width: 55, height: 55 },
                          { ...headerTitle, margin: [12, 16, 0, 0], width: "*" },
                      ] }
                    : headerTitle,
                { canvas: [{ type: "line", x1: 0, y1: 14, x2: 495, y2: 14, lineWidth: 2.5, lineColor: IR_REPORT_RULE_COLOR }] },
            ],
        };
    }

    // Mirrors the paper/Word template's own footer — page count, an
    // attachments note, and the "ID – IR-xxx" stamp — as a 3-column row.
    function irFooter(irNumberText, hasAttachments) {
        return (currentPage, pageCount) => ({
            margin: [50, 10, 50, 0],
            columns: [
                { text: `Page ${currentPage} of ${pageCount} of Incident Report.`, fontSize: 8, color: "#333333", width: "*" },
                hasAttachments
                    ? { text: "Attached below are pictures and invoices for further proof.", fontSize: 8, italics: true, color: "#333333", width: "*", alignment: "center" }
                    : { text: "", width: "*" },
                { text: `ID – ${irNumberText || "IR-PENDING"}`, fontSize: 8, bold: true, color: "#333333", width: "auto", alignment: "right" },
            ],
        });
    }

    function irSectionBar(label) {
        return [{ text: label, bold: true, color: "#ffffff", fontSize: 10.5, alignment: "center" }];
    }

    function irLabelCell(label) {
        return { text: label, bold: true, fontSize: 9.5, margin: [0, 2, 0, 2] };
    }

    function irValueCell(value) {
        return { text: value || "—", fontSize: 10.5, margin: [0, 2, 0, 2] };
    }

    function formatIncidentReportDate(dateStr) {
        if (!dateStr) return "—";
        // dateStr is a plain "YYYY-MM-DD" from the incident_reports.report_date
        // column — parse it as calendar-date parts (not `new Date(dateStr)`,
        // which reads a bare date as UTC midnight and can print the wrong day
        // depending on the viewer's timezone offset).
        const [y, m, d] = dateStr.split("-").map(Number);
        if (!y || !m || !d) return dateStr;
        return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
    }

    function formatIncidentReportCurrency(value) {
        if (value === null || value === undefined || value === "") return "—";
        const num = Number(value);
        if (Number.isNaN(num)) return "—";
        return num.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Converts the rich-text HTML saved by the "Reason for Report" /
    // "Change In Scope" editors (contenteditable fields on
    // pages/incident-report.html, see js/incident-report.js) into a pdfmake
    // content stack -- so Bold/Italic/Underline/headings/lists/links/quotes
    // the reporter applied on-screen still show up formatted in the filed
    // PDF instead of as raw HTML tags. Falls back to a single plain-text
    // line for legacy rows saved before the rich-text editor existed
    // (detected by the absence of a "<" character).
    const IR_RICHTEXT_BASE_TEXT = { fontSize: 10.5, margin: [0, 0, 0, 8], lineHeight: 1.25 };

    function irRichTextInlineToPdf(node, marks) {
        marks = marks || {};
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (!text) return [];
            const run = { text };
            if (marks.bold) run.bold = true;
            if (marks.italics) run.italics = true;
            if (marks.decoration) run.decoration = marks.decoration;
            if (marks.link) { run.link = marks.link; run.color = IR_REPORT_RULE_COLOR; run.decoration = "underline"; }
            return [run];
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return [];
        const tag = node.tagName.toLowerCase();
        if (tag === "br") return [{ text: "\n" }];
        const nextMarks = Object.assign({}, marks);
        if (tag === "b" || tag === "strong") nextMarks.bold = true;
        if (tag === "i" || tag === "em") nextMarks.italics = true;
        if (tag === "u") nextMarks.decoration = "underline";
        if (tag === "a") nextMarks.link = node.getAttribute("href") || "";
        let out = [];
        node.childNodes.forEach((child) => { out = out.concat(irRichTextInlineToPdf(child, nextMarks)); });
        return out;
    }

    function irRichTextBlockToPdf(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            return text ? [Object.assign({ text }, IR_RICHTEXT_BASE_TEXT)] : [];
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return [];
        const tag = node.tagName.toLowerCase();

        if (tag === "ul" || tag === "ol") {
            const items = Array.from(node.children)
                .filter((li) => li.tagName.toLowerCase() === "li")
                .map((li) => ({ text: irRichTextInlineToPdf(li) }))
                .filter((item) => item.text.length);
            if (!items.length) return [];
            const listBlock = tag === "ul" ? { ul: items } : { ol: items };
            return [Object.assign(listBlock, { fontSize: 10.5, margin: [0, 0, 0, 8] })];
        }
        if (tag === "blockquote") {
            let inner = [];
            node.childNodes.forEach((child) => { inner = inner.concat(irRichTextBlockToPdf(child)); });
            return inner.length ? [{ stack: inner, italics: true, color: "#4b5563", margin: [10, 0, 0, 8] }] : [];
        }
        if (tag === "h1" || tag === "h2" || tag === "h3") {
            const size = tag === "h1" ? 14.5 : (tag === "h2" ? 13 : 11.5);
            const inline = irRichTextInlineToPdf(node);
            return inline.length ? [{ text: inline, bold: true, fontSize: size, margin: [0, 2, 0, 6] }] : [];
        }
        if (tag === "p" || tag === "div" || tag === "li") {
            const inline = irRichTextInlineToPdf(node);
            return inline.length ? [Object.assign({ text: inline }, IR_RICHTEXT_BASE_TEXT)] : [];
        }
        // Unrecognized wrapper -- recurse into its children rather than
        // silently dropping whatever content it holds.
        let out = [];
        node.childNodes.forEach((child) => { out = out.concat(irRichTextBlockToPdf(child)); });
        return out;
    }

    // Plain-text rendering of the same rich-text HTML, for spots that just
    // need a short preview (e.g. the report card on account-activity.html) --
    // not something that needs pdfmake's inline/list structure.
    function irRichTextToPlainText(html) {
        if (!html) return "";
        if (!html.includes("<")) return html;
        // Insert a space at block/line boundaries before reading textContent,
        // otherwise adjacent blocks ("<p>A</p><p>B</p>") read back as one
        // run-together word ("AB") instead of "A B".
        const spaced = html.replace(/<\/(p|div|li|h1|h2|h3|blockquote)>|<br\s*\/?>/gi, " $&");
        const container = document.createElement("div");
        container.innerHTML = spaced;
        return (container.textContent || "").replace(/\s+/g, " ").trim();
    }

    function irRichTextHtmlToPdfStack(html, emptyText) {
        if (!html) return [Object.assign({ text: emptyText || "—" }, IR_RICHTEXT_BASE_TEXT)];
        if (!html.includes("<")) return [Object.assign({ text: html }, IR_RICHTEXT_BASE_TEXT)];

        const container = document.createElement("div");
        container.innerHTML = html;
        let stack = [];
        container.childNodes.forEach((node) => { stack = stack.concat(irRichTextBlockToPdf(node)); });
        if (!stack.length) return [Object.assign({ text: emptyText || "—" }, IR_RICHTEXT_BASE_TEXT)];
        return stack;
    }

    // Builds the base Incident Report page as a pdf-lib-ready Uint8Array
    // (pdfmake's own PDF bytes, not yet merged with any attachments).
    async function buildIncidentReportBasePdfBytes(report, project, irNumberText) {
        if (typeof pdfMake === "undefined") {
            throw new Error("Report library failed to load. Refresh and try again.");
        }

        const logoDataUrl = await loadIncidentReportLogoDataUrl();
        const hasAttachments = Array.isArray(report.attachments) && report.attachments.length > 0;

        const docDefinition = {
            pageMargins: [50, 118, 50, 60],
            header: irLetterhead(logoDataUrl),
            footer: irFooter(irNumberText, hasAttachments),
            defaultStyle: { fontSize: 10.5 },

            content: [
                {
                    text: "This form standardizes issue reporting across Leeward properties — capturing the location and cost of a problem, who reported it and why, and who is responsible for causing versus resolving it.",
                    fontSize: 10.5,
                    margin: [0, 0, 0, 10],
                },
                {
                    ul: [
                        { text: [{ text: "Project, Location & Cost — ", bold: true }, "identifies the building/unit and associated repair cost"] },
                        { text: [{ text: "Report Details — ", bold: true }, "records who filed the report, when, and the reason"] },
                        { text: [{ text: "Responsibility — ", bold: true }, "distinguishes the party at fault from the party assigned to resolve the issue, for accountability and cost recovery"] },
                    ],
                    fontSize: 10.5,
                    margin: [0, 0, 0, 14],
                },

                {
                    table: { widths: ["auto", "*"], body: [[irLabelCell("Date:"), irValueCell(formatIncidentReportDate(report.report_date))]] },
                    layout: { hLineWidth: () => 0.75, vLineWidth: () => 0.75, hLineColor: () => "#c7ccd1", vLineColor: () => "#c7ccd1" },
                    margin: [0, 0, 0, 14],
                },

                {
                    table: {
                        widths: ["*", "*"],
                        body: [
                            [{ colSpan: 2, fillColor: IR_REPORT_RULE_COLOR, stack: irSectionBar("PROJECT, LOCATION & COST") }, {}],
                            [irLabelCell("Project Name:"), irLabelCell("Price:")],
                            [irValueCell(project?.name || "—"), irValueCell(formatIncidentReportCurrency(report.price))],
                            [irLabelCell("Building(s):"), irLabelCell("Unit Number(s):")],
                            [irValueCell(report.buildings), irValueCell(report.unit_numbers)],
                        ],
                    },
                    layout: { hLineWidth: () => 0.75, vLineWidth: () => 0.75, hLineColor: () => "#c7ccd1", vLineColor: () => "#c7ccd1" },
                    margin: [0, 0, 0, 14],
                },

                {
                    table: {
                        widths: ["*"],
                        body: [
                            [{ fillColor: IR_REPORT_RULE_COLOR, stack: irSectionBar("REPORT DETAILS") }],
                            [irLabelCell("Person Making the Report:")],
                            [irValueCell(report.person_making_report)],
                            [irLabelCell("Reason for Report:")],
                            [{ stack: irRichTextHtmlToPdfStack(report.reason_for_report, "—"), margin: [0, 2, 0, 0] }],
                            [irLabelCell("Change In Scope:")],
                            [{ stack: irRichTextHtmlToPdfStack(report.change_in_scope, "—"), margin: [0, 2, 0, 0] }],
                        ],
                    },
                    layout: { hLineWidth: () => 0.75, vLineWidth: () => 0.75, hLineColor: () => "#c7ccd1", vLineColor: () => "#c7ccd1" },
                    margin: [0, 0, 0, 14],
                },

                {
                    table: {
                        widths: ["*"],
                        body: [
                            [{ fillColor: IR_REPORT_RULE_COLOR, stack: irSectionBar("RESPONSIBILITY") }],
                            [irLabelCell("Who Caused the Issue:")],
                            [irValueCell(report.who_caused_issue)],
                        ],
                    },
                    layout: { hLineWidth: () => 0.75, vLineWidth: () => 0.75, hLineColor: () => "#c7ccd1", vLineColor: () => "#c7ccd1" },
                    margin: [0, 0, 0, 4],
                },
            ],
        };

        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        return new Uint8Array(await blob.arrayBuffer());
    }

    function guessAttachmentKind(name) {
        const ext = (name || "").toLowerCase().split(".").pop();
        if (["jpg", "jpeg", "png"].includes(ext)) return "image";
        return "pdf";
    }

    // Downloads every attachment's original bytes from the private
    // incident-report-attachments bucket and merges them onto the end of
    // the base PDF — the form's own page(s) first, then each attachment in
    // the order it was added, same "base pages first" convention as
    // form-builder.js's mergeSubmissionAttachments(). A PDF attachment's
    // pages are copied in as-is; a photo becomes one new full page, scaled
    // to fit a standard Letter page with a small margin, preserving its
    // aspect ratio.
    async function mergeIncidentReportAttachments(baseBytes, attachments, supabaseClient) {
        const mergedDoc = await PDFLib.PDFDocument.create();

        const baseDoc = await PDFLib.PDFDocument.load(baseBytes);
        const basePages = await mergedDoc.copyPages(baseDoc, baseDoc.getPageIndices());
        basePages.forEach(p => mergedDoc.addPage(p));

        for (const attachment of (attachments || [])) {
            const { data, error } = await supabaseClient.storage
                .from("incident-report-attachments")
                .download(attachment.path);
            if (error || !data) {
                throw new Error(`Couldn't read "${attachment.name}" while building the merged PDF. Please try approving again.`);
            }
            const bytes = new Uint8Array(await data.arrayBuffer());
            const kind = attachment.kind || guessAttachmentKind(attachment.name);

            if (kind === "image") {
                const ext = (attachment.name || "").toLowerCase().split(".").pop();
                let embedded;
                try {
                    embedded = ext === "png" ? await mergedDoc.embedPng(bytes) : await mergedDoc.embedJpg(bytes);
                } catch (err) {
                    throw new Error(`"${attachment.name}" isn't a valid photo and couldn't be added.`);
                }
                // US Letter, 0.5" margins on all sides.
                const pageWidth = 612, pageHeight = 792, margin = 36;
                const maxW = pageWidth - margin * 2, maxH = pageHeight - margin * 2;
                const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
                const drawW = embedded.width * scale, drawH = embedded.height * scale;
                const page = mergedDoc.addPage([pageWidth, pageHeight]);
                page.drawImage(embedded, {
                    x: (pageWidth - drawW) / 2,
                    y: (pageHeight - drawH) / 2,
                    width: drawW,
                    height: drawH,
                });
            } else {
                let attachDoc;
                try {
                    attachDoc = await PDFLib.PDFDocument.load(bytes);
                } catch (err) {
                    throw new Error(`"${attachment.name}" isn't a valid PDF and couldn't be added.`);
                }
                const pages = await mergedDoc.copyPages(attachDoc, attachDoc.getPageIndices());
                pages.forEach(p => mergedDoc.addPage(p));
            }
        }

        return mergedDoc.save();
    }

    // Public entry point used by account-activity.js: builds the base page
    // AND merges attachments in one call, returning the final Uint8Array
    // ready to upload.
    async function buildMergedIncidentReportPdf(report, project, irNumberText, supabaseClient) {
        const baseBytes = await buildIncidentReportBasePdfBytes(report, project, irNumberText);
        return mergeIncidentReportAttachments(baseBytes, report.attachments, supabaseClient);
    }

    window.IncidentReportPdf = {
        buildMergedIncidentReportPdf,
        buildIncidentReportBasePdfBytes,
        formatIncidentReportCurrency,
        formatIncidentReportDate,
        richTextToPlainText: irRichTextToPlainText,
    };
})();
