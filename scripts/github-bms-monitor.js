/**
 * GitHub Actions BookMyShow Showtime Monitor
 *
 * Runs from GitHub Actions, not Cloudflare Worker.
 *
 * Ethical scope:
 * - Public availability monitoring only.
 * - No auto-booking.
 * - No login automation.
 * - No CAPTCHA/queue bypass.
 * - No proxy rotation.
 * - 10-minute schedule by default.
 *
 * Uses:
 * - GitHub Actions scheduler
 * - Telegram alerts
 * - Cloudflare KV for state storage
 */

const CONFIG = {
  targetUrl:
    "https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20260730",

  targetMovie: "Spider-Man: Brand New Day",

  // Optional filters. Leave blank to track all formats/times.
  targetFormat: "",
  targetTime: "",

  // Separate KV key from your Cloudflare Worker key.
  kvKey: "github-bms-prasads-spiderman-20260730-state-v1",

  fetchTimeoutMs: 15000,

  userAgent:
    "PersonalBookMyShowAvailabilityMonitor/1.0; github-actions; alert-only; no-booking; no-bypass",

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
        "⚠️ BMS GitHub monitor crashed",
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
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Missing GitHub secret/env: ${key}`);
    }
  }

  const checkedAt = new Date().toISOString();

  const previousState = await readKvState();

  const fetchResult = await fetchTargetPage();
  const analysis = analyzePage(fetchResult.html || "");

  const currentState = {
    checkedAt,
    provider: "github-actions",

    targetUrl: CONFIG.targetUrl,
    targetMovie: CONFIG.targetMovie,
    targetFormat: CONFIG.targetFormat,
    targetTime: CONFIG.targetTime,

    httpRequestSucceeded: fetchResult.httpRequestSucceeded,
    pageFetchedSuccessfully: fetchResult.pageFetchedSuccessfully,
    httpStatus: fetchResult.httpStatus,
    fetchError: fetchResult.fetchError,

    pageTitle: analysis.pageTitle,
    blockedPageDetected: isBlockedPage(fetchResult, analysis),

    targetMovieFound: analysis.targetMovieFound,
    extractedShowtimes: analysis.extractedShowtimes,
    showtimeCount: analysis.extractedShowtimes.length,
    showtimeFingerprint: analysis.showtimeFingerprint
  };

  const pageUsableForMonitoring =
    currentState.pageFetchedSuccessfully &&
    currentState.httpStatus === 200 &&
    !currentState.blockedPageDetected &&
    currentState.targetMovieFound &&
    currentState.showtimeCount > 0;

  const decision = decide(previousState, currentState, pageUsableForMonitoring);

  console.log("Current monitor result:");
  console.log(
    JSON.stringify(
      {
        checkedAt,
        httpStatus: currentState.httpStatus,
        pageTitle: currentState.pageTitle,
        blockedPageDetected: currentState.blockedPageDetected,
        targetMovieFound: currentState.targetMovieFound,
        showtimeCount: currentState.showtimeCount,
        pageUsableForMonitoring,
        decision
      },
      null,
      2
    )
  );

  console.log("\nSafe fetched-text preview:");
  console.log(analysis.normalizedTextPreview || "");

  if (decision.shouldSendTelegram) {
    await sendTelegram(decision.telegramMessage);
  }

  const nextState = {
    ...previousState,

    lastCheckedAt: checkedAt,
    lastProvider: "github-actions",

    lastPageStatus: pageUsableForMonitoring
      ? "readable"
      : "blocked_or_unusable",

    lastHttpStatus: currentState.httpStatus,
    lastPageTitle: currentState.pageTitle,
    lastBlockedPageDetected: currentState.blockedPageDetected,
    lastTargetMovieFound: currentState.targetMovieFound,
    lastShowtimeCount: currentState.showtimeCount,
    lastFetchError: currentState.fetchError || null
  };

  // Very important:
  // Do not overwrite the last good baseline with blocked/empty pages.
  if (pageUsableForMonitoring) {
    nextState.lastReadableAt = checkedAt;
    nextState.lastReadableShowtimes = currentState.extractedShowtimes;
    nextState.lastReadableFingerprint = currentState.showtimeFingerprint;
  }

  await writeKvState(nextState);

  console.log("\nState saved to Cloudflare KV.");
}

function decide(previousState, currentState, pageUsableForMonitoring) {
  if (!previousState) {
    if (!pageUsableForMonitoring) {
      return {
        shouldSendTelegram: true,
        reason: "First run, but page is blocked or unusable.",
        telegramMessage: [
          "⚠️ BMS GitHub monitor first check",
          "",
          "The page is not usable from GitHub Actions right now.",
          "",
          `HTTP: ${currentState.httpStatus}`,
          `Title: ${currentState.pageTitle || "N/A"}`,
          `Blocked: ${currentState.blockedPageDetected}`,
          `Movie found: ${currentState.targetMovieFound}`,
          `Showtimes found: ${currentState.showtimeCount}`,
          "",
          "If this says blocked, GitHub also cannot currently read the BookMyShow showtimes.",
          "",
          CONFIG.targetUrl
        ].join("\n")
      };
    }

    return {
      shouldSendTelegram: true,
      reason: "First run and page is readable. Baseline created.",
      telegramMessage: [
        "✅ BMS GitHub monitor baseline created",
        "",
        "GitHub Actions can read the BookMyShow page.",
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
          "⚠️ BMS monitor update",
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
        "✅ BMS monitor update",
        "",
        "GitHub Actions can now read the BookMyShow page.",
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

    lines.push(`Current count: ${currentState.showtimeCount}`, "", CONFIG.targetUrl);

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

async function fetchTargetPage() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);

  try {
    const response = await fetch(CONFIG.targetUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-IN,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent": CONFIG.userAgent
      }
    });

    return {
      httpRequestSucceeded: true,
      pageFetchedSuccessfully: response.ok,
      httpStatus: response.status,
      html: await response.text(),
      fetchError: null
    };
  } catch (error) {
    return {
      httpRequestSucceeded: false,
      pageFetchedSuccessfully: false,
      httpStatus: null,
      html: "",
      fetchError: error?.message || String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function analyzePage(html) {
  const pageTitle = extractTitle(html);
  const normalizedText = normalizeText(html);
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
    pageTitle,
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

    // Keep the segment bounded so header/footer times do not get picked up.
    const segmentEnd = Math.min(nextMovieStart, start + 900);
    const segment = text.slice(start, segmentEnd);
    const rowDescriptor = extractRowDescriptor(segment);

    const timeRegex = /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/gi;
    let match;

    while ((match = timeRegex.exec(segment)) !== null) {
      const rawTime = normalizeTime(match[0]);

      const nearTimeText = segment.slice(
        Math.max(0, match.index - 80),
        match.index + 140
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
    .slice(0, 120);
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

function isBlockedPage(fetchResult, analysis) {
  const title = String(analysis.pageTitle || "").toLowerCase();
  const preview = String(analysis.normalizedTextPreview || "").toLowerCase();

  return (
    fetchResult.httpStatus === 403 ||
    title.includes("attention required") ||
    preview.includes("sorry, you have been blocked") ||
    preview.includes("you are unable to access bookmyshow.com") ||
    preview.includes("please enable cookies") ||
    preview.includes("cloudflare ray id")
  );
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

function normalizeText(html) {
  return decodeBasicHtmlEntities(
    decodeUnicodeEscapes(String(html || ""))
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
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

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeText(match[1]).slice(0, 200) : "";
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