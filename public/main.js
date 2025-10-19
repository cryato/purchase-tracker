document.addEventListener("DOMContentLoaded", () => {
	const viewDetails = document.getElementById("view-daily-details");
	if (viewDetails) {
		// Allow normal navigation to /details
	}

    const burger = document.getElementById("burger");
    const menu = document.getElementById("menu");
    if (burger && menu) {
        const setA11y = (open) => {
            if (open) {
                menu.removeAttribute("aria-hidden");
                menu.removeAttribute("inert");
            } else {
                menu.setAttribute("aria-hidden", "true");
                menu.setAttribute("inert", "");
            }
        };
        const hide = () => { menu.classList.add("hidden"); burger.setAttribute("aria-expanded", "false"); setA11y(false); };
        const toggle = () => {
            const open = menu.classList.contains("hidden");
            if (open) {
                menu.classList.remove("hidden");
                burger.setAttribute("aria-expanded", "true");
                setA11y(true);
            } else {
                hide();
            }
        };
        burger.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
        document.addEventListener("click", () => hide());
        menu.addEventListener("click", (e) => e.stopPropagation());
    }

    // Settings: auto-copy and click-to-copy for public link
    try {
        const params = new URLSearchParams(window.location.search);
        const shouldCopy = params.get("copied") === "1";
        const linkEl = document.getElementById("public-link");
        const toast = document.getElementById("toast");
        const showToast = () => {
            if (!toast) return;
            toast.classList.remove("hidden");
            clearTimeout(showToast.__t);
            showToast.__t = setTimeout(() => toast.classList.add("hidden"), 1200);
        };
        async function copyLink() {
            if (!linkEl) return;
            const txt = linkEl.textContent || "";
            if (!txt) return;
            try {
                await navigator.clipboard.writeText(txt);
                showToast();
            } catch (_e) {}
        }
        if (shouldCopy && linkEl) {
            copyLink();
        }
        if (linkEl) {
            linkEl.addEventListener("click", (e) => { e.preventDefault(); copyLink(); });
        }
    } catch (_e) {}
});
