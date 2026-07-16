const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");
const crypto = require("crypto");

let _client = null;

/**
 * Return a connected GramJS client, reconnecting if necessary.
 * On Fly.io the process is long-lived so we keep the TCP socket open
 * and reuse it across requests — no per-invocation overhead.
 */
async function getClient() {
  if (_client && _client.connected) return _client;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING must be set");
  }

  _client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await _client.connect();
  console.log("[mtproto] connected");
  return _client;
}

/**
 * Send a self-destructing photo via MTProto.
 *
 * @param {Object} opts
 * @param {number|string} opts.chatId   — Telegram chat ID
 * @param {Buffer}       opts.buffer   — plaintext image bytes
 * @param {string}       [opts.filename="photo.jpg"]
 * @param {number}       [opts.ttlSeconds=30]
 * @param {string}       [opts.caption=""]
 */
async function sendSelfDestructingPhoto({
  chatId,
  buffer,
  filename = "photo.jpg",
  ttlSeconds = 30,
  caption = "",
}) {
  const client = await getClient();

  const file = new CustomFile(filename, buffer.length, "", buffer);
  const uploaded = await client.uploadFile({ file, workers: 1 });

  const entity = await client.getEntity(chatId);

  await client.invoke(
    new Api.messages.SendMedia({
      peer: entity,
      media: new Api.InputMediaUploadedPhoto({
        file: uploaded,
        ttlSeconds,
      }),
      message: caption,
      randomId: BigInt("0x" + crypto.randomBytes(8).toString("hex")),
    })
  );

  console.log(`[mtproto] sent self-destruct photo to ${chatId} (ttl=${ttlSeconds}s)`);
}

/** Graceful shutdown — close the MTProto socket. */
async function disconnect() {
  if (_client) {
    await _client.disconnect().catch(() => {});
    _client = null;
    console.log("[mtproto] disconnected");
  }
}

module.exports = { sendSelfDestructingPhoto, disconnect };