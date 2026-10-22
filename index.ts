/**
 * katabump-gen — autonomous account worker
 *
 * Local:
 *   npx tsx index.ts
 *   npx tsx index.ts https://rl.katabump.fr/2aea34
 *   npx tsx index.ts https://rl.katabump.fr/2aea34 --once
 *
 * GitHub Actions: scheduled loop until job timeout (see .github/workflows/generate.yml)
 */

import { chromium } from "playwright-extra";
import type { Browser, BrowserContext, Page, Cookie } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const PAX_API_KEY =
  process.env.PAX_API_KEY ||
  "sk-paxsenix-k1rx9mK2OICDy_9tF3YweX_ZDxYZYH1yy8ah8SfOToPeJl_S";

const DEFAULT_REF_URL = process.env.REF_URL || "https://rl.katabump.fr/2aea34";
const REG_URL = "https://dashboard.katabump.com/auth/register";
const SITE_KEY = "0x4AAAAAAA1IssKDXD0TRMjP";
const TMAIL_BASE = "https://www.tmail.pk";
const PAX_API_BASE = "https://api.paxsenix.org/tools";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 45_000);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 300_000);
const MAX_RETRIES = 3;
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 0); // 0 = unlimited

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERR`, ...a),
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FIRST = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
  "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark",
  "Ryan", "Jacob", "Brandon", "Benjamin", "Samuel", "Sohail", "Ahmed", "Hamza",
  "Zain", "Ali", "Khan", "Umer", "Bilal", "Marcus", "Jason",
];
const LAST = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Patel", "Ross", "Foster",
  "Jimenez", "Lewis", "Robinson", "Walker", "Hall", "Allen", "Young",
];
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const randomName = () => ({ first: pick(FIRST), last: pick(LAST) });

function genPassword(): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "!@#$%^&*";
  const all = upper + lower + digits + special;
  const p = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ];
  for (let i = 0; i < 12; i++) p.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p.join("");
}

function extractRefCode(refUrl: string): string {
  try {
    const u = new URL(refUrl);
    return u.pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

async function solveTurnstile(pageUrl: string, siteKey: string): Promise<string | null> {
  if (!PAX_API_KEY) {
    log.warn("PAX_API_KEY missing");
    return null;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `${PAX_API_BASE}/cf-turnstile-solver?url=${encodeURIComponent(pageUrl)}&sitekey=${encodeURIComponent(siteKey)}`,
        {
          headers: { Authorization: `Bearer ${PAX_API_KEY}` },
          signal: AbortSignal.timeout(25_000),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        solution_token?: string;
        error?: string;
        message?: string;
      };
      if (data.ok && data.solution_token) return data.solution_token;
      log.warn(`pax attempt ${attempt}:`, data?.error || data?.message || JSON.stringify(data).slice(0, 120));
    } catch (err) {
      log.warn(`pax attempt ${attempt}:`, err instanceof Error ? err.message : err);
    }
    await sleep(3_000);
  }
  return null;
}

async function getDomains(): Promise<string[]> {
  try {
    const res = await fetch(`${TMAIL_BASE}/api/domains/list`, {
      headers: { "user-agent": DEFAULT_UA, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as Array<{
      is_verified?: boolean;
      admin_approval?: string;
      domain_name: string;
    }>;
    return data
      .filter((d) => d.is_verified && d.admin_approval === "approved")
      .map((d) => d.domain_name);
  } catch (err) {
    log.warn("getDomains", err instanceof Error ? err.message : err);
    return [];
  }
}

type Mailbox = {
  email: string;
  password: string;
  token: string;
  name: { first: string; last: string };
};

async function createTempEmail(): Promise<Mailbox | null> {
  try {
    const domains = await getDomains();
    if (!domains.length) return null;
    const password = genPassword();

    const prepRes = await fetch(`${TMAIL_BASE}/api/mailbox/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": DEFAULT_UA },
      body: JSON.stringify({ phase: "prepare", domains, password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!prepRes.ok) {
      log.warn("mailbox prepare", prepRes.status, await prepRes.text());
      return null;
    }
    const prep = (await prepRes.json()) as { status?: string; capability?: string };
    if (prep.status !== "prepared" || !prep.capability) {
      log.warn("mailbox prepare bad payload", prep);
      return null;
    }

    const commitRes = await fetch(`${TMAIL_BASE}/api/mailbox/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": DEFAULT_UA },
      body: JSON.stringify({ phase: "commit", capability: prep.capability }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!commitRes.ok) {
      log.warn("mailbox commit", commitRes.status, await commitRes.text());
      return null;
    }
    const commit = (await commitRes.json()) as {
      email?: string;
      password?: string;
      token?: string;
    };
    const email = commit.email;
    const finalPass = commit.password || password;
    let token = commit.token;
    if (!email) return null;

    if (!token) {
      const sessRes = await fetch(`${TMAIL_BASE}/api/mailbox/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": DEFAULT_UA },
        body: JSON.stringify({ email, password: finalPass }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!sessRes.ok) return null;
      token = ((await sessRes.json()) as { token?: string }).token;
    }
    if (!token) return null;
    return { email, password: finalPass, token, name: randomName() };
  } catch (err) {
    log.warn("createTempEmail", err instanceof Error ? err.message : err);
    return null;
  }
}

async function getOTP(token: string, email: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${TMAIL_BASE}/api/emails/list?recipient=${encodeURIComponent(email)}&token=${token}`,
      {
        headers: { "user-agent": DEFAULT_UA, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      emails?: Array<{
        body?: string;
        html?: string;
        text?: string;
        preview?: string;
        subject?: string;
      }>;
    };
    if (!data.emails?.length) return null;
    const e0 = data.emails[0];
    const combined = `${e0.body ?? ""} ${e0.html ?? ""} ${e0.text ?? ""} ${e0.preview ?? ""} ${e0.subject ?? ""}`;
    const m = combined.match(/\b\d{6}\b/);
    return m ? m[0] : null;
  } catch (err) {
    log.warn("getOTP", err instanceof Error ? err.message : err);
    return null;
  }
}

function cleanText(html = ""): string {
  return String(html)
    .replace(/\ufeff/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function cleanCaptcha(text: string): string | null {
  return cleanText(text).replace(/[^A-Za-z0-9]/g, "").toUpperCase() || null;
}

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

/** Gemini vision OCR for the security-check captcha image */
async function ocrGemini(pngBuffer: Buffer): Promise<string | null> {
  if (!GEMINI_API_KEY) {
    log.warn("GEMINI_API_KEY not set");
    return null;
  }
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe the exact characters shown in this stylized decorative text image. " +
              "It is a short security code of 4-8 letters and digits. " +
              "Output ONLY the characters, uppercase, with no spaces, punctuation, or extra words.",
          },
          {
            inline_data: {
              mime_type: "image/png",
              data: pngBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32,
    },
  };

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const raw =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      return cleanCaptcha(raw);
    }
    const errText = await res.text();
    // 503 / 429 = overload or rate limit — retry with backoff
    if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
      const wait = 2000 * attempt;
      log.warn(`ocr gemini ${res.status} (try ${attempt}/${maxAttempts}), wait ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`gemini ${res.status}: ${errText.slice(0, 200)}`);
  }
  return null;
}

/** ocr.space public demo as backup */
async function ocrSpace(pngBuffer: Buffer): Promise<string | null> {
  const apiKey = process.env.OCR_SPACE_API_KEY || "helloworld";
  const form = new FormData();
  form.append("base64Image", `data:image/png;base64,${pngBuffer.toString("base64")}`);
  form.append("language", "eng");
  form.append("isOverlayRequired", "false");
  form.append("OCREngine", "2");
  form.append("scale", "true");
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!text.trim() || text.trim()[0] === "<") throw new Error("ocr.space non-JSON");
  const data = JSON.parse(text) as {
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
    ParsedResults?: Array<{ ParsedText?: string }>;
  };
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join("; ")
      : data.ErrorMessage || "ocr.space error";
    throw new Error(String(msg));
  }
  const parsed = (data.ParsedResults || []).map((r) => r.ParsedText || "").join(" ");
  return cleanCaptcha(parsed);
}

async function ocrCaptcha(pngBuffer: Buffer): Promise<string | null> {
  try {
    const t = await ocrGemini(pngBuffer);
    if (t) {
      log.info("ocr via gemini");
      return t;
    }
  } catch (err) {
    log.warn("ocr gemini", err instanceof Error ? err.message : err);
  }
  try {
    const t = await ocrSpace(pngBuffer);
    if (t) {
      log.info("ocr via ocr.space");
      return t;
    }
  } catch (err) {
    log.warn("ocr ocr.space", err instanceof Error ? err.message : err);
  }
  return null;
}

type AccountResult = { email: string; password: string };
type CreateOutcome =
  | { ok: true; account: AccountResult }
  | { ok: false; reason: "rate_limit" | "fail" };

async function createOneAccount(refUrl: string, tag: string): Promise<CreateOutcome> {
  log.info(`[${tag}] Creating temp email...`);
  const mail = await createTempEmail();
  if (!mail) {
    log.warn(`[${tag}] Email creation failed`);
    return { ok: false, reason: "fail" };
  }
  const { email, token: mailToken, name } = mail;
  const password = genPassword();
  log.info(`[${tag}] ${email}`);

  const launchOpts: {
    headless: boolean;
    args: string[];
    executablePath?: string;
  } = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  };
  const exe = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (exe) {
    launchOpts.executablePath = exe;
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch(launchOpts);
    const context: BrowserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const page: Page = await context.newPage();
    const refCode = extractRefCode(refUrl);
    log.info(`[${tag}] Referral code: ${refCode || "(none)"}`);

    log.info(`[${tag}] Loading registration page...`);
    await page.goto(`${REG_URL}${refCode ? "#" + refCode : ""}`, {
      timeout: 25_000,
      waitUntil: "domcontentloaded",
    });
    await sleep(600);

    try {
      if (refCode) {
        await page.context().addCookies([
          {
            name: "referral",
            value: refCode,
            domain: "dashboard.katabump.com",
            path: "/",
          },
        ]);
        log.info(`[${tag}] Referral cookie set: ${refCode}`);
      }
      const cookies = await page.context().cookies();
      const refCookie = cookies.find((c: Cookie) => c.name === "referral");
      log.info(`[${tag}] Referral cookie: ${refCookie ? refCookie.value : "NOT SET"}`);
    } catch {}

    await page.fill('input[name="firstname"]', name.first);
    await page.fill('input[name="lastname"]', name.last);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    try {
      await page.click('input[type="checkbox"]');
    } catch {}

    log.info(`[${tag}] Solving Turnstile (Pax)...`);
    const cfToken = await solveTurnstile(REG_URL, SITE_KEY);
    if (!cfToken) {
      log.warn(`[${tag}] Captcha solve failed`);
      return { ok: false, reason: "fail" };
    }
    log.info(`[${tag}] Turnstile solved`);

    await page.evaluate((t: string) => {
      const selectors = [
        '[name="cf-turnstile-response"]',
        "#cf-turnstile-response",
        '[name="cf_challenge_response"]',
        'textarea[name="cf-turnstile-response"]',
        'input[name="cf-turnstile-response"]',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          input.value = t;
          input.setAttribute("value", t);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      try {
        (window as unknown as { __turnstileToken?: string }).__turnstileToken = t;
      } catch {}
    }, cfToken);

    await sleep(500);
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return;
      }
      const btn = document.querySelector(
        'button[type="submit"], input[type="submit"]',
      ) as HTMLElement | null;
      btn?.click();
    });

    log.info(`[${tag}] Waiting for OTP...`);
    const otpAppeared = await Promise.race([
      page.waitForSelector('input[name="code"]', { timeout: 25_000 }).then(() => true as const),
      page
        .waitForFunction(
          () => {
            const body = (document.body?.innerText || "").toLowerCase();
            const url = location.href.toLowerCase();
            return (
              url.includes("rate_limit") ||
              body.includes("too many account") ||
              body.includes("invalid") ||
              body.includes("try again") ||
              body.includes("already registered") ||
              body.includes("already exists")
            );
          },
          { timeout: 25_000 },
        )
        .then(() => false as const)
        .catch(() => false as const),
    ]).catch(() => false as const);

    if (!otpAppeared) {
      try {
        const info = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          body: (document.body?.innerText || "").slice(0, 400),
        }));
        log.warn(`[${tag}] OTP form not found | url=${info.url} title=${info.title}`);
        log.warn(`[${tag}] page: ${info.body.replace(/\s+/g, " ").slice(0, 220)}`);
        if (/rate_limit|too many account/i.test(info.url + info.body)) {
          return { ok: false, reason: "rate_limit" };
        }
      } catch {
        log.warn(`[${tag}] OTP form not found`);
      }
      return { ok: false, reason: "fail" };
    }

    let foundOTP: string | null = null;
    for (let check = 1; check <= 20; check++) {
      foundOTP = await getOTP(mailToken, email);
      if (foundOTP) {
        log.info(`[${tag}] OTP: ${foundOTP}`);
        break;
      }
      log.info(`[${tag}] OTP check ${check}/20...`);
      await sleep(3_000);
    }
    if (!foundOTP) {
      log.warn(`[${tag}] OTP timed out`);
      return { ok: false, reason: "fail" };
    }

    await page.fill('input[name="code"]', foundOTP);
    await page.click('button[type="submit"]');
    await sleep(2_000);

    let securityCheck = false;
    try {
      await page.waitForSelector("#captcha_code", { timeout: 12_000 });
      securityCheck = true;
    } catch {}

    if (securityCheck) {
      log.info(`[${tag}] Solving security check (OCR)...`);
      let passed = false;
      for (let attempt = 1; attempt <= 8 && !passed; attempt++) {
        try {
          await page.waitForSelector("#captcha-image", { timeout: 8_000 });
        } catch {
          await page.click("#refresh-captcha").catch(() => {});
          await sleep(700);
          continue;
        }

        const dataUrl = await page.evaluate(async () => {
          const img = document?.querySelector("#captcha-image") as HTMLImageElement | null;
          if (!img?.src) return null;
          try {
            const resp = await fetch(img.src, { cache: "no-store" });
            const blob = await resp.blob();
            return await new Promise<string | null>((res, rej) => {
              const reader = new FileReader();
              reader.onloadend = () => res(reader.result as string);
              reader.onerror = rej;
              reader.readAsDataURL(blob);
            });
          } catch {
            return null;
          }
        });

        const b64 = dataUrl?.split(",")[1];
        const code = b64 ? await ocrCaptcha(Buffer.from(b64, "base64")) : null;
        if (!code) {
          await page.click("#refresh-captcha").catch(() => {});
          await sleep(600);
          continue;
        }

        log.info(`[${tag}] Captcha read: ${code} (try ${attempt})`);
        await page.fill("#captcha_code", "");
        await page.fill("#captcha_code", code);
        await page.click("#captcha-btn");

        const passedNow = await page
          .waitForSelector("#captcha_code", { state: "detached", timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (passedNow) {
          passed = true;
          break;
        }
        await page.click("#refresh-captcha").catch(() => {});
        await sleep(500);
      }

      if (!passed) {
        log.warn(`[${tag}] Security check failed`);
        return { ok: false, reason: "fail" };
      }
      log.info(`[${tag}] Security check passed`);
    }

    log.info(`[${tag}] Done: ${email} / ${password}`);
    // machine-readable line for CI harvest
    console.log(`${email}:${password}`);
    return { ok: true, account: { email, password } };
  } catch (err) {
    log.warn(`[${tag}] Error: ${String(err).slice(0, 150)}`);
    return { ok: false, reason: "fail" };
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

async function createWithRetries(refUrl: string, tag: string): Promise<CreateOutcome> {
  for (let r = 0; r < MAX_RETRIES; r++) {
    if (r > 0) log.info(`[${tag}] Retry #${r}...`);
    const result = await createOneAccount(refUrl, tag);
    if (result.ok) return result;
    if (result.reason === "rate_limit") return result;
    if (r < MAX_RETRIES - 1) await sleep(4_000);
  }
  return { ok: false, reason: "fail" };
}

async function autonomousLoop(refUrl: string, once: boolean): Promise<void> {
  let cancelled = false;
  const onStop = () => {
    log.info("stop signal — finishing current account then exit");
    cancelled = true;
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  const accounts: AccountResult[] = [];
  let n = 0;

  log.info(`mode=${once ? "once" : "loop"} | ref=${refUrl}`);
  log.info(`PAX key loaded (${PAX_API_KEY.slice(0, 16)}...)`);
  log.info(`Gemini OCR: ${GEMINI_API_KEY ? "on" : "OFF (set GEMINI_API_KEY)"}`);
  if (MAX_ACCOUNTS > 0) log.info(`MAX_ACCOUNTS=${MAX_ACCOUNTS}`);

  while (!cancelled) {
    n++;
    if (MAX_ACCOUNTS > 0 && accounts.length >= MAX_ACCOUNTS) {
      log.info(`reached MAX_ACCOUNTS=${MAX_ACCOUNTS}`);
      break;
    }

    const tag = String(n);
    log.info(`[${tag}] Starting...`);
    const outcome = await createWithRetries(refUrl, tag);

    if (outcome.ok) {
      accounts.push(outcome.account);
      console.log(`\n── account #${accounts.length} ──`);
      console.log(`${outcome.account.email}:${outcome.account.password}\n`);
      if (once) break;
      log.info(`Sleeping ${LOOP_DELAY_MS / 1000}s before next...`);
      await sleep(LOOP_DELAY_MS);
      continue;
    }

    if (outcome.reason === "rate_limit") {
      log.warn("Rate limited — ending this run so a new runner/IP can start");
      // marker for GitHub Actions to re-queue another job
      try {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync("out", { recursive: true });
        writeFileSync("out/rate_limited", "1\n", "utf8");
      } catch {}
      break; // stop loop; process exits cleanly after summary
    }

    log.warn(`[${tag}] Failed`);
    if (once) break;
    await sleep(10_000);
  }

  if (accounts.length) {
    console.log("\n════ session accounts ════");
    for (const a of accounts) console.log(`${a.email}:${a.password}`);
  }

}

const args = process.argv.slice(2).filter((a) => a !== "--once");
const once = process.argv.includes("--once");
const refUrl = args[0] || DEFAULT_REF_URL;

autonomousLoop(refUrl, once).catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
