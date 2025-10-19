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

// Helper: find matching closing brace for a '{' at index 'start'
function findMatchingBrace(str, start) {
    let depth = 0;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function parsePluralOptions(body) {
    const options = {};
    let i = 0;
    while (i < body.length) {
        // skip whitespace and commas
        while (i < body.length && (body[i] === ' ' || body[i] === '\n' || body[i] === '\t' || body[i] === ',')) i++;
        if (i >= body.length) break;
        // read label up to '{'
        let label = '';
        while (i < body.length && body[i] !== '{' && body[i] !== ' ' && body[i] !== '\n' && body[i] !== '\t') {
            label += body[i++];
        }
        // skip whitespace before '{'
        while (i < body.length && body[i] !== '{') i++;
        if (i >= body.length || body[i] !== '{') break;
        const startMsg = i;
        const endMsg = findMatchingBrace(body, startMsg);
        if (endMsg === -1) break;
        const msg = body.slice(startMsg + 1, endMsg);
        options[label] = msg;
        i = endMsg + 1;
    }
    return options;
}

function interpolate(template, params, langCode) {
    if (!params) params = {};
    // Scan and replace plural blocks with balanced brace parsing
    let out = '';
    let i = 0;
    while (i < template.length) {
        const ch = template[i];
        if (ch === '{') {
            const end = findMatchingBrace(template, i);
            if (end === -1) { out += template[i++]; continue; }
            const inner = template.slice(i + 1, end).trim();
            // Attempt to parse plural: var, plural, options...
            const firstComma = inner.indexOf(',');
            if (firstComma !== -1) {
                const varName = inner.slice(0, firstComma).trim();
                const rest1 = inner.slice(firstComma + 1).trim();
                if (rest1.startsWith('plural')) {
                    const rest2 = rest1.slice('plural'.length).trim();
                    if (rest2.startsWith(',')) {
                        const optionsBody = rest2.slice(1).trim();
                        const options = parsePluralOptions(optionsBody);
                        const chosen = selectPluralForm(langCode, params[varName]);
                        let chosenMsg = options[chosen];
                        if (chosenMsg === undefined) chosenMsg = options.other || '';
                        // Recursively interpolate inside chosen message
                        out += interpolate(chosenMsg, params, langCode);
                        i = end + 1;
                        continue;
                    }
                }
            }
            // Not a plural block: treat as simple variable
            const key = inner;
            const val = params[key];
            out += (val === undefined || val === null) ? '' : String(val);
            i = end + 1;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
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


