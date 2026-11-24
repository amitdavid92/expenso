// Secrets the Worker expects at runtime. They are declared here by hand so that
// type checking does not depend on anyone's local `.dev.vars` file
// (`wrangler types` only knows about secrets it can find on disk).
//
// Local development: worker/.dev.vars      Production: `wrangler secret put <NAME>`
interface ExpensoSecrets {
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

declare namespace Cloudflare {
  interface Env extends ExpensoSecrets {}
}
interface Env extends ExpensoSecrets {}
