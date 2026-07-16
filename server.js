const express = require("express");
const { sql } = require("./lib/db");
const { unwrapAndDecrypt } = require("./lib/crypto");
const { sendSelfDestructingPhoto, disconnect } = require("./lib/mtproto");

const app = express();
app.use(express.json({ limit: "50mb" }));

const TTL_SECONDS = Number(process.env.TTL_SECONDS || 30);

// --- Auth -------------------------------------------------------------------
// Shared secret between this service and the Netlify webhook.
// Set the same value in both FLY_DELIVERY_SECRET (here) and
// FLY_DELIVERY_SECRET (on Netlify).
function isAuthorized(req) {
  const token = req.headers["x-delivery-secret"];
  return !!process.env.DELIVERY_SECRET && token === process.env.DELIVERY_SECRET;
}

// --- Health check -----------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mtproto: _client?.connected ? "connected" : "disconnected",
  });
});

// --- Deliver endpoint -------------------------------------------------------
app.post("/deliver", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { imageId, chatId, userId } = req.body;
  if (!imageId || !chatId) {
    return res.status(400).json({ error: "imageId and chatId are required" });
  }

  // 1. Fetch from DB
  let row;
  try {
    const db = sql();
    const rows = await db`
      select id, full_ciphertext, full_iv, full_key_wrapped, caption,
             delivery_count, max_deliveries, revoked
      from images
      where id = ${imageId}
    `;
    row = rows[0] || rows;
  } catch (err) {
    console.error("[deliver] DB error:", err);
    return res.status(500).json({ error: `DB error: ${err.message}` });
  }

  if (!row || !row.id || row.revoked) {
    return res.status(404).json({ error: "Image not found or revoked" });
  }
  if (row.max_deliveries != null && row.delivery_count >= row.max_deliveries) {
    return res.status(410).json({ error: "Delivery limit reached" });
  }

  // 2. Decrypt
  let plaintext;
  try {
    plaintext = unwrapAndDecrypt({
      ciphertext: row.full_ciphertext,
      iv: row.full_iv,
      wrappedKey: row.full_key_wrapped,
    });
  } catch (err) {
    console.error("[deliver] decrypt error:", err);
    return res.status(500).json({ error: `Decrypt failed: ${err.message}` });
  }

  // 3. Send via MTProto (self-destructing)
  try {
    await sendSelfDestructingPhoto({
      chatId,
      buffer: plaintext,
      ttlSeconds: TTL_SECONDS,
      caption: row.caption || "",
    });
  } catch (err) {
    console.error("[deliver] MTProto send error:", err);
    return res.status(502).json({ error: `MTProto send failed: ${err.message}` });
  } finally {
    if (plaintext) plaintext.fill(0);
    plaintext = null;
  }

  // 4. Update delivery count
  try {
    const db = sql();
    if (userId) {
      await db`
        update images
        set delivery_count = delivery_count + 1,
            delivered_to = array_append(delivered_to, ${userId}::bigint)
        where id = ${imageId}
      `;
    }
  } catch (err) {
    console.error("[deliver] DB update error:", err);
  }

  res.json({ ok: true, imageId, selfDestruct: TTL_SECONDS });
});

// --- Start ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

(async () => {
  // Pre-warm the MTProto connection so the first /deliver is fast.
  try {
    const { getClient } = require("./lib/mtproto");
    // We don't call getClient() directly here because the module's
    // connect-on-first-use is fine — but we can log readiness.
    console.log("[startup] MTProto will connect on first delivery request.");
  } catch (e) {
    console.error("[startup] MTProto import warning:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[startup] mtproto-delivery listening on :${PORT}`);
  });
})();

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received");
  await disconnect();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.log("[shutdown] SIGINT received");
  await disconnect();
  process.exit(0);
});