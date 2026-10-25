// Unit tests import modules that import the database client. The client connects only on its first query, so
// tests that never query run without a database: they get the .env settings when there are some, a placeholder otherwise.
import "dotenv/config"

process.env.DATABASE_URL ??= "postgres://unit-tests@127.0.0.1:1/none"
