"use strict";

const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const { budgetStartDay, monthlyBudget, currencyCode } = require("./config");
const { getCurrentCycle, sumPurchasesInRange, formatCurrency } = require("./utils/budget");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for purchases
// Each item: { amount: number, date: string (YYYY-MM-DD), description?: string }
const purchases = [];

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

	res.render("index", {
		budgetLeft,
		budgetLeftFormatted: formatCurrency(budgetLeft, currencyCode),
		currencyCode,
		cycleStart: start.format("YYYY-MM-DD"),
		cycleEnd: end.format("YYYY-MM-DD"),
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
		purchases.push({ amount, date: date.format("YYYY-MM-DD"), description });
	}

	res.redirect("/");
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Purchase Tracker listening on http://localhost:${PORT}`);
});
