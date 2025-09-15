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
});
