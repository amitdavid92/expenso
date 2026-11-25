// Secrets the Worker expects at runtime. They are declared here by hand so that
// type checking does not depend on anyone's local `.dev.vars` file
// (`wrangler types` only knows about secrets it can find on disk).
//
// Local development: worker/.dev.vars      Production: `wrangler secret put <NAME>`
interface ExpensoSecrets {
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /**
   * The public address of the web app, e.g. https://expenso.example.workers.dev.
   * Handoff links from Telegram point here; without it the bot offers codes only.
   */
  PUBLIC_WEB_URL?: string;
  /** Key for hashing short handoff codes. Optional: the webhook secret is used if it is not set. */
  LINK_CODE_KEY?: string;
}

declare namespace Cloudflare {
  interface Env extends ExpensoSecrets {}
}
interface Env extends ExpensoSecrets {}
