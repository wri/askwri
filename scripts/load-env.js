// Preload for ts-node CLI entry points (typeorm CLI, seed-admin): load the
// gitignored .env.local first, then .env. dotenv never overwrites a variable
// that is already set, so .env.local beats .env, and a real environment
// variable (deploy day: `DATABASE_URL=... npm run migration:run`) beats both.
const { config } = require('dotenv')

config({ path: '.env.local' })
config({ path: '.env' })
