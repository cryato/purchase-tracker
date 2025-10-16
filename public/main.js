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
});
