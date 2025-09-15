"use strict";

const dayjs = require("dayjs");

function getCurrentCycle(today, startDayOfMonth) {
	const currentDay = today.date();
	let cycleStart = today;
	if (currentDay >= startDayOfMonth) {
		cycleStart = today.date(startDayOfMonth);
	} else {
		cycleStart = today.subtract(1, "month").date(startDayOfMonth);
	}
	const cycleEnd = cycleStart.add(1, "month").subtract(1, "day");
	return { start: cycleStart.startOf("day"), end: cycleEnd.endOf("day") };
}

function sumPurchasesInRange(purchases, start, end) {
	return purchases.reduce((sum, p) => {
		const d = dayjs(p.date);
		if ((d.isAfter(start) || d.isSame(start, "day")) && (d.isBefore(end) || d.isSame(end, "day"))) {
			return sum + (Number(p.amount) || 0);
		}
		return sum;
	}, 0);
}

function formatCurrency(amount, currencyCode) {
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(amount);
	} catch (_e) {
		return `${amount.toFixed(2)} ${currencyCode}`;
	}
}

module.exports = { getCurrentCycle, sumPurchasesInRange, formatCurrency };
