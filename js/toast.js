/* ===========================
   TOAST — shared bottom-right "saved" popup, loaded on every page.

   Usage:
     showToast();                                   // "Your changes have been saved successfully!"
     showToast("Contact saved.");                   // custom message
     showToast("Couldn't save.", { type: "error" }); // red icon instead of green check
     showToast("Done.", { duration: 8 });           // seconds (defaults: green 6, yellow 15, red 20)
     showToast("New notification", { type: "notification", link: "/pages/x.html", linkLabel: "View" })
                                                    // yellow bell version, used by notifications.js

   Dark navy card, green check, close ✕, and a progress bar that counts
   down the seconds left. Hovering pauses the countdown so it doesn't
   vanish while someone's reading it. Several toasts stack upward.
=========================== */

(function () {
    const DEFAULT_MESSAGE = "Your changes have been saved successfully!";
    // How long each kind stays up (seconds) unless a call passes its own duration.
    const DEFAULT_SECONDS = { success: 6, notification: 15, error: 20 };

    const ICONS = {
        success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        notification: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16H6l1.4-1.6V10a4.6 4.6 0 019.2 0v4.4L18 16zM10 18.5a2 2 0 004 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
    };

    function getStack() {
        let stack = document.getElementById("toastStack");
        if (!stack) {
            stack = document.createElement("div");
            stack.id = "toastStack";
            stack.className = "toast-stack";
            stack.setAttribute("aria-live", "polite");
            document.body.appendChild(stack);
        }
        return stack;
    }

    function showToast(message, options) {
        options = options || {};
        const type = ICONS[options.type] ? options.type : "success";
        const totalMs = (options.duration || DEFAULT_SECONDS[type]) * 1000;

        const toast = document.createElement("div");
        toast.className = `toast toast--${type}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");
        toast.innerHTML = `
            <div class="toast-body">
                <span class="toast-icon">${ICONS[type]}</span>
                <div class="toast-content"><p class="toast-text"></p></div>
                <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>
            </div>
            <div class="toast-footer">
                <div class="toast-progress"><div class="toast-progress-fill"></div></div>
                <span class="toast-seconds"></span>
            </div>
        `;
        // textContent, not innerHTML — messages can include user-typed names.
        toast.querySelector(".toast-text").textContent = message || DEFAULT_MESSAGE;
        if (options.link) {
            const a = document.createElement("a");
            a.className = "toast-link";
            a.href = options.link;
            a.textContent = options.linkLabel || "View it here";
            toast.querySelector(".toast-content").appendChild(a);
        }

        const fill = toast.querySelector(".toast-progress-fill");
        const secondsEl = toast.querySelector(".toast-seconds");

        let remainingMs = totalMs;
        let lastTick = Date.now();
        let paused = false;
        let closed = false;

        function render() {
            fill.style.width = `${Math.max(0, remainingMs / totalMs) * 100}%`;
            secondsEl.textContent = `${Math.ceil(Math.max(0, remainingMs) / 1000)}s`;
        }

        function close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            toast.classList.add("toast--leaving");
            setTimeout(() => toast.remove(), 250);
        }

        const timer = setInterval(() => {
            const now = Date.now();
            if (!paused) remainingMs -= now - lastTick;
            lastTick = now;
            render();
            if (remainingMs <= 0) close();
        }, 100);

        toast.addEventListener("mouseenter", () => { paused = true; });
        toast.addEventListener("mouseleave", () => { paused = false; lastTick = Date.now(); });
        toast.querySelector(".toast-close").addEventListener("click", close);

        render();
        getStack().appendChild(toast);
        return { close };
    }

    window.showToast = showToast;
})();
