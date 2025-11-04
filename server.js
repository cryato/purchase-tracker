"use strict";

const path = require("path");
const express = require("express");
const crypto = require("crypto");
const dayjs = require("dayjs");
// Load locales for date formatting
require("dayjs/locale/ru");
require("dayjs/locale/de");
const { createTranslator, detectLanguage, getSupportedLanguages, supportedLanguageCodes, formatWeekRangeHuman, formatDayMonthLong } = require("./utils/i18n");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
const admin = require("firebase-admin");
require("dotenv").config();
const { budgetStartDay, monthlyBudget, currencyCode, weeklyBudget, weekStartDayOfWeek, bigPurchaseThreshold } = require("./config");
const fetch = require("node-fetch");
const { Resend } = require("resend");
const { getCurrentCycle, sumPurchasesInRange, formatCurrency, computeAllowanceToDate, getCurrentWeek, computeWeeklyAllowanceToDate, sumWeeklyPurchasesDetailed } = require("./utils/budget");

const app = express();
const PORT = process.env.PORT || 3000;

// Enforce HTTPS in production (supports reverse proxies like Heroku/Render)
app.set("trust proxy", 1);
app.use((req, res, next) => {
	if (process.env.NODE_ENV !== "production") return next();
	// If already secure, continue
	if (req.secure) return next();
	// Respect X-Forwarded-Proto header added by proxies
	const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
	if (forwardedProto === "https") return next();
	const host = req.headers.host || req.get("host") || req.hostname;
	// Use 308 to preserve method and body across redirect (important for POST/PUT)
	return res.redirect(308, `https://${host}${req.originalUrl}`);
});

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

// Log project info for diagnostics
try {
    // eslint-disable-next-line no-console
    console.log("Firebase Admin initialized. Project:", (admin.app().options && (admin.app().options.projectId || (admin.app().options.credential && admin.app().options.credential.projectId))) || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "<unknown>");
} catch (_e) { /* noop */ }

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

function isWorkspaceAdmin(req) {
    if (!req || !req.user || !req.workspace) return false;
    // Treat creator/owner as admin. If ownerUid is missing (legacy), allow any member as admin.
    if (!req.workspace.ownerUid) return true;
    return req.workspace.ownerUid === req.user.uid;
}

function requireWorkspaceAdmin(req, res, next) {
    if (!req.user) return res.redirect("/login");
    if (!req.workspace) return res.redirect("/setup-workspace");
    if (!isWorkspaceAdmin(req)) return res.status(403).send("Forbidden");
    next();
}

function generateLowercaseToken(length) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i++) {
        out += alphabet[bytes[i] % 26];
    }
    return out;
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
    // Attach translator stub early (will be replaced after workspace attach)
    res.locals.t = (k, p) => createTranslator("en")(k, p);
    res.locals.langCode = "en";
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

// Language detection and translator
app.use((req, res, next) => {
    const wsLang = req.workspace && req.workspace.language;
    const langCode = detectLanguage(req, wsLang);
    res.locals.langCode = langCode;
    res.locals.t = createTranslator(langCode);
    res.locals.languages = getSupportedLanguages();
    // Set dayjs locale for localized month/day names
    try { dayjs.locale(langCode); } catch (_e) {}
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
        const expiresIn = 1000 * 60 * 60 * 24 * 30; // 30 days (1 month)
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
        // eslint-disable-next-line no-console
        console.error("/sessionLogin failed:", (e && e.code) || e);
        res.status(401).json({ error: "unauthorized" });
    }
});

app.post("/sessionLogout", (req, res) => {
    res.clearCookie("session");
    res.redirect("/login");
});

// -------------------- Magic Link (server-side) --------------------
const MAGIC_LINKS_ENABLED = String(process.env.MAGIC_LINKS_ENABLED || "false").toLowerCase() === "true";
const BASE_URL = (process.env.BASE_URL || "").toString().replace(/\/$/, "");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";
let resendClient = null;
if (RESEND_API_KEY) {
    try { resendClient = new Resend(RESEND_API_KEY); } catch (_e) { /* noop */ }
}

app.post("/auth/email-link/start", async (req, res) => {
    if (!MAGIC_LINKS_ENABLED) return res.status(404).send("Not found");
    try {
        const rawEmail = ((req.body && req.body.email) || "").toString();
        const email = rawEmail.trim();
        if (!email || !email.includes("@")) return res.status(400).send("Invalid email");

        const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
        const proto = (req.secure || forwardedProto === "https") ? "https" : "http";
        const host = req.headers.host || req.get("host") || req.hostname;
        const continueUrl = `${proto}://${host}/auth/email-link/callback?email=${encodeURIComponent(email)}`;
        const actionSettings = {
            url: continueUrl,
            handleCodeInApp: true,
        };
        const link = await admin.auth().generateSignInWithEmailLink(email, actionSettings);
        res.render("magic", { email, link });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("/auth/email-link/start failed:", e);
        res.status(500).send("Failed to generate link");
    }
});

// Ask Firebase to SEND the email (EMAIL_LINK) with our BASE_URL as handler
app.post("/auth/email-link/send", async (req, res) => {
    if (!MAGIC_LINKS_ENABLED) return res.status(404).send("Not found");
    try {
        const rawEmail = ((req.body && req.body.email) || "").toString();
        const email = rawEmail.trim();
        if (!email || !email.includes("@")) return res.status(400).send("Invalid email");
        const apiKey = process.env.FIREBASE_WEB_API_KEY;
        if (!apiKey) return res.status(500).send("Missing API key");

        // Build our handler URL which Firebase will redirect back to
        let handlerBase = BASE_URL;
        if (!handlerBase) {
            const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
            const proto = (req.secure || forwardedProto === "https") ? "https" : "http";
            const host = req.headers.host || req.get("host") || req.hostname;
            handlerBase = `${proto}://${host}`;
        }
        const continueUrl = `${handlerBase}/auth/email-link/callback?email=${encodeURIComponent(email)}`;

        // Generate the link server-side via Admin (guarantees we get the exact oob code link)
        const link = await admin.auth().generateSignInWithEmailLink(email, { url: continueUrl, handleCodeInApp: true });

        // If Resend configured, email the link ourselves
        if (resendClient && RESEND_FROM) {
            try {
                await resendClient.emails.send({
                    from: RESEND_FROM,
                    to: email,
                    subject: "Your sign-in link",
                    text: `Click to sign in: ${link}\n\nIf the link doesn't open, copy and paste into the same browser on this device.`,
                    html: `<p>Click to sign in:</p><p><a href="${link}">${link}</a></p><p>If the link doesn't open, copy and paste it into the same browser on this device.</p>`,
                });
            } catch (mailErr) {
                // eslint-disable-next-line no-console
                console.error("Resend send error:", mailErr);
                return res.status(500).send("Failed to send email");
            }
        } else {
            // Fallback: use Identity Toolkit to send if Resend not configured
            const payload = { requestType: "EMAIL_SIGNIN", email, continueUrl, canHandleCodeInApp: true };
            const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}` , {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (!resp.ok) {
                // eslint-disable-next-line no-console
                console.error("sendOobCode error:", data);
                return res.status(400).send("Failed to send email");
            }
        }
        res.render("magic-sent", { email });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("/auth/email-link/send failed:", e);
        res.status(500).send("Failed to send email");
    }
});

// Server-side finalize to avoid Google calls from RU clients
app.get("/auth/email-link/callback", async (req, res) => {
    if (!MAGIC_LINKS_ENABLED) return res.status(404).send("Not found");
    try {
        const oobCode = ((req.query && req.query.oobCode) || "").toString();
        let email = ((req.query && req.query.email) || "").toString();
        email = email.trim();
        if (!oobCode) return res.status(400).send("Missing code");
        if (!email) {
            // Render a tiny page to capture email, then POST here
            return res.render("magic-callback", { hasEmail: false, oobCode });
        }

        const apiKey = process.env.FIREBASE_WEB_API_KEY;
        if (!apiKey) return res.status(500).send("Missing API key");
        const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${apiKey}` , {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, oobCode })
        });
        const data = await resp.json();
        if (!resp.ok) {
            // eslint-disable-next-line no-console
            console.error("signInWithEmailLink error:", data);
            return res.status(400).send("Auth failed");
        }
        const idToken = data && data.idToken;
        if (!idToken) return res.status(400).send("Auth failed");

        const expiresIn = 1000 * 60 * 60 * 24 * 30; // 30 days (1 month)
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        const isProd = process.env.NODE_ENV === "production";
        res.cookie("session", sessionCookie, {
            httpOnly: true,
            secure: isProd,
            sameSite: "lax",
            maxAge: expiresIn,
        });
        res.redirect("/");
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error("/auth/email-link/callback failed:", e);
        res.status(400).send("Auth failed");
    }
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
    let language = (req.body.language || "").toString().trim();
    if (!supportedLanguageCodes.includes(language)) {
        // default to device language if supported, else English
        language = detectLanguage(req, null);
    }
    if (!Number.isFinite(weekly) || weekly <= 0 || !curr) {
        return res.status(400).send("Invalid input");
    }
    try {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const wsDoc = {
            weeklyBudget: weekly,
            currency: curr,
            language,
            memberUids: [uid],
            ownerUid: uid,
            createdAt: now,
            updatedAt: now,
        };
        const ref = await db.collection("workspaces").add(wsDoc);
        // Attach to request for immediate redirect usage
        req.workspace = { id: ref.id, ...wsDoc };
        res.redirect("/");
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to create workspace", _e);
        res.status(500).send("Failed to create workspace");
    }
});

// Settings
app.get("/settings", requireAuth, requireWorkspace, (req, res) => {
    const token = req.workspace.publicViewToken || "";
    const hasPublicLink = !!token;
    const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
    const proto = (req.secure || forwardedProto === "https") ? "https" : "http";
    const host = req.headers.host || req.get("host") || req.hostname;
    const publicLinkUrl = hasPublicLink ? `${proto}://${host}/s/${token}` : "";
    res.render("settings", {
        user: req.user,
        weeklyBudget: req.workspace.weeklyBudget,
        currency: req.workspace.currency,
        language: req.workspace.language || res.locals.langCode,
        hasPublicLink,
        publicLinkUrl,
        isAdmin: isWorkspaceAdmin(req),
    });
});

app.post("/settings", requireAuth, requireWorkspace, async (req, res) => {
    const weekly = Number((req.body.weeklyBudget || "").toString());
    const curr = (req.body.currency || "").toString().trim().toUpperCase();
    const language = (req.body.language || "").toString().trim();
    if (!Number.isFinite(weekly) || weekly <= 0 || !curr) return res.redirect("/settings");
    try {
        const update = {
            weeklyBudget: weekly,
            currency: curr,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (supportedLanguageCodes.includes(language)) {
            update.language = language;
        }
        await db.collection("workspaces").doc(req.workspace.id).update(update);
        // Update attached workspace to reflect new settings immediately
        req.workspace.weeklyBudget = weekly;
        req.workspace.currency = curr;
        if (supportedLanguageCodes.includes(language)) {
            req.workspace.language = language;
        }
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to update settings", _e);
    }
    res.redirect("/");
});

// Public link management (admin only)
app.post("/settings/public-link/create", requireAuth, requireWorkspace, requireWorkspaceAdmin, async (req, res) => {
    try {
        // Generate simple 12-letter lowercase token (no workspace id leakage)
        const token = generateLowercaseToken(12);
        await db.collection("workspaces").doc(req.workspace.id).update({
            publicViewToken: token,
            publicViewCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Reflect immediately
        req.workspace.publicViewToken = token;
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to create public link", _e);
    }
    // Trigger auto-copy on settings page
    res.redirect("/settings?copied=1");
});

app.post("/settings/public-link/revoke", requireAuth, requireWorkspace, requireWorkspaceAdmin, async (req, res) => {
    try {
        await db.collection("workspaces").doc(req.workspace.id).update({
            publicViewToken: admin.firestore.FieldValue.delete(),
            publicViewRevokedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        delete req.workspace.publicViewToken;
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to revoke public link", _e);
    }
    res.redirect("/settings");
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
    const monthlyPurchases = monthSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => !p.deleted);
    const spent = sumPurchasesInRange(monthlyPurchases, start, end);
    const budgetLeft = monthlyBudget - spent;

    const { daysInCycle, dailyBudget, daysElapsed, allowedByToday } = computeAllowanceToDate(today, budgetStartDay, monthlyBudget);
    const spentToDate = sumPurchasesInRange(monthlyPurchases, start, today);
    const allowedByTodayNet = allowedByToday - spentToDate;
    const haveToDate = allowedByTodayNet;

    // Weekly summary metrics (respect selected week from cookie if present)
    const selectedWeekStartStr = (req.cookies && req.cookies.selectedWeekStart) || "";
    let weeklyBase = today;
    if (selectedWeekStartStr) {
        const parsedSelected = dayjs(selectedWeekStartStr);
        if (parsedSelected.isValid()) weeklyBase = parsedSelected;
    }
    const { start: wStart, end: wEnd } = getCurrentWeek(weeklyBase, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");
    const weekSnap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", wStartStr)
        .where("date", "<=", wEndStr)
        .get();
    const weeklyPurchases = weekSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => !p.deleted);
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
        statusTail = res.locals.t("weekly.status_on_track", { left: formatCurrency(weeklyLeft, wsCurrency) });
    } else {
        statusTail = res.locals.t("weekly.status_over", { over: formatCurrency(Math.abs(weeklyLeft), wsCurrency) });
        overBudgetExplanation = res.locals.t("weekly.over_explainer");
    }
    const statusLine = `${bigCount} ${res.locals.t("weekly.big", { count: bigCount })} (🌚) + ${smallCount} ${res.locals.t("weekly.small", { count: smallCount })} (🌝) ${res.locals.t("weekly.purchases", { purchaseCount: bigCount + smallCount, smallCount: smallCount })} — ${statusTail}${overBudgetExplanation}`;

    // Human week range for title: if same month use "D-D MMMM", else "D MMM - D MMM"
    const weekRangeHuman = formatWeekRangeHuman(wStart, wEnd, res.locals.langCode);

    // Determine whether selected week is the current week
    const currentWeekStart = getCurrentWeek(today, weekStartDayOfWeek).start;
    const isCurrentWeek = wStart.isSame(currentWeekStart, "day");

    res.render("index", {
        user: req.user,
        budgetLeft,
        budgetLeftFormatted: formatCurrency(budgetLeft, wsCurrency),
        currencyCode: wsCurrency,
        cycleStart: start.format("YYYY-MM-DD"),
        cycleEnd: end.format("YYYY-MM-DD"),
        cycleEndHuman: formatDayMonthLong(end, res.locals.langCode),
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
        weeklyUsedFormatted: res.locals.t("weekly.used_format", { used: formatCurrency(weeklySpentTotal, wsCurrency), total: formatCurrency(wsWeeklyBudget, wsCurrency) }),
        weeklyIcons: { totalIcons, bigIcons, smallIcons, emptyIcons },
        weeklyDevilRows,
        firstRowDevils,
        weeklyStatusLine: statusLine,
        weeklyAllowedByTodayNet: weeklyAllowedByTodayNet,
        weekRangeHuman,
        isCurrentWeek,
        publicMode: false,
        detailsUrl: "/details",
    });
});

app.get("/spend", requireAuth, requireWorkspace, (req, res) => {
	const defaultDate = dayjs().format("YYYY-MM-DD");
    const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
    res.render("spend", { user: req.user, defaultDate, currencyCode: wsCurrency });
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
            deleted: false,
            date,
            createdByUid: req.user.uid,
            createdAt: now,
        });
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to add purchase", _e);
    }
    res.redirect("/");
});

// Daily details (current week)
app.get("/details", requireAuth, requireWorkspace, async (req, res) => {
    const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
    // Parse requested week start (YYYY-MM-DD). If invalid/missing, use today.
    const startParam = ((req.query && req.query.start) || "").toString().trim();
    let baseDate = dayjs();
    if (startParam) {
        const parsed = dayjs(startParam);
        if (parsed.isValid()) baseDate = parsed;
    }

    const { start: wStart, end: wEnd } = getCurrentWeek(baseDate, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");

    // Compute prev/next week boundaries and disable next if in the future relative to current week
    const prevStart = wStart.subtract(7, "day").startOf("day");
    const nextStart = wStart.add(7, "day").startOf("day");
    const currentWeekStart = getCurrentWeek(dayjs(), weekStartDayOfWeek).start;
    const nextDisabled = nextStart.isAfter(currentWeekStart);

    // Persist selected week start in a session cookie so the main screen reflects it
    try {
        const isProd = process.env.NODE_ENV === "production";
        res.cookie("selectedWeekStart", wStartStr, {
            httpOnly: true,
            sameSite: "lax",
            secure: isProd,
        });
    } catch (_e) { /* noop */ }

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
        if (p.deleted) continue;
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

    // Human week range for title: if same month use "D-D MMMM", else "D MMM - D MMM"
    const weekRangeHuman = formatWeekRangeHuman(wStart, wEnd, res.locals.langCode);

    res.render("details", {
        user: req.user,
        days,
        currencyCode: wsCurrency,
        weekRangeHuman,
        prevUrl: `/details?start=${prevStart.format("YYYY-MM-DD")}`,
        nextUrl: `/details?start=${nextStart.format("YYYY-MM-DD")}`,
        nextDisabled,
        publicMode: false,
        homeUrl: "/",
    });
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
        res.render("edit", { user: req.user, purchase: p, currencyCode: wsCurrency });
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to load purchase for edit", _e);
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
        // eslint-disable-next-line no-console
        console.error("Failed to update purchase", _e);
    }
    res.redirect("/details");
});

// Soft delete purchase
app.post("/delete/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    try {
        const docRef = db.collection("purchases").doc(id);
        const doc = await docRef.get();
        if (doc.exists && doc.data().workspaceId === req.workspace.id) {
            await docRef.update({
                deleted: true,
                deletedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                deletedByUid: req.user.uid,
            });
        }
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to delete purchase", _e);
    }
    res.redirect("/details");
});

// Trash view (show soft-deleted purchases)
app.get("/trash", requireAuth, requireWorkspace, async (req, res) => {
    try {
        // Only current week, to minimize data and avoid composite index needs
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

        const items = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(p => p.deleted === true)
            .sort((a, b) => (a.date < b.date ? 1 : -1));

        const wsCurrency = (req.workspace && req.workspace.currency) || currencyCode;
        res.render("trash", { user: req.user, items, currencyCode: wsCurrency });
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to load trash", _e);
        res.render("trash", { user: req.user, items: [], currencyCode: req.workspace.currency || currencyCode });
    }
});

// -------------------- Public read-only routes --------------------
async function loadWorkspaceByPublicToken(token) {
    if (!token) return null;
    try {
        const snap = await db.collection("workspaces").where("publicViewToken", "==", token).limit(1).get();
        if (snap.empty) return null;
        const doc = snap.docs[0];
        return { id: doc.id, ...doc.data() };
    } catch (_e) {
        return null;
    }
}

app.get("/s/:token", async (req, res) => {
    const token = (req.params && req.params.token) || "";
    const ws = await loadWorkspaceByPublicToken(token);
    if (!ws) return res.status(404).send("Not found");

    // Configure language per workspace for this response
    const langCode = ws.language || detectLanguage(req, null);
    res.locals.langCode = langCode;
    res.locals.t = createTranslator(langCode);
    try { dayjs.locale(langCode); } catch (_e) {}

    const wsCurrency = (ws && ws.currency) || currencyCode;
    const wsWeeklyBudget = (ws && ws.weeklyBudget) || weeklyBudget;

    const today = dayjs();
    const { start, end } = getCurrentCycle(today, budgetStartDay);

    const startStr = start.format("YYYY-MM-DD");
    const endStr = end.format("YYYY-MM-DD");
    const monthSnap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", startStr)
        .where("date", "<=", endStr)
        .get();
    const monthlyPurchases = monthSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => !p.deleted);
    const spent = sumPurchasesInRange(monthlyPurchases, start, end);
    const budgetLeft = monthlyBudget - spent;

    const { daysInCycle, dailyBudget, daysElapsed, allowedByToday } = computeAllowanceToDate(today, budgetStartDay, monthlyBudget);
    const spentToDate = sumPurchasesInRange(monthlyPurchases, start, today);
    const allowedByTodayNet = allowedByToday - spentToDate;
    const haveToDate = allowedByTodayNet;

    // Weekly summary
    const { start: wStart, end: wEnd } = getCurrentWeek(today, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");
    const weekSnap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", wStartStr)
        .where("date", "<=", wEndStr)
        .get();
    const weeklyPurchases = weekSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => !p.deleted);
    const dynamicBigThreshold = (typeof wsWeeklyBudget === "number" ? wsWeeklyBudget : 0) * 0.25;
    const weeklySpentDetailed = sumWeeklyPurchasesDetailed(weeklyPurchases, wStart, wEnd, dynamicBigThreshold);
    const weeklySpentTotal = weeklySpentDetailed.total;
    const weeklyLeft = wsWeeklyBudget - weeklySpentTotal;
    const weeklyAllowance = computeWeeklyAllowanceToDate(today, weekStartDayOfWeek, wsWeeklyBudget);
    const weeklySpentToDate = sumPurchasesInRange(weeklyPurchases, wStart, today);
    const weeklyAllowedByTodayNet = weeklyAllowance.allowedByToday - weeklySpentToDate;

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
        statusTail = res.locals.t("weekly.status_on_track", { left: formatCurrency(weeklyLeft, wsCurrency) });
    } else {
        statusTail = res.locals.t("weekly.status_over", { over: formatCurrency(Math.abs(weeklyLeft), wsCurrency) });
        overBudgetExplanation = res.locals.t("weekly.over_explainer");
    }
    const statusLine = `${bigCount} ${res.locals.t("weekly.big", { count: bigCount })} (🌚) + ${smallCount} ${res.locals.t("weekly.small", { count: smallCount })} (🌝) ${res.locals.t("weekly.purchases", { purchaseCount: bigCount + smallCount, smallCount: smallCount })} — ${statusTail}${overBudgetExplanation}`;

    const weekRangeHuman = formatWeekRangeHuman(wStart, wEnd, res.locals.langCode);
    const currentWeekStart = getCurrentWeek(today, weekStartDayOfWeek).start;
    const isCurrentWeek = wStart.isSame(currentWeekStart, "day");

    res.render("index", {
        user: null,
        budgetLeft,
        budgetLeftFormatted: formatCurrency(budgetLeft, wsCurrency),
        currencyCode: wsCurrency,
        cycleStart: start.format("YYYY-MM-DD"),
        cycleEnd: end.format("YYYY-MM-DD"),
        cycleEndHuman: formatDayMonthLong(end, res.locals.langCode),
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
        weeklyUsedFormatted: res.locals.t("weekly.used_format", { used: formatCurrency(weeklySpentTotal, wsCurrency), total: formatCurrency(wsWeeklyBudget, wsCurrency) }),
        weeklyIcons: { totalIcons, bigIcons, smallIcons, emptyIcons },
        weeklyDevilRows,
        firstRowDevils,
        weeklyStatusLine: statusLine,
        weeklyAllowedByTodayNet: weeklyAllowedByTodayNet,
        weekRangeHuman,
        isCurrentWeek,
        publicMode: true,
        detailsUrl: `/s/${token}/details`,
    });
});

app.get("/s/:token/details", async (req, res) => {
    const token = (req.params && req.params.token) || "";
    const ws = await loadWorkspaceByPublicToken(token);
    if (!ws) return res.status(404).send("Not found");

    const langCode = ws.language || detectLanguage(req, null);
    res.locals.langCode = langCode;
    res.locals.t = createTranslator(langCode);
    try { dayjs.locale(langCode); } catch (_e) {}

    const wsCurrency = (ws && ws.currency) || currencyCode;

    const startParam = ((req.query && req.query.start) || "").toString().trim();
    let baseDate = dayjs();
    if (startParam) {
        const parsed = dayjs(startParam);
        if (parsed.isValid()) baseDate = parsed;
    }

    const { start: wStart, end: wEnd } = getCurrentWeek(baseDate, weekStartDayOfWeek);
    const wStartStr = wStart.format("YYYY-MM-DD");
    const wEndStr = wEnd.format("YYYY-MM-DD");

    const prevStart = wStart.subtract(7, "day").startOf("day");
    const nextStart = wStart.add(7, "day").startOf("day");
    const currentWeekStart = getCurrentWeek(dayjs(), weekStartDayOfWeek).start;
    const nextDisabled = nextStart.isAfter(currentWeekStart);

    const snap = await db
        .collection("purchases")
        .where("workspaceId", "==", ws.id)
        .where("date", ">=", wStartStr)
        .where("date", "<=", wEndStr)
        .get();
    const byDateMap = new Map();
    for (const d of snap.docs) {
        const p = { id: d.id, ...d.data() };
        if (p.deleted) continue;
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

    const weekRangeHuman = formatWeekRangeHuman(wStart, wEnd, res.locals.langCode);

    res.render("details", {
        user: null,
        days,
        currencyCode: wsCurrency,
        weekRangeHuman,
        prevUrl: `/s/${token}/details?start=${prevStart.format("YYYY-MM-DD")}`,
        nextUrl: `/s/${token}/details?start=${nextStart.format("YYYY-MM-DD")}`,
        nextDisabled,
        publicMode: true,
        homeUrl: `/s/${token}`,
    });
});

// Restore soft-deleted purchase
app.post("/restore/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    try {
        const docRef = db.collection("purchases").doc(id);
        const doc = await docRef.get();
        if (doc.exists && doc.data().workspaceId === req.workspace.id) {
            await docRef.update({
                deleted: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                restoredAt: admin.firestore.FieldValue.serverTimestamp(),
                restoredByUid: req.user.uid,
            });
        }
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to restore purchase", _e);
    }
    res.redirect("/trash");
});

// Permanently delete purchase
app.post("/permadelete/:id", requireAuth, requireWorkspace, async (req, res) => {
    const id = req.params.id;
    try {
        const docRef = db.collection("purchases").doc(id);
        const doc = await docRef.get();
        if (doc.exists && doc.data().workspaceId === req.workspace.id) {
            await docRef.delete();
        }
    } catch (_e) {
        // eslint-disable-next-line no-console
        console.error("Failed to permanently delete purchase", _e);
    }
    res.redirect("/trash");
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Purchase Tracker listening on http://localhost:${PORT}`);
});
