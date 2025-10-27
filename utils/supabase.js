"use strict";

const { createServerClient } = require("@supabase/ssr");
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require("../config");

function getSupabase(req, res) {
    return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        cookies: {
            get: (name) => (req.cookies ? req.cookies[name] : undefined),
            set: (name, value, options) => {
                const isProd = process.env.NODE_ENV === "production";
                res.cookie(name, value, {
                    httpOnly: true,
                    sameSite: "lax",
                    secure: isProd,
                    ...options,
                });
            },
            remove: (name, options) => {
                res.clearCookie(name, { ...options });
            },
        },
    });
}

module.exports = { getSupabase };



