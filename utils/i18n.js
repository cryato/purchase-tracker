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

function interpolate(template, params) {
	if (!params) return template;
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
		return interpolate(value, params);
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
};


