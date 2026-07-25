/**
 * BookMyShow Showtime Change Monitor
 *
 * Ethical scope:
 * - Public availability monitoring only.
 * - No auto-booking.
 * - No login automation.
 * - No CAPTCHA/queue bypass.
 * - No proxy rotation.
 * - Keep cron at 2 minutes or slower.
 */

const CONFIG = {
  targetUrl:
    "https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20260730",

  targetMovie: "Spider-Man: Brand New Day",

  // Optional filters. Leave blank to track all formats/times for this movie.
  targetFormat: "",
  targetTime: "",

  alertOnShowtimeChanges: true,

  // Recommended false: first good run saves baseline but does not alert.
  alertOnFirstRun: false,

  sendErrorAlerts: false,

  kvStateKey: "bms-prasads-spiderman-20260730-state-v1",

  fetchTimeoutMs: 15000,

  userAgent:
    "PersonalBookMyShowAvailabilityMonitor/1.0; alert-only; no-booking; no-bypass",

  availabilityKeywords: [
    "available",
    "buy tickets",
    "select show timings",
    "select seats",
    "fast filling"
  ],

  unavailableKeywords: [
    "no shows available",
    "sorry, no shows available",
    "coming soon",
    "unavailable",
    "sold out",
    "housefull"
  ],

  knownFormatKeywords: [
    "pcx hdr by barco",
    "hdr by barco",
    "pcx screen",
    "imax",
    "3d",
    "2d",
    "4dx",
    "screen x"
  ],

  debugPreviewChars: 1500
};

const ACTIVE_WATCH_KEY = "bms:active-watch";
const SNAPSHOT_KEY_PREFIX = "bms:snapshot:";
const HISTORY_KEY_PREFIX = "bms:history:";
const NOTIFY_CHATS_KEY = "bms:notify-chats";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return textResponse(
        [
          "BookMyShow monitor is live.",
          "",
          "Routes:",
          "/telegram - Telegram webhook for watch commands",
          "/test - run check without alert or saving",
          "/debug - show safe debug output",
          "/seed - save current page as baseline only if page is usable",
          "/last - show last saved state",
          "/clear - delete saved baseline",
          "/telegram-test - send a test Telegram message"
        ].join("\n")
      );
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/test") {
      return jsonResponse(
        await runCheck(env, {
          mode: "test",
          saveState: false,
          sendAlerts: false,
          includeDebug: false
        })
      );
    }

    if (url.pathname === "/debug") {
      return jsonResponse(
        await runCheck(env, {
          mode: "debug",
          saveState: false,
          sendAlerts: false,
          includeDebug: true
        })
      );
    }

    if (url.pathname === "/seed") {
      const adminCheck = requireAdminIfConfigured(request, env);
      if (!adminCheck.ok) return jsonResponse(adminCheck, 401);

      const result = await runCheck(env, {
        mode: "seed",
        saveState: true,
        sendAlerts: false,
        includeDebug: true
      });

      return jsonResponse({
        ...result,
        seedMessage: result.stateSaved
          ? "Baseline saved. Future cron runs alert only when timings change."
          : "Baseline NOT saved. The page is not usable for monitoring, likely blocked or no showtimes found."
      });
    }

    if (url.pathname === "/clear") {
      const adminCheck = requireAdminIfConfigured(request, env);
      if (!adminCheck.ok) return jsonResponse(adminCheck, 401);

      if (!env.BMS_STATE) {
        return jsonResponse({
          ok: false,
          error: "KV binding BMS_STATE is missing."
        });
      }

      await env.BMS_STATE.delete(CONFIG.kvStateKey);

      return jsonResponse({
        ok: true,
        message: "Saved baseline deleted from KV.",
        deletedKey: CONFIG.kvStateKey
      });
    }

    if (url.pathname === "/last") {
      return jsonResponse({
        ok: true,
        kvBindingPresent: Boolean(env.BMS_STATE),
        lastState: await readLastState(env)
      });
    }

    if (url.pathname === "/telegram-test") {
      const adminCheck = requireAdminIfConfigured(request, env);
      if (!adminCheck.ok) return jsonResponse(adminCheck, 401);

      const telegramResult = await sendTelegramMessage(
        env,
        [
          "✅ Telegram test alert",
          "",
          "Your BookMyShow monitor can send Telegram messages.",
          "",
          `Movie: ${CONFIG.targetMovie}`,
          `URL: ${CONFIG.targetUrl}`
        ].join("\n")
      );

      return jsonResponse({
        ok: telegramResult.ok,
        telegramResult: sanitizeTelegramResult(telegramResult)
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "Unknown route",
        availableRoutes: [
          "/test",
          "/debug",
          "/seed",
          "/last",
          "/clear",
          "/telegram-test"
        ]
      },
      404
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runCheck(env, {
        mode: "cron",
        saveState: true,
        sendAlerts: true,
        includeDebug: false,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime
      })
    );
  }
};

async function runCheck(env, options) {
  const checkedAt = new Date().toISOString();
  const kvBindingPresent = Boolean(env.BMS_STATE);
  const telegramConfigured = Boolean(
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
  );

  try {
    const previousState = kvBindingPresent ? await readLastState(env) : null;
    const fetchResult = await fetchTargetPage();
    const analysis = analyzePage(fetchResult.html || "");

    const blockedPageDetected = isBlockedPage(fetchResult, analysis);

    const currentState = {
      checkedAt,
      targetUrl: CONFIG.targetUrl,
      targetMovie: CONFIG.targetMovie,
      targetFormat: CONFIG.targetFormat,
      targetTime: CONFIG.targetTime,

      pageFetchedSuccessfully: fetchResult.pageFetchedSuccessfully,
      httpRequestSucceeded: fetchResult.httpRequestSucceeded,
      httpStatus: fetchResult.httpStatus,
      fetchError: fetchResult.fetchError,

      blockedPageDetected,

      targetMovieFound: analysis.targetMovieFound,
      targetFormatFound: analysis.targetFormatFound,
      targetTimeFound: analysis.targetTimeFound,

      availabilityTextFound: analysis.availabilityTextFound,
      unavailableTextFound: analysis.unavailableTextFound,

      extractedShowtimes: analysis.extractedShowtimes,
      showtimeCount: analysis.extractedShowtimes.length,
      showtimeFingerprint: analysis.showtimeFingerprint,

      matchedAvailabilityKeywords: analysis.matchedAvailabilityKeywords,
      matchedUnavailableKeywords: analysis.matchedUnavailableKeywords,

      pageTitle: analysis.pageTitle
    };

    const comparison = compareStates(previousState, currentState);

    let alertSent = false;
    let telegramResult = null;

    if (options.sendAlerts && comparison.shouldAlert) {
      telegramResult = await sendTelegramMessage(
        env,
        buildShowtimeChangeMessage(currentState, comparison)
      );
      alertSent = telegramResult.ok;
    }

    const pageUsableForMonitoring =
      currentState.pageFetchedSuccessfully &&
      currentState.httpStatus === 200 &&
      !currentState.blockedPageDetected &&
      currentState.targetMovieFound &&
      currentState.showtimeCount > 0;

    let stateActuallySaved = false;

    if (options.saveState && kvBindingPresent && pageUsableForMonitoring) {
      const stateToSave = {
        ...currentState,
        previousCheckedAt: previousState ? previousState.checkedAt : null,
        lastComparison: comparison,
        lastAlertAttempted: Boolean(options.sendAlerts && comparison.shouldAlert),
        lastAlertSent: alertSent,
        lastTelegramResult: sanitizeTelegramResult(telegramResult)
      };

      await env.BMS_STATE.put(CONFIG.kvStateKey, JSON.stringify(stateToSave));
      stateActuallySaved = true;
    }

    const output = {
      ok: true,
      mode: options.mode,
      checkedAt,
      kvBindingPresent,
      telegramConfigured,

      targetUrl: CONFIG.targetUrl,
      targetMovie: CONFIG.targetMovie,
      targetFormat: CONFIG.targetFormat,
      targetTime: CONFIG.targetTime,

      pageFetchedSuccessfully: currentState.pageFetchedSuccessfully,
      httpRequestSucceeded: currentState.httpRequestSucceeded,
      httpStatus: currentState.httpStatus,
      fetchError: currentState.fetchError,

      blockedPageDetected,
      pageUsableForMonitoring,

      targetMovieFound: currentState.targetMovieFound,
      targetFormatFound: currentState.targetFormatFound,
      targetTimeFound: currentState.targetTimeFound,

      availabilityTextFound: currentState.availabilityTextFound,
      unavailableTextFound: currentState.unavailableTextFound,

      extractedShowtimes: currentState.extractedShowtimes,
      showtimeCount: currentState.showtimeCount,
      previousShowtimeCount: previousState
        ? previousState.showtimeCount || 0
        : null,
      baselineExists: Boolean(previousState),

      showtimesChanged: comparison.showtimesChanged,
      addedShowtimes: comparison.addedShowtimes,
      removedShowtimes: comparison.removedShowtimes,
      alertWouldBeSent: comparison.shouldAlert,
      alertSent,

      stateSaved: stateActuallySaved,
      stateSaveSkippedReason: stateActuallySaved
        ? null
        : getStateSaveSkippedReason(options, kvBindingPresent, pageUsableForMonitoring, currentState),

      telegramResult: sanitizeTelegramResult(telegramResult)
    };

    if (options.includeDebug) {
      output.debug = {
        pageTitle: analysis.pageTitle,
        htmlLength: fetchResult.html ? fetchResult.html.length : 0,
        normalizedTextPreview: analysis.normalizedTextPreview,
        movieContexts: analysis.movieContexts,
        timeContexts: analysis.timeContexts,
        note:
          "Safe debug output only. Telegram token, chat ID, and Cloudflare secrets are not exposed."
      };
    }

    return output;
  } catch (error) {
    const errorOutput = {
      ok: false,
      checkedAt,
      mode: options.mode,
      errorName: error?.name || "Error",
      errorMessage: error?.message || String(error),
      kvBindingPresent,
      telegramConfigured
    };

    if (options.sendAlerts && CONFIG.sendErrorAlerts) {
      try {
        errorOutput.telegramErrorAlert = sanitizeTelegramResult(
          await sendTelegramMessage(
            env,
            [
              "⚠️ BookMyShow monitor error",
              "",
              `Movie: ${CONFIG.targetMovie}`,
              `Time: ${checkedAt}`,
              "",
              `Error: ${errorOutput.errorMessage}`,
              "",
              CONFIG.targetUrl
            ].join("\n")
          )
        );
      } catch (telegramError) {
        errorOutput.telegramErrorAlert = {
          attempted: true,
          ok: false,
          error: telegramError?.message || String(telegramError)
        };
      }
    }

    return errorOutput;
  }
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
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false
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
  const availabilityMatches = matchedTerms(lowerText, CONFIG.availabilityKeywords);
  const unavailableMatches = matchedTerms(lowerText, CONFIG.unavailableKeywords);

  const extractedShowtimes = extractShowtimesForTargetMovie(normalizedText);

  const targetFormatFound = CONFIG.targetFormat
    ? extractedShowtimes.some((item) =>
        item.label.toLowerCase().includes(CONFIG.targetFormat.toLowerCase())
      )
    : true;

  const targetTimeFound = CONFIG.targetTime
    ? extractedShowtimes.some(
        (item) => item.time.toLowerCase() === CONFIG.targetTime.toLowerCase()
      )
    : true;

  const filteredShowtimes = extractedShowtimes.filter((item) => {
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
    normalizedTextPreview: normalizedText.slice(0, CONFIG.debugPreviewChars),
    targetMovieFound,
    targetFormatFound,
    targetTimeFound,
    availabilityTextFound: availabilityMatches.length > 0,
    unavailableTextFound: unavailableMatches.length > 0,
    matchedAvailabilityKeywords: availabilityMatches,
    matchedUnavailableKeywords: unavailableMatches,
    extractedShowtimes: filteredShowtimes,
    showtimeFingerprint: fingerprintShowtimes(filteredShowtimes),
    movieContexts: buildContexts(normalizedText, [CONFIG.targetMovie]),
    timeContexts: buildContexts(
      normalizedText,
      filteredShowtimes.map((x) => x.time)
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

  return uniqueShowtimes(results).sort((a, b) => a.label.localeCompare(b.label));
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

  return found.map(titleCaseFormat).filter(Boolean).join(", ");
}

function titleCaseFormat(value) {
  const normalized = value.trim().toLowerCase();

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

  return map[normalized] || value;
}

function compareStates(previousState, currentState) {
  if (!previousState || !previousState.showtimeFingerprint) {
    return {
      baselineExists: false,
      showtimesChanged: false,
      addedShowtimes: [],
      removedShowtimes: [],
      shouldAlert:
        CONFIG.alertOnFirstRun &&
        currentState.pageFetchedSuccessfully &&
        !currentState.blockedPageDetected &&
        currentState.targetMovieFound &&
        currentState.showtimeCount > 0,
      reason: "No previous baseline found. Current good state will be saved first."
    };
  }

  const previousLabels = new Set(
    (previousState.extractedShowtimes || []).map((item) => item.label)
  );
  const currentLabels = new Set(
    (currentState.extractedShowtimes || []).map((item) => item.label)
  );

  const addedShowtimes = [...currentLabels].filter(
    (label) => !previousLabels.has(label)
  );
  const removedShowtimes = [...previousLabels].filter(
    (label) => !currentLabels.has(label)
  );
  const showtimesChanged =
    addedShowtimes.length > 0 || removedShowtimes.length > 0;

  const basicPageHealthy =
    currentState.pageFetchedSuccessfully &&
    !currentState.blockedPageDetected &&
    currentState.targetMovieFound &&
    currentState.showtimeCount > 0;

  return {
    baselineExists: true,
    showtimesChanged,
    addedShowtimes,
    removedShowtimes,
    shouldAlert:
      CONFIG.alertOnShowtimeChanges && showtimesChanged && basicPageHealthy,
    reason: showtimesChanged
      ? "Showtime list changed."
      : "No showtime change detected."
  };
}

function buildShowtimeChangeMessage(currentState, comparison) {
  const lines = [
    "🎟️ BookMyShow showtime change!",
    "",
    "A change was detected in the show timings section.",
    "",
    `Movie: ${CONFIG.targetMovie}`
  ];

  if (CONFIG.targetFormat) lines.push(`Format filter: ${CONFIG.targetFormat}`);
  if (CONFIG.targetTime) lines.push(`Time filter: ${CONFIG.targetTime}`);

  lines.push("");

  if (comparison.addedShowtimes.length) {
    lines.push("✅ Added timings:");
    comparison.addedShowtimes
      .slice(0, 20)
      .forEach((item) => lines.push(`+ ${item}`));
    lines.push("");
  }

  if (comparison.removedShowtimes.length) {
    lines.push("❌ Removed timings:");
    comparison.removedShowtimes
      .slice(0, 20)
      .forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  lines.push(
    `Current showtime count: ${currentState.showtimeCount}`,
    "",
    "Open manually:",
    CONFIG.targetUrl
  );

  return lines.join("\n");
}

async function readLastState(env) {
  if (!env.BMS_STATE) return null;

  const raw = await env.BMS_STATE.get(CONFIG.kvStateKey);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return {
      parseError: true,
      rawPreview: raw.slice(0, 300)
    };
  }
}

async function sendTelegramMessage(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN secret.");
  }

  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_CHAT_ID secret.");
  }

  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });

  return {
    attempted: true,
    ok: response.ok,
    status: response.status,
    bodyPreview: (await response.text()).slice(0, 500)
  };
}

function requireAdminIfConfigured(request, env) {
  if (!env.ADMIN_KEY) return { ok: true, adminProtection: "not_configured" };

  const url = new URL(request.url);
  const providedKey = url.searchParams.get("key");

  if (providedKey && providedKey === env.ADMIN_KEY) {
    return { ok: true, adminProtection: "passed" };
  }

  return {
    ok: false,
    error: "ADMIN_KEY is configured. Add ?key=YOUR_ADMIN_KEY to use this route."
  };
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

function getStateSaveSkippedReason(
  options,
  kvBindingPresent,
  pageUsableForMonitoring,
  currentState
) {
  if (!options.saveState) return "saveState is false for this route.";
  if (!kvBindingPresent) return "KV binding BMS_STATE is missing.";
  if (pageUsableForMonitoring) return null;
  if (currentState.blockedPageDetected)
    return "Blocked page detected. Not saving bad baseline.";
  if (!currentState.pageFetchedSuccessfully)
    return "Page fetch was not successful.";
  if (currentState.httpStatus !== 200)
    return `HTTP status is ${currentState.httpStatus}, not 200.`;
  if (!currentState.targetMovieFound)
    return "Target movie was not found.";
  if (currentState.showtimeCount <= 0)
    return "No showtimes found.";
  return "Page is not usable for monitoring.";
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

function matchedTerms(lowerText, terms) {
  return [
    ...new Set(terms.map((x) => String(x || "").trim()).filter(Boolean))
  ].filter((term) => lowerText.includes(term.toLowerCase()));
}

function normalizeTime(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function uniqueShowtimes(items) {
  const map = new Map();

  for (const item of items) {
    if (!map.has(item.label)) {
      map.set(item.label, item);
    }
  }

  return [...map.values()];
}

function fingerprintShowtimes(items) {
  return JSON.stringify(items.map((x) => x.label).sort());
}

function dedupeWords(text) {
  return text.replace(/\s+/g, " ").trim();
}

function buildContexts(text, terms) {
  const lowerText = text.toLowerCase();
  const cleanTerms = [
    ...new Set(terms.map((x) => String(x || "").trim()).filter(Boolean))
  ];

  return cleanTerms
    .map((term) => {
      const index = lowerText.indexOf(term.toLowerCase());
      if (index === -1) return null;

      const start = Math.max(0, index - 120);
      const end = Math.min(text.length, index + term.length + 160);

      return {
        term,
        context: text.slice(start, end)
      };
    })
    .filter(Boolean)
    .slice(0, 30);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTelegramResult(result) {
  if (!result) return null;

  return {
    attempted: Boolean(result.attempted),
    ok: result.ok === undefined ? null : Boolean(result.ok),
    status: result.status || null,
    bodyPreview: result.bodyPreview || null
  };
}

async function handleTelegramWebhook(request, env) {
  if (!env.BMS_STATE) {
    return jsonResponse(
      {
        ok: false,
        error: "KV binding BMS_STATE is missing."
      },
      500
    );
  }

  if (!isValidTelegramWebhookSecret(request, env)) {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid Telegram webhook secret."
      },
      401
    );
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid Telegram update payload."
      },
      400
    );
  }

  const message = update?.message;
  const chatId = String(message?.chat?.id || "");
  const text = String(message?.text || "").trim();

  if (!message || !text) {
    return jsonResponse({ ok: true, ignored: "no_message_text" });
  }

  if (!isAuthorizedTelegramUser(message, env)) {
    return jsonResponse({ ok: true, ignored: "unauthorized_user" });
  }

  const replyText = await processTelegramCommand(message, env);
  await sendTelegramFromWorker(env, chatId, replyText);

  return jsonResponse({ ok: true });
}

async function processTelegramCommand(message, env) {
  const text = String(message?.text || "").trim();
  const chatId = String(message?.chat?.id || "");

  if (text.startsWith("/watch")) {
    const targetUrl = text.replace(/^\/watch\s+/i, "").trim();

    if (!targetUrl) {
      return [
        "Usage:",
        "/watch https://in.bookmyshow.com/..."
      ].join("\n");
    }

    if (!isValidBookMyShowUrl(targetUrl)) {
      return "Invalid URL. It must start with https://in.bookmyshow.com/";
    }

    const now = new Date().toISOString();
    const watchId = Date.now().toString(36);
    const watch = {
      active: true,
      watchId,
      targetUrl,
      mode: "all_movies",
      createdAt: now,
      updatedAt: now,
      createdByChatId: chatId
    };

    await env.BMS_STATE.put(ACTIVE_WATCH_KEY, JSON.stringify(watch));

    return [
      "[OK] Watch saved.",
      "Baseline will be created silently on the next Checkly run."
    ].join("\n");
  }

  if (text === "/status") {
    const watch = await readWorkerJson(env, ACTIVE_WATCH_KEY);

    if (!watch) {
      return "No active watch.";
    }

    const snapshot = await readWorkerJson(
      env,
      `${SNAPSHOT_KEY_PREFIX}${watch.watchId}`
    );

    const lines = [
      "Active watch:",
      `URL: ${watch.targetUrl}`,
      `Watch ID: ${watch.watchId}`,
      `Active: ${Boolean(watch.active)}`,
      `Last checked: ${snapshot?.checkedAt || "Not checked yet"}`,
      `Last show count: ${
        snapshot?.showCount === undefined ? "Unknown" : snapshot.showCount
      }`,
      "Use /history to see the last 5 checks."
    ];

    if (watch.active === false) {
      lines.push(
        "Monitoring is stopped. Send /watch <BookMyShow URL> to restart."
      );
    }

    return lines.join("\n");
  }

  if (text === "/history") {
    const watch = await readWorkerJson(env, ACTIVE_WATCH_KEY);

    if (!watch || !watch.watchId) {
      return "No watch history found.";
    }

    const history = await readWorkerJson(
      env,
      `${HISTORY_KEY_PREFIX}${watch.watchId}`
    );

    if (!Array.isArray(history) || !history.length) {
      return "No check history yet.";
    }

    return [
      "Last 5 checks:",
      ...history.slice(0, 5).map((entry, index) => {
        const parts = [
          `${index + 1}. ${formatHistoryTime(entry.checkedAt)} - ${entry.status}`,
          `${entry.showCount ?? 0} shows`
        ];

        if (entry.status === "readable") {
          const addedCount = entry.addedCount || 0;
          const removedCount = entry.removedCount || 0;
          const statusChangedCount = entry.statusChangedCount || 0;

          parts.push(
            addedCount === 0 &&
              removedCount === 0 &&
              statusChangedCount === 0
              ? "no changes"
              : `+${addedCount} / -${removedCount} / status ${statusChangedCount}`
          );
        }

        return parts.join(" - ");
      })
    ].join("\n");
  }

  if (text === "/stop") {
    const watch = await readWorkerJson(env, ACTIVE_WATCH_KEY);

    if (!watch || watch.active !== true) {
      return "No active watch to stop.";
    }

    const nextWatch = {
      ...watch,
      active: false,
      updatedAt: new Date().toISOString()
    };

    await env.BMS_STATE.put(ACTIVE_WATCH_KEY, JSON.stringify(nextWatch));
    return [
      "[OK] Watch stopped.",
      "Checkly will exit early until you send a new /watch link."
    ].join("\n");
  }

  if (text === "/notifyhere") {
    const notifyChats = await readNotificationChats(env);
    const currentChat = buildNotificationChat(message);
    const nextNotifyChats = [
      ...notifyChats.filter((item) => String(item?.chatId || "") !== currentChat.chatId),
      currentChat
    ];

    await env.BMS_STATE.put(NOTIFY_CHATS_KEY, JSON.stringify(nextNotifyChats));

    return [
      "[OK] Notifications enabled here.",
      "Alerts will be sent to this chat."
    ].join("\n");
  }

  if (text === "/unnotifyhere") {
    const nextNotifyChats = (await readNotificationChats(env)).filter(
      (item) => String(item?.chatId || "") !== chatId
    );

    await env.BMS_STATE.put(NOTIFY_CHATS_KEY, JSON.stringify(nextNotifyChats));

    return "[OK] Notifications removed from this chat.";
  }

  if (text === "/notifystatus") {
    const notifyChats = await readNotificationChats(env);

    if (!notifyChats.length) {
      return "No notification chats configured. Falling back to TELEGRAM_CHAT_ID.";
    }

    return [
      "Notification chats:",
      ...notifyChats.map(
        (item, index) =>
          `${index + 1}. ${item.title} (${item.type}) - ${item.chatId}`
      )
    ].join("\n");
  }

  if (text === "/notifytest") {
    await sendWorkerNotification(env, "BMS notification test working.");
    return "BMS notification test working.";
  }

  if (text === "/help") {
    return [
      "Commands:",
      "/watch <BookMyShow URL>",
      "/status",
      "/history",
      "/stop",
      "/notifyhere",
      "/unnotifyhere",
      "/notifystatus",
      "/notifytest",
      "/help"
    ].join("\n");
  }

  return [
    "Unknown command.",
    "Use /help to see available commands."
  ].join("\n");
}

async function readWorkerJson(env, key) {
  if (!env.BMS_STATE) return null;

  const raw = await env.BMS_STATE.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readNotificationChats(env) {
  const existing = await readWorkerJson(env, NOTIFY_CHATS_KEY);
  return Array.isArray(existing) ? existing : [];
}

function buildNotificationChat(message) {
  const chat = message?.chat || {};
  const firstName = String(chat.first_name || "").trim();
  const lastName = String(chat.last_name || "").trim();
  const title =
    String(chat.title || "").trim() ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    "Unknown chat";

  return {
    chatId: String(chat.id || "").trim(),
    type: String(chat.type || "private").trim(),
    title,
    addedAt: new Date().toISOString()
  };
}

function isAuthorizedTelegramUser(message, env) {
  const adminId = String(env.TELEGRAM_ADMIN_CHAT_ID || "");
  const fromId = String(message?.from?.id || "");
  const chatId = String(message?.chat?.id || "");

  return Boolean(adminId) && (fromId === adminId || chatId === adminId);
}

function isValidBookMyShowUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      url.protocol === "https:" &&
      url.hostname === "in.bookmyshow.com"
    );
  } catch {
    return false;
  }
}

function formatHistoryTime(iso) {
  if (!iso) return "Unknown time";

  try {
    return `${new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    })} IST`;
  } catch {
    return String(iso);
  }
}

function isValidTelegramWebhookSecret(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return true;

  const providedSecret = request.headers.get(
    "x-telegram-bot-api-secret-token"
  );

  return timingSafeEqual(
    String(providedSecret || ""),
    String(env.TELEGRAM_WEBHOOK_SECRET || "")
  );
}

function timingSafeEqual(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  const maxLength = Math.max(leftText.length, rightText.length);
  let diff = leftText.length ^ rightText.length;

  for (let i = 0; i < maxLength; i++) {
    diff |=
      (leftText.charCodeAt(i) || 0) ^ (rightText.charCodeAt(i) || 0);
  }

  return diff === 0;
}

async function sendTelegramFromWorker(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN secret.");
  }

  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    throw new Error(
      `Telegram webhook reply failed: HTTP ${response.status} ${await response.text()}`
    );
  }
}

async function getWorkerNotificationChatIds(env) {
  const notifyChats = await readNotificationChats(env);
  const ids = notifyChats
    .map((item) => String(item?.chatId || "").trim())
    .filter(Boolean);

  if (!ids.length && env.TELEGRAM_CHAT_ID) {
    ids.push(String(env.TELEGRAM_CHAT_ID).trim());
  }

  return [...new Set(ids)];
}

async function sendWorkerNotification(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN secret.");
  }

  const chatIds = await getWorkerNotificationChatIds(env);

  if (!chatIds.length) {
    throw new Error("No Telegram notification chat IDs configured.");
  }

  const failures = [];
  let successCount = 0;

  for (const targetChatId of chatIds) {
    const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: targetChatId,
        text,
        disable_web_page_preview: false
      })
    });

    if (response.ok) {
      successCount++;
      continue;
    }

    failures.push(
      `${targetChatId}: HTTP ${response.status} ${(
        await response.text()
      ).slice(0, 500)}`
    );
  }

  if (successCount === 0) {
    throw new Error(
      `Telegram failed for all notification chats: ${failures.join(" | ")}`
    );
  }

  if (failures.length) {
    console.log("Telegram partial failures:", failures);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
