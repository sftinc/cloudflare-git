// Optional secret not emitted by `wrangler types` (see .dev.vars.example).
declare namespace Cloudflare {
  interface Env {
    ACCESS_JWKS?: string;
  }
}
