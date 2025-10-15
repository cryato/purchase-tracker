document.addEventListener("DOMContentLoaded", () => {
	const masked = document.getElementById("masked");
	const revealed = document.getElementById("revealed");
	if (masked && revealed) {
		const toggle = () => {
			masked.classList.toggle("hidden");
			revealed.classList.toggle("hidden");
		};
		masked.addEventListener("click", toggle);
		revealed.addEventListener("click", toggle);
	}

	const viewDetails = document.getElementById("view-daily-details");
	if (viewDetails) {
		viewDetails.addEventListener("click", (e) => {
			e.preventDefault();
			// Simple inline modal using alert for prototype; replace with dedicated page later
			// For now direct to /spend as a placeholder for managing entries
			window.location.href = "/spend";
		});
	}
});
