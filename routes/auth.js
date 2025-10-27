"use strict";

const express = require("express");
const router = express.Router();
const { getSupabase } = require("../utils/supabase");
const { BASE_URL } = require("../config");

// ----- OAuth providers (e.g., Google) -----
router.get("/login", async (req, res) => {
    const provider = ((req.query && req.query.provider) || "").toString().trim();
    if (!provider) return res.redirect("/login?e=1");
    try {
        const supabase = getSupabase(req, res);
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider,
            options: { redirectTo: `${BASE_URL}/auth/callback` },
        });
        if (error) return res.status(500).send("Auth init failed");
        const url = (data && data.url) || "";
        if (!url) return res.status(500).send("Auth URL missing");
        res.redirect(url);
    } catch (_e) {
        res.status(500).send("Auth failed");
    }
});

router.get("/login/:provider", async (req, res) => {
    const provider = (req.params && req.params.provider) || "";
    if (!provider) return res.redirect("/login?e=1");
    try {
        const supabase = getSupabase(req, res);
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider,
            options: { redirectTo: `${BASE_URL}/auth/callback` },
        });
        if (error) return res.status(500).send("Auth init failed");
        const url = (data && data.url) || "";
        if (!url) return res.status(500).send("Auth URL missing");
        res.redirect(url);
    } catch (_e) {
        res.status(500).send("Auth failed");
    }
});

// ----- Email magic link (passwordless) -----
router.get("/email", (req, res) => {
    if (req.user) return res.redirect("/");
    res.render("email", { query: req.query || {} });
});

router.post("/email", async (req, res) => {
    try {
        const email = ((req.body && req.body.email) || "").toString().trim();
        if (!email) return res.redirect("/auth/email?e=1");
        const supabase = getSupabase(req, res);
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: `${BASE_URL}/auth/callback`, shouldCreateUser: true },
        });
        if (error) return res.redirect("/auth/email?e=1");
        return res.redirect("/login?sent=1");
    } catch (_e) {
        return res.redirect("/auth/email?e=1");
    }
});

router.get("/callback", async (req, res) => {
    const supabase = getSupabase(req, res);
    const fullUrl = `${BASE_URL}${req.originalUrl}`;
    const { error } = await supabase.auth.exchangeCodeForSession(fullUrl);
    if (error) {
        if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.error("/auth/callback exchange failed:", error);
        }
        return res.redirect("/login?e=1");
    }
    res.redirect("/");
});

router.post("/logout", async (req, res) => {
    const supabase = getSupabase(req, res);
    try {
        await supabase.auth.signOut({ scope: "global" });
    } catch (_e) { /* ignore */ }
    res.redirect("/login");
});

module.exports = router;



