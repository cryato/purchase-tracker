"use strict";

const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
const admin = require("firebase-admin");
require("dotenv").config();
const { budgetStartDay, monthlyBudget, currencyCode, weeklyBudget, weekStartDayOfWeek, bigPurchaseThreshold } = require("./config");
const { getCurrentCycle, sumPurchasesInRange, formatCurrency, computeAllowanceToDate, getCurrentWeek, computeWeeklyAllowanceToDate, sumWeeklyPurchasesDetailed } = require("./utils/budget");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin (supports FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)
let __adminInitialized = false;
try {
	admin.app();
	__adminInitialized = true;
} catch (_e) {
	// not initialized yet
}
if (!__adminInitialized) {
	const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (svcJson) {
		try {
			const svc = JSON.parse(svcJson);
			if (svc && typeof svc.private_key === "string") {
				// Convert escaped newlines to real newlines
				svc.private_key = svc.private_key.replace(/\\n/g, "\n");
			}
			admin.initializeApp({
				credential: admin.credential.cert(svc),
			});
			__adminInitialized = true;
		} catch (_err) {
			admin.initializeApp();
			__adminInitialized = true;
		}
	} else {
		admin.initializeApp();
		__adminInitialized = true;
	}
}

// In-memory store for purchases per user
// Map<uid, Array<{ id: number, amount: number, date: string, description?: string }>>
const purchasesByUid = new Map();
const nextIdByUid = new Map();

function getUserPurchases(req) {
    const uid = req.user && req.user.uid;
    if (!uid) return [];
    if (!purchasesByUid.has(uid)) purchasesByUid.set(uid, []);
    return purchasesByUid.get(uid);
}

function getNextPurchaseId(req) {
    const uid = req.user && req.user.uid;
    if (!nextIdByUid.has(uid)) nextIdByUid.set(uid, 1);
    const next = nextIdByUid.get(uid);
    nextIdByUid.set(uid, next + 1);
    return next;
}

// View engine and static assets
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Body parsing for form submissions
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

// CSRF protection via cookie; expose token to templates
app.use(csrf({ cookie: true }));
app.use((req, res, next) => {
    // Provide csrfToken and user to all templates
    try {
        res.locals.csrfToken = req.csrfToken();
    } catch (_e) {
        res.locals.csrfToken = "";
    }
    res.locals.user = req.user || null;
    next();
});

// Attach user from Firebase session cookie if present
app.use(async (req, _res, next) => {
    const sessionCookie = (req.cookies && req.cookies.session) || "";
    if (!sessionCookie) return next();
    try {
        const decoded = await admin.auth().verifySessionCookie(sessionCookie, true);
        req.user = decoded;
        res.locals.user = decoded;
    } catch (_e) {
        // ignore invalid/expired cookie
    }
    next();
});

function requireAuth(req, res, next) {
    if (!req.user) return res.redirect("/login");
    next();
}

// Auth routes (public)
app.get("/login", (req, res) => {
    if (req.user) return res.redirect("/");
    res.render("login");
});

app.post("/sessionLogin", async (req, res) => {
    const idToken = (req.body && req.body.idToken) || "";
    if (!idToken) return res.status(400).json({ error: "missing idToken" });
    try {
        const expiresIn = 1000 * 60 * 60 * 24 * 5; // 5 days
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        const isProd = process.env.NODE_ENV === "production";
        res.cookie("session", sessionCookie, {
            httpOnly: true,
            secure: isProd,
            sameSite: "lax",
            maxAge: expiresIn,
        });
        res.status(200).json({ status: "ok" });
    } catch (e) {
        res.status(401).json({ error: "unauthorized" });
    }
});

app.post("/sessionLogout", (req, res) => {
    res.clearCookie("session");
    res.redirect("/login");
});

// Registration page (public)
app.get("/register", (req, res) => {
    if (req.user) return res.redirect("/");
    res.render("register");
});

app.get("/", requireAuth, (req, res) => {
	const today = dayjs();
	const { start, end } = getCurrentCycle(today, budgetStartDay);
	const userPurchases = getUserPurchases(req);
	const spent = sumPurchasesInRange(userPurchases, start, end);
	const budgetLeft = monthlyBudget - spent;

	const { daysInCycle, dailyBudget, daysElapsed, allowedByToday } = computeAllowanceToDate(today, budgetStartDay, monthlyBudget);
	// Only consider purchases up to today for the "allowed by today" number
	const spentToDate = sumPurchasesInRange(userPurchases, start, today);
	const allowedByTodayNet = allowedByToday - spentToDate;
	const haveToDate = allowedByTodayNet; // alias for clarity in templates

    // Weekly summary metrics
	const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    const dynamicBigThreshold = (typeof weeklyBudget === "number" ? weeklyBudget : 0) * 0.25;
	const weeklySpentDetailed = sumWeeklyPurchasesDetailed(userPurchases, wStart, wEnd, dynamicBigThreshold);
    const weeklySpentTotal = weeklySpentDetailed.total;
    const weeklyLeft = weeklyBudget - weeklySpentTotal;
    const weeklyAllowance = computeWeeklyAllowanceToDate(today, weekStartDayOfWeek, weeklyBudget);
	const weeklySpentToDate = sumPurchasesInRange(userPurchases, wStart, today);
    const weeklyAllowedByTodayNet = weeklyAllowance.allowedByToday - weeklySpentToDate;

    // Build icon-based progress representation (10 fixed base slots)
    const totalIcons = 10;
    const usedRatio = Math.max(0, Math.min(1, weeklySpentTotal / Math.max(1, weeklyBudget)));
    let usedIcons = Math.round(usedRatio * totalIcons);

    // Distribute used icons between big/small proportionally to their share of weekly spend
    let bigIcons = 0;
    let smallIcons = 0;
    if (weeklySpentTotal > 0) {
        if (weeklySpentDetailed.smallTotal > 0 && usedIcons === 0) {
            // Ensure at least one icon if there are small purchases at all
            usedIcons = 1;
        }
        const bigShare = weeklySpentDetailed.bigTotal / weeklySpentTotal;
        bigIcons = Math.round(usedIcons * bigShare);
        smallIcons = Math.max(0, usedIcons - bigIcons);
        // Guarantee at least one small icon when there are small purchases
        if (weeklySpentDetailed.smallTotal > 0 && smallIcons === 0) {
            if (bigIcons > 0) {
                bigIcons -= 1;
                smallIcons = 1;
            } else if (usedIcons < totalIcons) {
                usedIcons += 1;
                smallIcons = 1;
            } else {
                // Edge case: all icons used by big; force swap one to small
                smallIcons = 1;
                bigIcons = Math.max(0, usedIcons - smallIcons);
            }
        }
    }
    const emptyIcons = Math.max(0, totalIcons - usedIcons);

    // Overspend devil icons beyond budget in 10% increments
    const overspend = Math.max(0, weeklySpentTotal - weeklyBudget);
    const devilIconsTotal = overspend > 0 ? Math.ceil((overspend / Math.max(1, weeklyBudget)) * 10) : 0; // 1 per 10%
    const firstRowDevils = Math.min(2, devilIconsTotal); // allow up to 2 devils on the first row
    const weeklyDevilRows = [];
    if (devilIconsTotal > 2) {
        let remaining = devilIconsTotal - 2;
        while (remaining > 0) {
            const rowDevils = Math.min(12, remaining); // subsequent rows show up to 12 devils, no empties
            weeklyDevilRows.push({ devils: rowDevils });
            remaining -= rowDevils;
        }
    }

    // Status line
    const bigCount = weeklySpentDetailed.bigCount;
    const smallCount = weeklySpentDetailed.smallCount;
    let statusTail;
    let overBudgetExplanation = "";
    if (weeklyLeft >= 0) {
        statusTail = `on track, ${formatCurrency(weeklyLeft, currencyCode)} left`;
    } else {
        statusTail = `${formatCurrency(Math.abs(weeklyLeft), currencyCode)} over budget`;
        overBudgetExplanation = " — 👹 means we’re over budget";
    }
    const statusLine = `${bigCount} big (🌚) + ${smallCount} small (🌝) purchases — ${statusTail}${overBudgetExplanation}`;

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
        weeklyDevilRows,
        firstRowDevils,
        weeklyStatusLine: statusLine,
        weeklyAllowedByTodayNet: weeklyAllowedByTodayNet,
	});
});

app.get("/spend", requireAuth, (req, res) => {
	const defaultDate = dayjs().format("YYYY-MM-DD");
	res.render("spend", { defaultDate, currencyCode });
});

app.post("/spend", requireAuth, (req, res) => {
	const amount = parseFloat((req.body.amount || "").toString());
	const dateStr = (req.body.date || "").toString().trim();
	const description = (req.body.description || "").toString().trim();

    if (Number.isFinite(amount) && amount > 0) {
		const date = dayjs(dateStr || undefined);
		const list = getUserPurchases(req);
		list.push({ id: getNextPurchaseId(req), amount, date: date.format("YYYY-MM-DD"), description });
	}

	res.redirect("/");
});

// Daily details (current week)
app.get("/details", requireAuth, (req, res) => {
    const today = dayjs();
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    // Group by date within week
    const byDateMap = new Map();
	for (const p of getUserPurchases(req)) {
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
app.get("/edit/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
	const p = getUserPurchases(req).find(x => x.id === id);
    if (!p) return res.redirect("/details");
    res.render("edit", { purchase: p, currencyCode });
});

// Update purchase
app.post("/edit/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const amount = parseFloat((req.body.amount || "").toString());
    const dateStr = (req.body.date || "").toString().trim();
    const description = (req.body.description || "").toString().trim();
	const p = getUserPurchases(req).find(x => x.id === id);
    if (p && Number.isFinite(amount) && amount > 0) {
        p.amount = amount;
        const date = dayjs(dateStr || undefined);
        p.date = date.format("YYYY-MM-DD");
        p.description = description;
    }
    res.redirect("/details");
});

// Delete purchase
app.post("/delete/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
	const list = getUserPurchases(req);
	const idx = list.findIndex(x => x.id === id);
	if (idx !== -1) list.splice(idx, 1);
    res.redirect("/details");
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Purchase Tracker listening on http://localhost:${PORT}`);
});
