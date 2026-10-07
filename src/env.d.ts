// Optional secret and vars not emitted by `wrangler types` (see .dev.vars.example and wrangler.example.jsonc).
interface OptionalVars {
  ACCESS_JWKS?: string;
  SITE_TITLE?: string;
  LOGO_URL?: string;
  COMPANY_NAME?: string;
  RESTORE_DAYS?: string;
}
interface Env extends OptionalVars {}
declare namespace Cloudflare {
  interface Env extends OptionalVars {}
}
