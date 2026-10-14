/* ===========================================================
   PROJECT PHOTOS (phones only, project Overview page)

   A round camera button above the tab bar. Tapping it offers:
     - Take project photos: a camera built into the portal, in a half-page
       sheet. Shoot as many as you need, with a vertical +/- zoom control
       next to the shutter (pinch on the viewfinder works too).
     - Upload project photos: the phone's photo library (pick several).
   Both end on a Review sheet; Upload saves every photo to this project's
   09 Marketing › Photography folder (project_files + the
   project-documents bucket, same as an upload on the Files page).

   Zoom uses the camera's real zoom where the browser exposes it (Chrome on
   Android, Safari on iOS 17+); otherwise it zooms digitally by cropping
   the frame, so the control always works.

   Loaded only on pages/projects.html. Needs project-fields.js (uploadFile)
   and listens for project-shell.js's "project-shell:ready" event.
=========================================================== */
(function () {
    "use strict";

    const PHONE_QUERY = "(max-width: 768px)";
    const CATEGORY = "marketing";
    const SUBFOLDER = "photography";
    const FOLDER_LABEL = "09 Marketing › Photography";
    const FILES_TABLE = "project_files";
    const BUCKET = "project-documents";
    const DIGITAL_MAX_ZOOM = 5;
    const ZOOM_STEP = 0.5;

    let project = null;
    let photos = [];         // { file: File, url: objectURL }
    let source = "camera";   // "camera" | "upload" — which way Review's "add more" button goes
    let cameraMode = "photos"; // "photos" | "invoice" — invoice pages go to the invoice form, not Review
    let invoiceResume = false; // true while the invoice form is hidden so more pages can be photographed
    let uploading = false;

    // camera state
    let stream = null;
    let track = null;
    let zoom = 1;
    let zoomMin = 1;
    let zoomMax = DIGITAL_MAX_ZOOM;
    let hardwareZoom = false;
    let torchOn = false;
    let shotSeq = 0;
    let pendingShots = 0;    // captures still being encoded (toBlob is async)

    function waitForShots() {
        return new Promise(resolve => {
            const check = () => (pendingShots > 0 ? setTimeout(check, 40) : resolve());
            check();
        });
    }

    const ICONS = {
        receipt: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>',
        fileUp: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6M9 15l3-3 3 3"/></svg>',
        camera: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
        image: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        minus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
        flash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
        file: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>',
        folder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
        x: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    };

    const $ = (sel, root) => (root || document).querySelector(sel);

    function escapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function isPhone() {
        return window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : window.innerWidth <= 768;
    }

    function staffName() {
        let profile = window.currentSupabaseProfile;
        if (!profile) { try { profile = JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (e) { profile = null; } }
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function toast(message, type) {
        if (typeof window.showToast === "function") window.showToast(message, { type: type || "success" });
    }

    /* ---------- markup ---------- */

    let fab, scrim, menu, sheet, libraryInput, fallbackInput, invoiceInput;

    function build() {
        fab = document.createElement("button");
        fab.type = "button";
        fab.className = "photo-fab";
        fab.setAttribute("aria-label", "Project photos");
        fab.setAttribute("aria-expanded", "false");
        fab.innerHTML = '<span class="photo-fab-icon photo-fab-icon--camera">' + ICONS.camera + '</span><span class="photo-fab-icon photo-fab-icon--close">' + ICONS.close + '</span>';

        scrim = document.createElement("div");
        scrim.className = "photo-scrim";

        menu = document.createElement("div");
        menu.className = "photo-menu";
        menu.setAttribute("role", "menu");
        menu.innerHTML =
            '<button type="button" class="photo-menu-opt" role="menuitem" data-photo-action="menu-take">' +
                '<span class="photo-menu-icon">' + ICONS.camera + '</span>' +
                '<span><strong>Take project photos</strong><small>Snap as many as you need</small></span>' +
            '</button>' +
            '<button type="button" class="photo-menu-opt" role="menuitem" data-photo-action="menu-upload">' +
                '<span class="photo-menu-icon">' + ICONS.image + '</span>' +
                '<span><strong>Upload project photos</strong><small>Choose from your photo library</small></span>' +
            '</button>' +
            '<button type="button" class="photo-menu-opt" role="menuitem" data-photo-action="menu-take-invoice">' +
                '<span class="photo-menu-icon photo-menu-icon--invoice">' + ICONS.receipt + '</span>' +
                '<span><strong>Take project invoices</strong><small>Snap a photo of each page</small></span>' +
            '</button>' +
            '<button type="button" class="photo-menu-opt" role="menuitem" data-photo-action="menu-upload-invoice">' +
                '<span class="photo-menu-icon photo-menu-icon--invoice">' + ICONS.fileUp + '</span>' +
                '<span><strong>Upload project invoices</strong><small>Photos or PDFs from your phone</small></span>' +
            '</button>';

        sheet = document.createElement("section");
        sheet.className = "photo-sheet";
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "true");

        libraryInput = document.createElement("input");
        libraryInput.type = "file";
        libraryInput.accept = "image/*";
        libraryInput.multiple = true;
        libraryInput.hidden = true;

        // Only used if the built-in camera can't start (permission denied,
        // no camera API): falls back to the phone's own camera screen.
        fallbackInput = document.createElement("input");
        fallbackInput.type = "file";
        fallbackInput.accept = "image/*";
        fallbackInput.setAttribute("capture", "environment");
        fallbackInput.hidden = true;

        invoiceInput = document.createElement("input");
        invoiceInput.type = "file";
        invoiceInput.accept = "image/*,application/pdf";
        invoiceInput.multiple = true;
        invoiceInput.hidden = true;

        document.body.append(fab, scrim, menu, sheet, libraryInput, fallbackInput, invoiceInput);
        document.body.classList.add("has-photo-fab");

        fab.addEventListener("click", () => {
            if (document.body.classList.contains("photo-menu-open")) closeMenu();
            else openMenu();
        });
        scrim.addEventListener("click", () => {
            // The scrim only dismisses the small menu, never a sheet with photos in it.
            if (document.body.classList.contains("photo-menu-open")) closeMenu();
        });
        menu.addEventListener("click", (e) => {
            const opt = e.target.closest("[data-photo-action]");
            if (!opt) return;
            const act = opt.dataset.photoAction;
            if (act === "menu-take-invoice") {
                closeMenu();
                cameraMode = "invoice";
                invoiceResume = false;
                openCamera();
            } else if (act === "menu-upload-invoice") {
                closeMenu();
                invoiceInput.click();
            } else if (act === "menu-take") {
                closeMenu();
                source = "camera";
                cameraMode = "photos";
                openCamera();
            } else {
                closeMenu();
                source = "upload";
                libraryInput.click();
            }
        });
        invoiceInput.addEventListener("change", () => {
            const files = Array.from(invoiceInput.files || []);
            invoiceInput.value = "";
            if (files.length) openInvoiceForm(files);
        });
        libraryInput.addEventListener("change", () => {
            const files = Array.from(libraryInput.files || []);
            libraryInput.value = "";
            addFiles(files);
            if (photos.length) openReview();
        });
        fallbackInput.addEventListener("change", () => {
            const files = Array.from(fallbackInput.files || []);
            fallbackInput.value = "";
            addFiles(files);
            if (cameraMode === "invoice") { stopCamera(); finishInvoiceCamera(); return; }
            if (photos.length) openReview();
        });
        sheet.addEventListener("click", onSheetClick);

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (document.body.classList.contains("photo-menu-open")) closeMenu();
        });

        // Leaving the page or switching apps: turn the camera off.
        document.addEventListener("visibilitychange", () => {
            if (document.hidden && stream) stopCamera();
            else if (!document.hidden && sheet.dataset.view === "camera" && !stream) startCamera();
        });

        window.addEventListener("resize", () => {
            if (!isPhone()) closeEverything();
        });
    }

    /* ---------- menu ---------- */

    function openMenu() {
        if (!isPhone()) return;
        document.body.classList.add("photo-menu-open");
        fab.setAttribute("aria-expanded", "true");
        fab.setAttribute("aria-label", "Close photo options");
    }

    function closeMenu() {
        document.body.classList.remove("photo-menu-open");
        fab.setAttribute("aria-expanded", "false");
        fab.setAttribute("aria-label", "Project photos");
    }

    /* ---------- sheet ---------- */

    function showSheet(view) {
        sheet.dataset.view = view;
        document.body.classList.add("photo-sheet-open");
    }

    function closeSheet() {
        stopCamera();
        document.body.classList.remove("photo-sheet-open");
        sheet.dataset.view = "";
    }

    function closeEverything() {
        closeMenu();
        closeSheet();
        clearPhotos();
    }

    function sheetHead(title, subtitle, actionLabel) {
        return '<div class="photo-sheet-handle"><span></span></div>' +
            '<div class="photo-sheet-head">' +
                '<div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(subtitle) + '</p></div>' +
                '<button type="button" class="photo-sheet-cancel" data-photo-action="cancel">' + escapeHtml(actionLabel || "Cancel") + '</button>' +
            '</div>';
    }

    function onSheetClick(e) {
        const btn = e.target.closest("[data-photo-action]");
        if (!btn || btn.disabled) return;
        const action = btn.dataset.photoAction;

        if (action === "cancel") {
            if (uploading) return;
            if (cameraMode === "invoice" && invoiceResume) {
                // Back to the invoice form without adding pages.
                clearPhotos();
                closeSheet();
                invoiceResume = false;
                cameraMode = "photos";
                if (window.ProjectInvoices) window.ProjectInvoices.resumeForm([]);
                return;
            }
            cameraMode = "photos";
            closeEverything();
        } else if (action === "shutter") {
            capture();
        } else if (action === "zoom-in") {
            setZoom(zoom + ZOOM_STEP);
        } else if (action === "zoom-out") {
            setZoom(zoom - ZOOM_STEP);
        } else if (action === "torch") {
            toggleTorch();
        } else if (action === "done") {
            btn.disabled = true;
            waitForShots().then(() => {
                stopCamera();
                if (cameraMode === "invoice") finishInvoiceCamera();
                else if (photos.length) openReview();
                else closeEverything();
            });
            return;
        } else if (action === "more") {
            if (source === "upload") libraryInput.click();
            else openCamera();
        } else if (action === "remove") {
            removePhoto(Number(btn.dataset.index));
        } else if (action === "upload") {
            uploadAll();
        } else if (action === "fallback") {
            fallbackInput.click();
        }
    }

    /* ---------- photos ---------- */

    function addFiles(files) {
        files.filter(f => f && (/^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)))
            .forEach(file => photos.push({ file, url: URL.createObjectURL(file) }));
    }

    function removePhoto(index) {
        const p = photos[index];
        if (!p) return;
        URL.revokeObjectURL(p.url);
        photos.splice(index, 1);
        if (!photos.length) closeEverything();
        else renderReview();
    }

    function clearPhotos() {
        photos.forEach(p => URL.revokeObjectURL(p.url));
        photos = [];
    }

    function stamp() {
        const d = new Date();
        const pad = n => String(n).padStart(2, "0");
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    /* ---------- camera ---------- */

    function openCamera() {
        sheet.innerHTML =
            (cameraMode === "invoice"
                ? sheetHead("Take invoice photos", "One photo per page · saved as one PDF")
                : sheetHead("Take photos", project ? (project.name || "Untitled project") : "")) +
            '<div class="photo-viewfinder">' +
                '<video playsinline muted autoplay></video>' +
                '<div class="photo-viewfinder-msg">Starting camera…</div>' +
                '<button type="button" class="photo-vf-btn photo-vf-torch" data-photo-action="torch" aria-label="Flash" aria-pressed="false" hidden>' + ICONS.flash + '</button>' +
                '<div class="photo-vf-count" hidden></div>' +
                '<div class="photo-vf-zoom">1.0×</div>' +
                '<div class="photo-vf-flash"></div>' +
            '</div>' +
            '<div class="photo-camera-bar">' +
                '<div class="photo-thumbs" aria-hidden="true"></div>' +
                '<div class="photo-camera-center">' +
                    '<button type="button" class="photo-shutter" data-photo-action="shutter" aria-label="Take photo" disabled><span></span></button>' +
                    '<div class="photo-zoom" role="group" aria-label="Zoom">' +
                        '<button type="button" data-photo-action="zoom-in" aria-label="Zoom in">' + ICONS.plus + '</button>' +
                        '<span class="photo-zoom-value" aria-live="polite">1.0×</span>' +
                        '<button type="button" data-photo-action="zoom-out" aria-label="Zoom out">' + ICONS.minus + '</button>' +
                    '</div>' +
                '</div>' +
                '<div class="photo-camera-done"><button type="button" class="photo-done" data-photo-action="done">Done</button></div>' +
            '</div>';
        showSheet("camera");
        renderCameraCount();
        wirePinch($(".photo-viewfinder", sheet));
        startCamera();
    }

    async function startCamera() {
        const msg = $(".photo-viewfinder-msg", sheet);
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showCameraError("This browser can't run the built-in camera.");
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }
            });
        } catch (err) {
            console.warn("Camera unavailable:", err);
            showCameraError(err && err.name === "NotAllowedError"
                ? "Camera access is turned off for this site."
                : "Couldn't start the camera.");
            return;
        }
        // The sheet may have been closed while the permission prompt was up.
        if (sheet.dataset.view !== "camera") { stopCamera(); return; }

        track = stream.getVideoTracks()[0] || null;
        const video = $(".photo-viewfinder video", sheet);
        video.srcObject = stream;
        try { await video.play(); } catch (e) { /* autoplay attr covers it */ }
        if (msg) msg.hidden = true;
        $(".photo-shutter", sheet).disabled = false;

        // Real zoom if the camera exposes it; else digital (crop) zoom.
        const caps = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
        if (caps && caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > caps.zoom.min) {
            hardwareZoom = true;
            zoomMin = Math.max(caps.zoom.min, 1);
            zoomMax = Math.min(caps.zoom.max, 10);
            const settings = track.getSettings ? track.getSettings() : {};
            zoom = settings.zoom ? Math.max(zoomMin, settings.zoom) : zoomMin;
        } else {
            hardwareZoom = false;
            zoomMin = 1;
            zoomMax = DIGITAL_MAX_ZOOM;
        }
        const torchBtn = $(".photo-vf-torch", sheet);
        if (torchBtn) torchBtn.hidden = !(caps && caps.torch);
        torchOn = false;
        setZoom(zoom);
    }

    function showCameraError(text) {
        const msg = $(".photo-viewfinder-msg", sheet);
        if (!msg) return;
        msg.hidden = false;
        msg.innerHTML = '<span>' + escapeHtml(text) + '</span>' +
            '<button type="button" class="photo-fallback" data-photo-action="fallback">Use the phone\'s camera</button>';
    }

    function stopCamera() {
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = null;
        track = null;
        torchOn = false;
    }

    function setZoom(value) {
        zoom = Math.min(zoomMax, Math.max(zoomMin, Math.round(value * 10) / 10));
        const label = zoom.toFixed(1) + "×";
        sheet.querySelectorAll(".photo-zoom-value, .photo-vf-zoom").forEach(el => { el.textContent = label; });
        const zIn = $('[data-photo-action="zoom-in"]', sheet);
        const zOut = $('[data-photo-action="zoom-out"]', sheet);
        if (zIn) zIn.disabled = zoom >= zoomMax;
        if (zOut) zOut.disabled = zoom <= zoomMin;

        const video = $(".photo-viewfinder video", sheet);
        if (hardwareZoom && track) {
            if (video) video.style.transform = "";
            track.applyConstraints({ advanced: [{ zoom }] }).catch(err => console.warn("Zoom failed:", err));
        } else if (video) {
            video.style.transform = zoom > 1 ? "scale(" + zoom + ")" : "";
        }
    }

    async function toggleTorch() {
        if (!track) return;
        try {
            await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
            torchOn = !torchOn;
            const btn = $(".photo-vf-torch", sheet);
            if (btn) { btn.setAttribute("aria-pressed", String(torchOn)); btn.classList.toggle("is-on", torchOn); }
        } catch (err) {
            console.warn("Flash failed:", err);
        }
    }

    function wirePinch(el) {
        let startDist = 0;
        let startZoom = 1;
        const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        el.addEventListener("touchstart", (e) => {
            if (e.touches.length === 2) { startDist = dist(e.touches); startZoom = zoom; }
        }, { passive: true });
        el.addEventListener("touchmove", (e) => {
            if (e.touches.length !== 2 || !startDist) return;
            e.preventDefault();
            setZoom(startZoom * (dist(e.touches) / startDist));
        }, { passive: false });
        el.addEventListener("touchend", (e) => { if (e.touches.length < 2) startDist = 0; });
    }

    function capture() {
        const video = $(".photo-viewfinder video", sheet);
        if (!video || !video.videoWidth || !stream) return;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // Digital zoom keeps the centre 1/zoom of the frame.
        const crop = hardwareZoom ? 1 : zoom;
        const sw = Math.round(vw / crop);
        const sh = Math.round(vh / crop);
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext("2d").drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, sw, sh);

        const flash = $(".photo-vf-flash", sheet);
        if (flash) { flash.classList.remove("is-on"); void flash.offsetWidth; flash.classList.add("is-on"); }

        pendingShots++;
        canvas.toBlob((blob) => {
            pendingShots = Math.max(0, pendingShots - 1);
            if (!blob) return;
            shotSeq++;
            const file = new File([blob], "photo-" + stamp() + "-" + shotSeq + ".jpg", { type: "image/jpeg" });
            photos.push({ file, url: URL.createObjectURL(blob) });
            renderCameraCount();
        }, "image/jpeg", 0.9);
    }

    function renderCameraCount() {
        const count = $(".photo-vf-count", sheet);
        if (count) {
            count.hidden = !photos.length;
            count.textContent = cameraMode === "invoice"
                ? (photos.length === 1 ? "1 page" : photos.length + " pages")
                : photos.length + " taken";
        }
        const thumbs = $(".photo-thumbs", sheet);
        if (thumbs) {
            thumbs.innerHTML = photos.slice(-3).map(p => '<img src="' + p.url + '" alt="">').join("");
        }
    }

    /* ---------- invoices (form lives in js/project-invoices.js) ---------- */

    function finishInvoiceCamera() {
        const files = photos.map(p => p.file);
        clearPhotos();
        closeSheet();
        cameraMode = "photos";
        if (invoiceResume) {
            invoiceResume = false;
            if (window.ProjectInvoices) window.ProjectInvoices.resumeForm(files);
            return;
        }
        if (files.length) openInvoiceForm(files);
    }

    function openInvoiceForm(files) {
        if (!window.ProjectInvoices || !project) {
            toast("Invoices aren't available right now. Please refresh and try again.", "error");
            return;
        }
        window.ProjectInvoices.openForm({
            project,
            files,
            onAddFromCamera: () => {
                cameraMode = "invoice";
                invoiceResume = true;
                openCamera();
            },
            onSaved: (inv) => {
                toast("Invoice " + inv.invoice_number + " saved to " + window.ProjectInvoices.FOLDER_LABEL + ".");
            }
        });
    }

    /* ---------- review ---------- */

    function openReview() {
        renderReview();
        showSheet("review");
    }

    function renderReview(errorText) {
        const n = photos.length;
        const title = n === 1 ? "1 photo ready" : n + " photos ready";
        const moreLabel = source === "upload" ? "Add more" : "Take another";
        const moreIcon = source === "upload" ? ICONS.plus : ICONS.camera.replace(/width="26" height="26"/, 'width="18" height="18"');
        sheet.innerHTML =
            sheetHead(title, "Check them before they upload") +
            '<div class="photo-review-body">' +
                '<div class="photo-info"><span class="photo-info-icon">' + ICONS.file + '</span><span><small>PROJECT</small><strong>' + escapeHtml(project ? (project.name || "Untitled project") : "") + '</strong></span></div>' +
                '<div class="photo-info"><span class="photo-info-icon">' + ICONS.folder + '</span><span><small>SAVES TO</small><strong>' + escapeHtml(FOLDER_LABEL) + '</strong></span></div>' +
                '<div class="photo-grid">' +
                    photos.map((p, i) =>
                        '<div class="photo-grid-item"><img src="' + p.url + '" alt="Photo ' + (i + 1) + '">' +
                        '<button type="button" class="photo-remove" data-photo-action="remove" data-index="' + i + '" aria-label="Remove photo ' + (i + 1) + '">' + ICONS.x + '</button></div>'
                    ).join("") +
                '</div>' +
                (errorText ? '<p class="photo-error" role="alert">' + escapeHtml(errorText) + '</p>' : '') +
            '</div>' +
            '<div class="photo-review-actions">' +
                '<button type="button" class="photo-btn photo-btn--soft" data-photo-action="more">' + moreIcon + moreLabel + '</button>' +
                '<button type="button" class="photo-btn photo-btn--primary" data-photo-action="upload">' + ICONS.up + '<span>Upload ' + (n === 1 ? "1 photo" : n + " photos") + '</span></button>' +
            '</div>';
    }

    async function uploadAll() {
        if (uploading || !photos.length || !project) return;
        if (!window.ProjectFields || !window.supabaseClient) {
            renderReview("Couldn't connect. Please try again.");
            return;
        }
        uploading = true;
        sheet.classList.add("is-uploading");
        const btn = $('[data-photo-action="upload"]', sheet);
        const label = btn && btn.querySelector("span");
        const total = photos.length;
        const failed = [];

        for (let i = 0; i < total; i++) {
            if (label) label.textContent = "Uploading " + (i + 1) + " of " + total + "…";
            const p = photos[i];
            try {
                const path = await window.ProjectFields.uploadFile(project.id, p.file, null, { pathSegments: [CATEGORY, SUBFOLDER] });
                const { error } = await window.supabaseClient.from(FILES_TABLE).insert({
                    project_id: project.id,
                    category: CATEGORY,
                    subfolder: SUBFOLDER,
                    sub_subfolder: null,
                    bucket: BUCKET,
                    storage_path: path,
                    file_name: p.file.name,
                    source: "upload",
                    uploaded_by_name: staffName()
                });
                if (error) throw error;
                URL.revokeObjectURL(p.url);
            } catch (err) {
                console.error('Failed to upload "' + p.file.name + '":', err);
                failed.push(p);
            }
        }

        uploading = false;
        sheet.classList.remove("is-uploading");
        const done = total - failed.length;

        if (!failed.length) {
            photos = [];
            closeEverything();
            toast(done === 1 ? "1 photo uploaded to Photography." : done + " photos uploaded to Photography.");
            return;
        }
        // Keep only the ones that failed so a retry doesn't double-upload.
        photos = failed;
        renderReview(done
            ? done + " uploaded. " + failed.length + " didn't — tap Upload to try again."
            : "Couldn't upload. Check your connection and try again.");
    }

    /* ---------- start ---------- */

    function init(detail) {
        if (!detail || !detail.project) return;
        project = detail.project;
        if (!fab) build();
    }

    window.addEventListener("project-shell:ready", (e) => init(e.detail));
})();
