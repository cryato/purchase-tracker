"use strict";

const path = require("path");

// Load locale dictionaries
const en = require(path.join(__dirname, "..", "locales", "en.json"));
const ru = require(path.join(__dirname, "..", "locales", "ru.json"));
const de = require(path.join(__dirname, "..", "locales", "de.json"));

const supported = {
	en,
	ru,
	de,
};

const languageNames = {
	en: "English",
	ru: "Русский",
	de: "Deutsch",
};

function get(obj, key) {
	return key.split(".").reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

// Basic ICU-like plural support: {count, plural, one{..} few{..} many{..} other{..}}
// Falls back to {var} replacement if no plural expression present
function selectPluralForm(langCode, n) {
	const abs = Math.abs(Number(n));
	if (!Number.isFinite(abs)) return "other";
	switch (langCode) {
		case "ru": {
			const mod10 = abs % 10;
			const mod100 = abs % 100;
			if (mod10 === 1 && mod100 !== 11) return "one";
			if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
			return "many";
		}
		case "de":
		case "en":
		default:
			return abs === 1 ? "one" : "other";
	}
}

function interpolate(template, params, langCode) {
	if (!params) return template;
	// Handle plural macros first
	const pluralRegex = /\{\s*(\w+)\s*,\s*plural\s*,\s*([^}]*)\}/g;
	template = template.replace(pluralRegex, (_, varName, body) => {
		const count = params[varName];
		const chosen = selectPluralForm(langCode, count);
		const pick = (label) => {
			const m = new RegExp(label + "\\{([^}]*)\\}").exec(body);
			return m ? m[1] : undefined;
		};
		let out = pick(chosen);
		if (out === undefined) out = pick("other");
		if (out === undefined) out = "";
		return out;
	});
	// Then handle simple {var} replacements
	return template.replace(/\{(\w+)\}/g, (_, k) => {
		const v = params[k];
		return v === undefined || v === null ? "" : String(v);
	});
}

function createTranslator(langCode) {
	const dict = supported[langCode] || en;
	return function t(key, params) {
		let value = get(dict, key);
		if (value === undefined) {
			value = get(en, key);
		}
		if (typeof value !== "string") {
			return key; // fallback to key if missing
		}
		return interpolate(value, params, langCode);
	};
}

function detectLanguage(req, workspaceLanguage) {
	if (workspaceLanguage && supported[workspaceLanguage]) return workspaceLanguage;
	try {
		const best = req.acceptsLanguages ? req.acceptsLanguages(Object.keys(supported)) : null;
		if (best && supported[best]) return best;
	} catch (_e) {}
	return "en";
}

function getSupportedLanguages() {
	return Object.keys(supported).map(code => ({ code, name: languageNames[code] || code }));
}

module.exports = {
	createTranslator,
	detectLanguage,
	getSupportedLanguages,
	supportedLanguageCodes: Object.keys(supported),
	// Date helpers for languages with case-dependent month names (e.g., Russian)
	formatDayMonthLong(date, langCode) {
 		if (langCode === "ru") {
 			const monthsGen = [
 				"января","февраля","марта","апреля","мая","июня",
 				"июля","августа","сентября","октября","ноября","декабря",
 			];
 			const idx = date.month();
 			return `${date.format("D")} ${monthsGen[idx]}`;
 		}
 		return date.format("D MMMM");
 	},
 	formatDayMonthShort(date, langCode) {
 		// Short month usually fine across locales
 		return date.format("D MMM");
 	},
 	formatWeekRangeHuman(wStart, wEnd, langCode) {
 		const sameMonth = wStart.month() === wEnd.month() && wStart.year() === wEnd.year();
 		if (sameMonth) {
 			const month = langCode === "ru" ? (['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][wEnd.month()]) : wEnd.format("MMMM");
 			return `${wStart.format("D")}-${wEnd.format("D")} ${month}`;
 		}
 		return `${module.exports.formatDayMonthShort(wStart, langCode)} - ${module.exports.formatDayMonthShort(wEnd, langCode)}`;
 	},
};


