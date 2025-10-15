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
		return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode, maximumFractionDigits: 0}).format(amount);
	} catch (_e) {
		return `${amount.toFixed(2)} ${currencyCode}`;
	}
}

function countDaysInclusive(start, end) {
	const startDay = start.startOf("day");
	const endDay = end.startOf("day");
	return endDay.diff(startDay, "day") + 1;
}

function computeAllowanceToDate(today, startDayOfMonth, totalBudget) {
	const { start, end } = getCurrentCycle(today, startDayOfMonth);
	const daysInCycle = countDaysInclusive(start, end);
	const dailyBudget = totalBudget / daysInCycle;
	// clamp today within cycle
	let clampedToday = today;
	if (today.isBefore(start)) clampedToday = start;
	if (today.isAfter(end)) clampedToday = end;
	const daysElapsed = countDaysInclusive(start, clampedToday);
	const allowedByToday = dailyBudget * daysElapsed;
	return { start, end, daysInCycle, dailyBudget, daysElapsed, allowedByToday };
}

module.exports = { getCurrentCycle, sumPurchasesInRange, formatCurrency, computeAllowanceToDate };

// Weekly helpers
function getCurrentWeek(today, weekStartDayOfWeek) {
    // weekStartDayOfWeek: 0=Sunday ... 6=Saturday
    const currentDow = today.day();
    const diff = (currentDow - weekStartDayOfWeek + 7) % 7;
    const start = today.subtract(diff, "day").startOf("day");
    const end = start.add(6, "day").endOf("day");
    return { start, end };
}

function computeWeeklyAllowanceToDate(today, weekStartDayOfWeek, weeklyBudget) {
    const { start, end } = getCurrentWeek(today, weekStartDayOfWeek);
    const daysInCycle = 7;
    const dailyBudget = weeklyBudget / daysInCycle;
    let clampedToday = today;
    if (today.isBefore(start)) clampedToday = start;
    if (today.isAfter(end)) clampedToday = end;
    const daysElapsed = clampedToday.startOf("day").diff(start.startOf("day"), "day") + 1;
    const allowedByToday = dailyBudget * daysElapsed;
    return { start, end, daysInCycle, dailyBudget, daysElapsed, allowedByToday };
}

function classifyPurchase(amount, bigPurchaseThreshold) {
    return amount >= bigPurchaseThreshold ? "big" : "small";
}

function sumWeeklyPurchasesDetailed(purchases, start, end, bigPurchaseThreshold) {
    let total = 0;
    let bigTotal = 0;
    let smallTotal = 0;
    let bigCount = 0;
    let smallCount = 0;
    for (const p of purchases) {
        const d = dayjs(p.date);
        if ((d.isAfter(start) || d.isSame(start, "day")) && (d.isBefore(end) || d.isSame(end, "day"))) {
            const amt = Number(p.amount) || 0;
            total += amt;
            if (classifyPurchase(amt, bigPurchaseThreshold) === "big") {
                bigTotal += amt;
                bigCount += 1;
            } else {
                smallTotal += amt;
                smallCount += 1;
            }
        }
    }
    return { total, bigTotal, smallTotal, bigCount, smallCount };
}

module.exports.getCurrentWeek = getCurrentWeek;
module.exports.computeWeeklyAllowanceToDate = computeWeeklyAllowanceToDate;
module.exports.sumWeeklyPurchasesDetailed = sumWeeklyPurchasesDetailed;
