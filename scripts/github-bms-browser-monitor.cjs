/**
 * GitHub Actions + Playwright BookMyShow Browser Monitor
 *
 * This uses a real Chromium browser through Playwright.
 *
 * Ethical scope:
 * - Public availability monitoring only.
 * - No auto-booking.
 * - No login automation.
 * - No CAPTCHA solving.
 * - No queue bypass.
 * - No proxy rotation.
 * - 10-minute schedule by default.
 */

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG = {
  targetUrl:
    "https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20260730",

  targetMovie: "Spider-Man: Brand New Day",

  // Leave blank to track all formats/times.
  targetFormat: "",
  targetTime: "",

  kvKey: "playwright-bms-prasads-spiderman-20260730-state-v1",

  debugDir: "bms-debug",

  navigationTimeoutMs: 45000,
  pageSettleMs: 12000,

  knownFormatKeywords: [
    "pcx hdr by barco",
    "hdr by barco",
    "pcx screen",
    "imax",
    "3d",
    "2d",
    "4dx",
    "screen x"
  ]
};

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_KV_NAMESPACE_ID"
];

main().catch(async (error) => {
  console.error("Fatal error:", error);

  try {
    await sendTelegram(
      [
        "⚠️ BMS Playwright monitor crashed",
        "",
        error?.message || String(error)
      ].join("\n")
    );
  } catch (telegramError) {
    console.error("Could not send crash alert:", telegramError);
  }

  process.exit(1);
});

async function main() {
  ensureRequiredEnv();
  ensureDebugDir();

  const checkedAt = new Date().toISOString();
  const previousState = await readKvState();

  const browserResult = await fetchWithBrowser();
  const analysis = analyzeText(browserResult.bodyText || "");

  const currentState = {
    checkedAt,
    provider: "github-actions-playwright",

    targetUrl: CONFIG.targetUrl,
    targetMovie: CONFIG.targetMovie,
    targetFormat: CONFIG.targetFormat,
    targetTime: CONFIG.targetTime,

    httpStatus: browserResult.httpStatus,
    pageTitle: browserResult.pageTitle,
    finalUrl: browserResult.finalUrl,
    browserError: browserResult.browserError,

    blockedPageDetected: isBlockedPage(browserResult, analysis),

    targetMovieFound: analysis.targetMovieFound,
    extractedShowtimes: analysis.extractedShowtimes,
    showtimeCount: analysis.extractedShowtimes.length,
    showtimeFingerprint: analysis.showtimeFingerprint
  };

  const pageUsableForMonitoring =
    currentState.httpStatus &&
    currentState.httpStatus >= 200 &&
    currentState.httpStatus < 400 &&
    !currentState.blockedPageDetected &&
    currentState.targetMovieFound &&
    currentState.showtimeCount > 0;

  const decision = decide(previousState, currentState, pageUsableForMonitoring);

  const publicLog = {
    checkedAt,
    httpStatus: currentState.httpStatus,
    pageTitle: currentState.pageTitle,
    finalUrl: currentState.finalUrl,
    blockedPageDetected: currentState.blockedPageDetected,
    targetMovieFound: currentState.targetMovieFound,
    showtimeCount: currentState.showtimeCount,
    pageUsableForMonitoring,
    decision
  };

  console.log("Current browser monitor result:");
  console.log(JSON.stringify(publicLog, null, 2));

  fs.writeFileSync(
    path.join(CONFIG.debugDir, "result.json"),
    JSON.stringify(
      {
        ...publicLog,
        extractedShowtimes: currentState.extractedShowtimes
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(CONFIG.debugDir, "page-text-preview.txt"),
    String(browserResult.bodyText || "").slice(0, 5000)
  );

  if (decision.shouldSendTelegram) {
    await sendTelegram(decision.telegramMessage);
  }

  const nextState = {
    ...previousState,

    lastCheckedAt: checkedAt,
    lastProvider: "github-actions-playwright",

    lastPageStatus: pageUsableForMonitoring
      ? "readable"
      : "blocked_or_unusable",

    lastHttpStatus: currentState.httpStatus,
    lastPageTitle: currentState.pageTitle,
    lastFinalUrl: currentState.finalUrl,
    lastBlockedPageDetected: currentState.blockedPageDetected,
    lastTargetMovieFound: currentState.targetMovieFound,
    lastShowtimeCount: currentState.showtimeCount,
    lastBrowserError: currentState.browserError || null
  };

  // Important: do not overwrite last good baseline with blocked/empty pages.
  if (pageUsableForMonitoring) {
    nextState.lastReadableAt = checkedAt;
    nextState.lastReadableShowtimes = currentState.extractedShowtimes;
    nextState.lastReadableFingerprint = currentState.showtimeFingerprint;
  }

  await writeKvState(nextState);

  console.log("\nState saved to Cloudflare KV.");
}

function ensureRequiredEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Missing GitHub secret/env: ${key}`);
    }
  }
}

function ensureDebugDir() {
  fs.mkdirSync(CONFIG.debugDir, { recursive: true });
}

async function fetchWithBrowser() {
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext({
      viewport: {
        width: 1366,
        height: 768
      },
      locale: "en-IN"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.navigationTimeoutMs);

    const response = await page.goto(CONFIG.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.navigationTimeoutMs
    });

    // Give normal JavaScript-rendered content time to appear.
    await page.waitForTimeout(CONFIG.pageSettleMs);

    try {
      await page.waitForLoadState("networkidle", {
        timeout: 10000
      });
    } catch {
      // Some modern pages never fully become network-idle. That's okay.
    }

    const pageTitle = await page.title();
    const finalUrl = page.url();
    const httpStatus = response ? response.status() : null;

    let bodyText = "";
    try {
      bodyText = await page.locator("body").innerText({
        timeout: 10000
      });
    } catch {
      bodyText = await page.content();
    }

    await page.screenshot({
      path: path.join(CONFIG.debugDir, "screenshot.png"),
      fullPage: true
    });

    fs.writeFileSync(
      path.join(CONFIG.debugDir, "page.html"),
      await page.content()
    );

    await context.close();

    return {
      ok: true,
      httpStatus,
      pageTitle,
      finalUrl,
      bodyText,
      browserError: null
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      pageTitle: "",
      finalUrl: CONFIG.targetUrl,
      bodyText: "",
      browserError: error?.message || String(error)
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function analyzeText(text) {
  const normalizedText = normalizeText(text);
  const lowerText = normalizedText.toLowerCase();

  const targetMovieFound = lowerText.includes(CONFIG.targetMovie.toLowerCase());

  const allShowtimes = extractShowtimesForTargetMovie(normalizedText);

  const filteredShowtimes = allShowtimes.filter((item) => {
    const label = item.label.toLowerCase();

    if (
      CONFIG.targetFormat &&
      !label.includes(CONFIG.targetFormat.toLowerCase())
    ) {
      return false;
    }

    if (
      CONFIG.targetTime &&
      item.time.toLowerCase() !== CONFIG.targetTime.toLowerCase()
    ) {
      return false;
    }

    return true;
  });

  return {
    normalizedTextPreview: normalizedText.slice(0, 1500),
    targetMovieFound,
    extractedShowtimes: filteredShowtimes,
    showtimeFingerprint: JSON.stringify(
      filteredShowtimes.map((x) => x.label).sort()
    )
  };
}

function extractShowtimesForTargetMovie(text) {
  const lowerText = text.toLowerCase();
  const movieLower = CONFIG.targetMovie.toLowerCase();

  const moviePositions = [];
  let searchIndex = 0;

  while (true) {
    const foundAt = lowerText.indexOf(movieLower, searchIndex);
    if (foundAt === -1) break;

    moviePositions.push(foundAt);
    searchIndex = foundAt + movieLower.length;
  }

  if (!moviePositions.length) return [];

  const results = [];

  for (let i = 0; i < moviePositions.length; i++) {
    const start = moviePositions[i];
    const nextMovieStart = moviePositions[i + 1] || text.length;

    const segmentEnd = Math.min(nextMovieStart, start + 1200);
    const segment = text.slice(start, segmentEnd);
    const rowDescriptor = extractRowDescriptor(segment);

    const timeRegex = /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/gi;
    let match;

    while ((match = timeRegex.exec(segment)) !== null) {
      const rawTime = normalizeTime(match[0]);

      const nearTimeText = segment.slice(
        Math.max(0, match.index - 100),
        match.index + 180
      );

      const detectedFormat = detectFormat(`${nearTimeText} ${rowDescriptor}`);

      const label = dedupeWords(
        [CONFIG.targetMovie, rowDescriptor, rawTime, detectedFormat]
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .join(" | ")
      );

      results.push({
        movie: CONFIG.targetMovie,
        row: rowDescriptor,
        time: rawTime,
        format: detectedFormat,
        label
      });
    }
  }

  const map = new Map();

  for (const item of results) {
    if (!map.has(item.label)) {
      map.set(item.label, item);
    }
  }

  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function extractRowDescriptor(segment) {
  const beforeFirstTime = segment.split(
    /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/i
  )[0];

  return beforeFirstTime
    .replace(new RegExp(escapeRegExp(CONFIG.targetMovie), "i"), "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function detectFormat(text) {
  const lower = text.toLowerCase();

  const found = CONFIG.knownFormatKeywords.filter((format) =>
    lower.includes(format)
  );

  if (!found.length) return "";

  const map = {
    "pcx hdr by barco": "PCX HDR by BARCO",
    "hdr by barco": "HDR By Barco",
    "pcx screen": "PCX Screen",
    imax: "IMAX",
    "3d": "3D",
    "2d": "2D",
    "4dx": "4DX",
    "screen x": "Screen X"
  };

  return found.map((x) => map[x] || x).join(", ");
}

function isBlockedPage(browserResult, analysis) {
  const title = String(browserResult.pageTitle || "").toLowerCase();
  const text = String(analysis.normalizedTextPreview || "").toLowerCase();

  return (
    browserResult.httpStatus === 403 ||
    title.includes("attention required") ||
    title.includes("just a moment") ||
    text.includes("sorry, you have been blocked") ||
    text.includes("you are unable to access bookmyshow.com") ||
    text.includes("please enable cookies") ||
    text.includes("cloudflare ray id") ||
    text.includes("verify you are human") ||
    text.includes("checking your browser") ||
    text.includes("captcha")
  );
}

function decide(previousState, currentState, pageUsableForMonitoring) {
  if (!previousState) {
    if (!pageUsableForMonitoring) {
      return {
        shouldSendTelegram: true,
        reason: "First browser run, but page is blocked or unusable.",
        telegramMessage: [
          "⚠️ BMS browser monitor first check",
          "",
          "The page is not usable from GitHub Playwright right now.",
          "",
          `HTTP: ${currentState.httpStatus}`,
          `Title: ${currentState.pageTitle || "N/A"}`,
          `Blocked: ${currentState.blockedPageDetected}`,
          `Movie found: ${currentState.targetMovieFound}`,
          `Showtimes found: ${currentState.showtimeCount}`,
          "",
          "This used a real Chromium browser, not plain fetch.",
          "",
          CONFIG.targetUrl
        ].join("\n")
      };
    }

    return {
      shouldSendTelegram: true,
      reason: "First browser run and page is readable. Baseline created.",
      telegramMessage: [
        "✅ BMS browser monitor baseline created",
        "",
        "GitHub Playwright can read the BookMyShow page.",
        "",
        `Movie: ${CONFIG.targetMovie}`,
        `Showtime count: ${currentState.showtimeCount}`,
        "",
        "Current timings:",
        ...currentState.extractedShowtimes.map((x) => `• ${x.label}`),
        "",
        CONFIG.targetUrl
      ].join("\n")
    };
  }

  const previousPageStatus = previousState.lastPageStatus || "unknown";

  if (!pageUsableForMonitoring) {
    if (previousPageStatus !== "blocked_or_unusable") {
      return {
        shouldSendTelegram: true,
        reason: "Page changed from readable to blocked/unusable.",
        telegramMessage: [
          "⚠️ BMS browser monitor update",
          "",
          "The page was readable earlier, but is not usable now.",
          "",
          `HTTP: ${currentState.httpStatus}`,
          `Title: ${currentState.pageTitle || "N/A"}`,
          `Blocked: ${currentState.blockedPageDetected}`,
          `Movie found: ${currentState.targetMovieFound}`,
          `Showtimes found: ${currentState.showtimeCount}`,
          "",
          CONFIG.targetUrl
        ].join("\n")
      };
    }

    return {
      shouldSendTelegram: false,
      reason: "Still blocked/unusable. No duplicate alert."
    };
  }

  if (previousPageStatus === "blocked_or_unusable") {
    return {
      shouldSendTelegram: true,
      reason: "Page became readable.",
      telegramMessage: [
        "✅ BMS browser monitor update",
        "",
        "GitHub Playwright can now read the BookMyShow page.",
        "",
        `Movie: ${CONFIG.targetMovie}`,
        `Showtime count: ${currentState.showtimeCount}`,
        "",
        "Current timings:",
        ...currentState.extractedShowtimes.map((x) => `• ${x.label}`),
        "",
        CONFIG.targetUrl
      ].join("\n")
    };
  }

  const previousLabels = new Set(
    (previousState.lastReadableShowtimes || []).map((x) => x.label)
  );

  const currentLabels = new Set(
    currentState.extractedShowtimes.map((x) => x.label)
  );

  const added = [...currentLabels].filter((x) => !previousLabels.has(x));
  const removed = [...previousLabels].filter((x) => !currentLabels.has(x));

  if (added.length || removed.length) {
    const lines = [
      "🎟️ BookMyShow showtime change!",
      "",
      `Movie: ${CONFIG.targetMovie}`,
      ""
    ];

    if (added.length) {
      lines.push("✅ Added timings:");
      added.slice(0, 20).forEach((x) => lines.push(`+ ${x}`));
      lines.push("");
    }

    if (removed.length) {
      lines.push("❌ Removed timings:");
      removed.slice(0, 20).forEach((x) => lines.push(`- ${x}`));
      lines.push("");
    }

    lines.push(
      `Current count: ${currentState.showtimeCount}`,
      "",
      CONFIG.targetUrl
    );

    return {
      shouldSendTelegram: true,
      reason: "Showtime list changed.",
      added,
      removed,
      telegramMessage: lines.join("\n")
    };
  }

  return {
    shouldSendTelegram: false,
    reason: "Readable, but no showtime changes."
  };
}

async function readKvState() {
  const response = await fetch(kvUrl(CONFIG.kvKey), {
    method: "GET",
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
    }
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(
      `KV read failed: HTTP ${response.status} ${await response.text()}`
    );
  }

  return JSON.parse(await response.text());
}

async function writeKvState(state) {
  const response = await fetch(kvUrl(CONFIG.kvKey), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(state)
  });

  if (!response.ok) {
    throw new Error(
      `KV write failed: HTTP ${response.status} ${await response.text()}`
    );
  }
}

function kvUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(
    key
  )}`;
}

async function sendTelegram(text) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false
      })
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Telegram failed: HTTP ${response.status} ${body}`);
  }
}

function normalizeText(value) {
  return decodeBasicHtmlEntities(
    decodeUnicodeEscapes(String(value || ""))
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeUnicodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return _;
    }
  });
}

function decodeBasicHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeTime(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function dedupeWords(text) {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}