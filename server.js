"use strict";

const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const { budgetStartDay, monthlyBudget, currencyCode, weeklyBudget, weekStartDayOfWeek, bigPurchaseThreshold } = require("./config");
const { getCurrentCycle, sumPurchasesInRange, formatCurrency, computeAllowanceToDate, getCurrentWeek, computeWeeklyAllowanceToDate, sumWeeklyPurchasesDetailed } = require("./utils/budget");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for purchases
// Each item: { amount: number, date: string (YYYY-MM-DD), description?: string }
const purchases = [];
let nextPurchaseId = 1;

// View engine and static assets
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Body parsing for form submissions
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
	const today = dayjs();
	const { start, end } = getCurrentCycle(today, budgetStartDay);
	const spent = sumPurchasesInRange(purchases, start, end);
	const budgetLeft = monthlyBudget - spent;

	const { daysInCycle, dailyBudget, daysElapsed, allowedByToday } = computeAllowanceToDate(today, budgetStartDay, monthlyBudget);
	// Only consider purchases up to today for the "allowed by today" number
	const spentToDate = sumPurchasesInRange(purchases, start, today);
	const allowedByTodayNet = allowedByToday - spentToDate;
	const haveToDate = allowedByTodayNet; // alias for clarity in templates

    // Weekly summary metrics
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    const weeklySpentDetailed = sumWeeklyPurchasesDetailed(purchases, wStart, wEnd, bigPurchaseThreshold);
    const weeklySpentTotal = weeklySpentDetailed.total;
    const weeklyLeft = weeklyBudget - weeklySpentTotal;
    const weeklyAllowance = computeWeeklyAllowanceToDate(today, weekStartDayOfWeek, weeklyBudget);
    const weeklySpentToDate = sumPurchasesInRange(purchases, wStart, today);
    const weeklyAllowedByTodayNet = weeklyAllowance.allowedByToday - weeklySpentToDate;

    // Build icon-based progress representation (max 13 icons as per example)
    const totalIcons = 13;
    const usedRatio = Math.max(0, Math.min(1, weeklySpentTotal / weeklyBudget));
    const usedIcons = Math.round(usedRatio * totalIcons);
    const bigIcons = Math.min(usedIcons, Math.round((weeklySpentDetailed.bigTotal / Math.max(1, weeklyBudget)) * totalIcons));
    const smallIcons = Math.max(0, usedIcons - bigIcons);
    const emptyIcons = Math.max(0, totalIcons - usedIcons);

    // Status line
    const bigCount = weeklySpentDetailed.bigCount;
    const smallCount = weeklySpentDetailed.smallCount;
    let statusTail;
    if (weeklyLeft >= 0) {
        statusTail = `on track, ${formatCurrency(weeklyLeft, currencyCode)} left`;
    } else {
        statusTail = `${formatCurrency(Math.abs(weeklyLeft), currencyCode)} over budget`;
    }
    const statusLine = `${bigCount} big + ${smallCount} small purchases — ${statusTail}`;

    res.render("index", {
		budgetLeft,
		budgetLeftFormatted: formatCurrency(budgetLeft, currencyCode),
		currencyCode,
		cycleStart: start.format("YYYY-MM-DD"),
		cycleEnd: end.format("YYYY-MM-DD"),
		cycleEndHuman: end.format("D [of] MMMM"),
		// Equal-per-day schedule metrics
		daysInCycle,
		dailyBudget,
		dailyBudgetFormatted: formatCurrency(dailyBudget, currencyCode),
		daysElapsed,
		// Scheduled vs net allowed-by-today
		allowedByTodaySchedule: allowedByToday,
		allowedByTodayScheduleFormatted: formatCurrency(allowedByToday, currencyCode),
		spentToDate,
		spentToDateFormatted: formatCurrency(spentToDate, currencyCode),
		allowedByToday: allowedByTodayNet,
		allowedByTodayFormatted: formatCurrency(allowedByTodayNet, currencyCode),
		haveToDate,
		haveToDateFormatted: formatCurrency(haveToDate, currencyCode),
        // Weekly view props
        weeklyBudget,
        weeklySpentTotal,
        weeklyUsedFormatted: `${formatCurrency(weeklySpentTotal, currencyCode)} / ${formatCurrency(weeklyBudget, currencyCode)} used`,
        weeklyIcons: { totalIcons, bigIcons, smallIcons, emptyIcons },
        weeklyStatusLine: statusLine,
        weeklyAllowedByTodayNet: weeklyAllowedByTodayNet,
	});
});

app.get("/spend", (req, res) => {
	const defaultDate = dayjs().format("YYYY-MM-DD");
	res.render("spend", { defaultDate, currencyCode });
});

app.post("/spend", (req, res) => {
	const amount = parseFloat((req.body.amount || "").toString());
	const dateStr = (req.body.date || "").toString().trim();
	const description = (req.body.description || "").toString().trim();

    if (Number.isFinite(amount) && amount > 0) {
		const date = dayjs(dateStr || undefined);
        purchases.push({ id: nextPurchaseId++, amount, date: date.format("YYYY-MM-DD"), description });
	}

	res.redirect("/");
});

// Daily details (current week)
app.get("/details", (req, res) => {
    const today = dayjs();
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    // Group by date within week
    const byDateMap = new Map();
    for (const p of purchases) {
        const d = dayjs(p.date);
        if ((d.isAfter(wStart) || d.isSame(wStart, "day")) && (d.isBefore(wEnd) || d.isSame(wEnd, "day"))) {
            const key = d.format("YYYY-MM-DD");
            if (!byDateMap.has(key)) byDateMap.set(key, []);
            byDateMap.get(key).push(p);
        }
    }
    // Build sorted array by date desc
    const days = Array.from(byDateMap.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([dateStr, items]) => {
            const dayName = dayjs(dateStr).format("ddd");
            const dayTotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
            return {
                dateStr,
                dayName,
                dayTotal,
                dayTotalFormatted: formatCurrency(dayTotal, currencyCode),
                items,
            };
        });

    res.render("details", { days, currencyCode });
});

// Edit purchase page
app.get("/edit/:id", (req, res) => {
    const id = Number(req.params.id);
    const p = purchases.find(x => x.id === id);
    if (!p) return res.redirect("/details");
    res.render("edit", { purchase: p, currencyCode });
});

// Update purchase
app.post("/edit/:id", (req, res) => {
    const id = Number(req.params.id);
    const amount = parseFloat((req.body.amount || "").toString());
    const dateStr = (req.body.date || "").toString().trim();
    const description = (req.body.description || "").toString().trim();
    const p = purchases.find(x => x.id === id);
    if (p && Number.isFinite(amount) && amount > 0) {
        p.amount = amount;
        const date = dayjs(dateStr || undefined);
        p.date = date.format("YYYY-MM-DD");
        p.description = description;
    }
    res.redirect("/details");
});

// Delete purchase
app.post("/delete/:id", (req, res) => {
    const id = Number(req.params.id);
    const idx = purchases.findIndex(x => x.id === id);
    if (idx !== -1) purchases.splice(idx, 1);
    res.redirect("/details");
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Purchase Tracker listening on http://localhost:${PORT}`);
});
