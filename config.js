"use strict";

// Update these values to configure your monthly budget cycle
module.exports = {
	// Day of month when the budget cycle starts (1-28 recommended)
	budgetStartDay: 1,
	// Integer amount allocated for spontaneous purchases per month
	monthlyBudget: 40,
	// Weekly budget and classification
	weeklyBudget: 1300,
	// 0=Sunday ... 6=Saturday
	weekStartDayOfWeek: 0,
	// Amount at or above this is considered a "big" purchase
	bigPurchaseThreshold: 120,
	// ISO 4217 currency code, e.g., 'USD', 'EUR', 'GBP'
	currencyCode: "ILS",
	// Supabase configuration (read from environment)
	SUPABASE_URL: process.env.SUPABASE_URL || "",
	SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
	BASE_URL: process.env.BASE_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000"),
};
