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

// Firestore handle
const db = admin.firestore();

// Workspace loader: attach the user's workspace (by membership) to req/res
async function attachWorkspace(req, _res, next) {
    if (!req.user) return next();
    try {
        const uid = req.user.uid;
        // Query workspaces where memberUids contains the user
        const snap = await db
            .collection("workspaces")
            .where("memberUids", "array-contains", uid)
            .limit(1)
            .get();
        if (!snap.empty) {
            const doc = snap.docs[0];
            req.workspace = { id: doc.id, ...doc.data() };
        } else {
            req.workspace = null;
        }
    } catch (_e) {
        req.workspace = null;
    }
    next();
}

function requireWorkspace(req, res, next) {
    if (!req.user) return res.redirect("/login");
    if (!req.workspace) return res.redirect("/setup-workspace");
    next();
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

// Load workspace (if any) after user attach
app.use(attachWorkspace);

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

// Workspace setup routes
app.get("/setup-workspace", requireAuth, (req, res) => {
    if (req.workspace) return res.redirect("/");
    res.render("setup", { defaultCurrency: currencyCode, defaultWeekly: weeklyBudget });
});

app.post("/setup-workspace", requireAuth, async (req, res) => {
    if (req.workspace) return res.redirect("/");
    const uid = req.user.uid;
    const weekly = Number((req.body.weeklyBudget || "").toString());
    const curr = (req.body.currency || "").toString().trim().toUpperCase();
    if (!Number.isFinite(weekly) || weekly <= 0 || !curr) {
        return res.status(400).send("Invalid input");
    }
    try {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const wsDoc = {
            weeklyBudget: weekly,
            currency: curr,
            memberUids: [uid],
            createdAt: now,
            updatedAt: now,
        };
        const ref = await db.collection("workspaces").add(wsDoc);
        // Attach to request for immediate redirect usage
        req.workspace = { id: ref.id, ...wsDoc };
        res.redirect("/");
    } catch (_e) {
        res.status(500).send("Failed to create workspace");
    }
});

app.get("/", requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const wsCurrency = (ws && ws.currency) || currencyCode;
    const wsWeeklyBudget = (ws && ws.weeklyBudget) || weeklyBudget;

    const today = dayjs();
    const { start, end } = getCurrentCycle(today, budgetStartDay);

    // Fetch purchases for monthly cycle
    const startStr = start.format("YYYY-MM-DD");
    const endStr = end.format("YYYY-MM-DD");
    const monthSnap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", startStr)
        .where("date", "<=", endStr)
        .get();
    const monthlyPurchases = monthSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const spent = sumPurchasesInRange(monthlyPurchases, start, end);
    const budgetLeft = monthlyBudget - spent;

    const { daysInCycle, dailyBudget, daysElapsed, allowedByToday } = computeAllowanceToDate(today, budgetStartDay, monthlyBudget);
    const spentToDate = sumPurchasesInRange(monthlyPurchases, start, today);
    const allowedByTodayNet = allowedByToday - spentToDate;
    const haveToDate = allowedByTodayNet;

    // Weekly summary metrics
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");
    const weekSnap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", wStartStr)
        .where("date", "<=", wEndStr)
        .get();
    const weeklyPurchases = weekSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const dynamicBigThreshold = (typeof wsWeeklyBudget === "number" ? wsWeeklyBudget : 0) * 0.25;
    const weeklySpentDetailed = sumWeeklyPurchasesDetailed(weeklyPurchases, wStart, wEnd, dynamicBigThreshold);
    const weeklySpentTotal = weeklySpentDetailed.total;
    const weeklyLeft = wsWeeklyBudget - weeklySpentTotal;
    const weeklyAllowance = computeWeeklyAllowanceToDate(today, weekStartDayOfWeek, wsWeeklyBudget);
    const weeklySpentToDate = sumPurchasesInRange(weeklyPurchases, wStart, today);
    const weeklyAllowedByTodayNet = weeklyAllowance.allowedByToday - weeklySpentToDate;

    // Build icon-based progress representation (10 fixed base slots)
    const totalIcons = 10;
    const usedRatio = Math.max(0, Math.min(1, weeklySpentTotal / Math.max(1, wsWeeklyBudget)));
    let usedIcons = Math.round(usedRatio * totalIcons);

    let bigIcons = 0;
    let smallIcons = 0;
    if (weeklySpentTotal > 0) {
        if (weeklySpentDetailed.smallTotal > 0 && usedIcons === 0) {
            usedIcons = 1;
        }
        const bigShare = weeklySpentDetailed.bigTotal / weeklySpentTotal;
        bigIcons = Math.round(usedIcons * bigShare);
        smallIcons = Math.max(0, usedIcons - bigIcons);
        if (weeklySpentDetailed.smallTotal > 0 && smallIcons === 0) {
            if (bigIcons > 0) {
                bigIcons -= 1;
                smallIcons = 1;
            } else if (usedIcons < totalIcons) {
                usedIcons += 1;
                smallIcons = 1;
            } else {
                smallIcons = 1;
                bigIcons = Math.max(0, usedIcons - smallIcons);
            }
        }
    }
    const emptyIcons = Math.max(0, totalIcons - usedIcons);

    const overspend = Math.max(0, weeklySpentTotal - wsWeeklyBudget);
    const devilIconsTotal = overspend > 0 ? Math.ceil((overspend / Math.max(1, wsWeeklyBudget)) * 10) : 0;
    const firstRowDevils = Math.min(2, devilIconsTotal);
    const weeklyDevilRows = [];
    if (devilIconsTotal > 2) {
        let remaining = devilIconsTotal - 2;
        while (remaining > 0) {
            const rowDevils = Math.min(12, remaining);
            weeklyDevilRows.push({ devils: rowDevils });
            remaining -= rowDevils;
        }
    }

    const bigCount = weeklySpentDetailed.bigCount;
    const smallCount = weeklySpentDetailed.smallCount;
    let statusTail;
    let overBudgetExplanation = "";
    if (weeklyLeft >= 0) {
        statusTail = `on track, ${formatCurrency(weeklyLeft, wsCurrency)} left`;
    } else {
        statusTail = `${formatCurrency(Math.abs(weeklyLeft), wsCurrency)} over budget`;
        overBudgetExplanation = " — 👹 means we’re over budget";
    }
    const statusLine = `${bigCount} big (🌚) + ${smallCount} small (🌝) purchases — ${statusTail}${overBudgetExplanation}`;

    res.render("index", {
        budgetLeft,
        budgetLeftFormatted: formatCurrency(budgetLeft, wsCurrency),
        currencyCode: wsCurrency,
        cycleStart: start.format("YYYY-MM-DD"),
        cycleEnd: end.format("YYYY-MM-DD"),
        cycleEndHuman: end.format("D [of] MMMM"),
        daysInCycle,
        dailyBudget,
        dailyBudgetFormatted: formatCurrency(dailyBudget, wsCurrency),
        daysElapsed,
        allowedByTodaySchedule: allowedByToday,
        allowedByTodayScheduleFormatted: formatCurrency(allowedByToday, wsCurrency),
        spentToDate,
        spentToDateFormatted: formatCurrency(spentToDate, wsCurrency),
        allowedByToday: allowedByTodayNet,
        allowedByTodayFormatted: formatCurrency(allowedByTodayNet, wsCurrency),
        haveToDate,
        haveToDateFormatted: formatCurrency(haveToDate, wsCurrency),
        weeklyBudget: wsWeeklyBudget,
        weeklySpentTotal,
        weeklyUsedFormatted: `${formatCurrency(weeklySpentTotal, wsCurrency)} / ${formatCurrency(wsWeeklyBudget, wsCurrency)} used`,
        weeklyIcons: { totalIcons, bigIcons, smallIcons, emptyIcons },
        weeklyDevilRows,
        firstRowDevils,
        weeklyStatusLine: statusLine,
        weeklyAllowedByTodayNet: weeklyAllowedByTodayNet,
    });
});

app.get("/spend", requireAuth, requireWorkspace, (req, res) => {
	const defaultDate = dayjs().format("YYYY-MM-DD");
    const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
    res.render("spend", { defaultDate, currencyCode: wsCurrency });
});

app.post("/spend", requireAuth, requireWorkspace, async (req, res) => {
    const amount = parseFloat((req.body.amount || "").toString());
    const dateStr = (req.body.date || "").toString().trim();
    const description = (req.body.description || "").toString().trim();
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.redirect("/");
    }
    try {
        const date = dayjs(dateStr || undefined).format("YYYY-MM-DD");
        const now = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("purchases").add({
            workspaceId: req.workspace.id,
            amount,
            currency: req.workspace.currency || currencyCode,
            description,
            rejected: false,
            date,
            createdByUid: req.user.uid,
            createdAt: now,
        });
    } catch (_e) {
        // ignore errors for now
    }
    res.redirect("/");
});

// Daily details (current week)
app.get("/details", requireAuth, requireWorkspace, async (req, res) => {
    const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
    const today = dayjs();
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");
    const snap = await db
        .collection("purchases")
        .where("workspaceId", "==", req.workspace.id)
        .where("date", ">=", wStartStr)
        .where("date", "<=", wEndStr)
        .get();
    // Group by date within week
    const byDateMap = new Map();
    for (const d of snap.docs) {
        const p = { id: d.id, ...d.data() };
        const key = p.date;
        if (!byDateMap.has(key)) byDateMap.set(key, []);
        byDateMap.get(key).push(p);
    }
    const days = Array.from(byDateMap.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([dateStr, items]) => {
            const dayName = dayjs(dateStr).format("ddd");
            const dayTotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
            return {
                dateStr,
                dayName,
                dayTotal,
                dayTotalFormatted: formatCurrency(dayTotal, wsCurrency),
                items,
            };
        });

    res.render("details", { days, currencyCode: wsCurrency });
});

// Edit purchase page
app.get("/edit/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    try {
        const doc = await db.collection("purchases").doc(id).get();
        if (!doc.exists) return res.redirect("/details");
        const p = { id: doc.id, ...doc.data() };
        if (p.workspaceId !== req.workspace.id) return res.redirect("/details");
        const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
        res.render("edit", { purchase: p, currencyCode: wsCurrency });
    } catch (_e) {
        res.redirect("/details");
    }
});

// Update purchase
app.post("/edit/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    const amount = parseFloat((req.body.amount || "").toString());
    const dateStr = (req.body.date || "").toString().trim();
    const description = (req.body.description || "").toString().trim();
    if (!Number.isFinite(amount) || amount <= 0) return res.redirect("/details");
    try {
        const docRef = db.collection("purchases").doc(id);
        const doc = await docRef.get();
        if (!doc.exists) return res.redirect("/details");
        const p = doc.data();
        if (p.workspaceId !== req.workspace.id) return res.redirect("/details");
        await docRef.update({
            amount,
            date: dayjs(dateStr || undefined).format("YYYY-MM-DD"),
            description,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (_e) {
        // ignore
    }
    res.redirect("/details");
});

// Delete purchase
app.post("/delete/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    try {
        const docRef = db.collection("purchases").doc(id);
        const doc = await docRef.get();
        if (doc.exists && doc.data().workspaceId === req.workspace.id) {
            await docRef.delete();
        }
    } catch (_e) {
        // ignore
    }
    res.redirect("/details");
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Purchase Tracker listening on http://localhost:${PORT}`);
});
