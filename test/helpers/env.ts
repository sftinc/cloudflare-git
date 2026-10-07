import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../../src/index";
import { FakeArtifacts } from "./fake-artifacts";

export function makeEnv(overrides: Partial<Env> & Record<string, unknown> = {}): Env {
  return { ...env, COOKIE_SECRET: "test-cookie-secret", ACCESS_JWKS: undefined, ARTIFACTS: new FakeArtifacts(), ...overrides } as unknown as Env;
}

/** Calls the app. Read the body before awaiting done() (push responses stream). */
export async function request(path: string, init: RequestInit = {}, e: Env = makeEnv()) {
  const ctx = createExecutionContext();
  const res = await app.request(`https://git.test${path}`, init, e, ctx);
  return { res, done: () => waitOnExecutionContext(ctx) };
}
