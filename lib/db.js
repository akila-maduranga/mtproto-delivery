const { neon } = require("@neondatabase/serverless");

function sql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return neon(process.env.DATABASE_URL);
}

module.exports = { sql };