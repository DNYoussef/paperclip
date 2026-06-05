import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

function createApp(opts: {
  enabled: boolean;
  allowedHostnames?: string[];
  bindHost?: string;
  trustedProxyHosts?: string[];
}) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
      trustedProxyHosts: opts.trustedProxyHosts ?? [],
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/api/private", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows health checks for unknown hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", "railway-internal:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/private").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("please run pnpm paperclipai allowed-hostname dotta-macbook-pro");
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/dashboard").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.text).toContain("please run pnpm paperclipai allowed-hostname dotta-macbook-pro");
  }, 20_000);

  it("does not trust spoofed forwarded host from an untrusted peer", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["allowed.example"] });
    const res = await request(app)
      .get("/api/private")
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "allowed.example");

    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("attacker.example");
  });

  it("honors forwarded host only from a declared trusted proxy", async () => {
    const app = createApp({
      enabled: true,
      allowedHostnames: ["allowed.example"],
      trustedProxyHosts: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
    });
    const res = await request(app)
      .get("/api/private")
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "allowed.example");

    expect(res.status).toBe(200);
  });
});
