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

  // Recommended false: first run saves baseline but does not alert.
  alertOnFirstRun: false,

  sendErrorAlerts: false,

  kvStateKey: "bms-prasads-spiderman-20260730-state-v1",

  fetchTimeoutMs: 15000,

  userAgent:
    "PersonalBookMyShowAvailabilityMonitor/1.0; alert-only; no-booking; no-bypass",

  availabilityKeywords: [
    "available",
    "book",
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return textResponse(
        [
          "BookMyShow monitor is live.",
          "",
          "Routes:",
          "/test - run check without alert or saving",
          "/debug - show safe debug output",
          "/seed - save current page as baseline",
          "/last - show last saved state",
          "/telegram-test - send a test Telegram message"
        ].join("\n")
      );
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
        includeDebug: true,
        forceSave: false
      });

      return jsonResponse({
        ...result,
        seedMessage:
          "Baseline saved. Future cron runs alert only when timings change."
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
        availableRoutes: ["/test", "/debug", "/seed", "/last", "/telegram-test"]
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
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

  try {
    const previousState = kvBindingPresent ? await readLastState(env) : null;
    const fetchResult = await fetchTargetPage();
    const analysis = analyzePage(fetchResult.html || "");

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

        const safeToSave =
      options.forceSave ||
      (
        currentState.pageFetchedSuccessfully &&
        currentState.httpStatus === 200 &&
        currentState.targetMovieFound &&
        currentState.showtimeCount > 0
      );

    if (options.saveState && kvBindingPresent && safeToSave) {
      const stateToSave = {
        ...currentState,
        previousCheckedAt: previousState ? previousState.checkedAt : null,
        lastComparison: comparison,
        lastAlertAttempted: Boolean(options.sendAlerts && comparison.shouldAlert),
        lastAlertSent: alertSent,
        lastTelegramResult: sanitizeTelegramResult(telegramResult)
      };

      await env.BMS_STATE.put(CONFIG.kvStateKey, JSON.stringify(stateToSave));
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

      targetMovieFound: currentState.targetMovieFound,
      targetFormatFound: currentState.targetFormatFound,
      targetTimeFound: currentState.targetTimeFound,

      availabilityTextFound: currentState.availabilityTextFound,
      unavailableTextFound: currentState.unavailableTextFound,

      extractedShowtimes: currentState.extractedShowtimes,
      showtimeCount: currentState.showtimeCount,
      previousShowtimeCount: previousState ? previousState.showtimeCount || 0 : null,
      baselineExists: Boolean(previousState),

      showtimesChanged: comparison.showtimesChanged,
      addedShowtimes: comparison.addedShowtimes,
      removedShowtimes: comparison.removedShowtimes,
      alertWouldBeSent: comparison.shouldAlert,
      alertSent,
      stateSaved: Boolean(options.saveState && kvBindingPresent),
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
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

    if (CONFIG.targetFormat && !label.includes(CONFIG.targetFormat.toLowerCase())) {
      return false;
    }

    if (CONFIG.targetTime && item.time.toLowerCase() !== CONFIG.targetTime.toLowerCase()) {
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
      const nearTimeText = segment.slice(Math.max(0, match.index - 80), match.index + 140);
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
  const found = CONFIG.knownFormatKeywords.filter((format) => lower.includes(format));

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
      shouldAlert: CONFIG.alertOnFirstRun && currentState.showtimeCount > 0,
      reason: "No previous baseline found. Current state will be saved first."
    };
  }

  const previousLabels = new Set(
    (previousState.extractedShowtimes || []).map((item) => item.label)
  );
  const currentLabels = new Set(
    (currentState.extractedShowtimes || []).map((item) => item.label)
  );

  const addedShowtimes = [...currentLabels].filter((label) => !previousLabels.has(label));
  const removedShowtimes = [...previousLabels].filter((label) => !currentLabels.has(label));
  const showtimesChanged = addedShowtimes.length > 0 || removedShowtimes.length > 0;

  const basicPageHealthy =
    currentState.pageFetchedSuccessfully &&
    currentState.targetMovieFound &&
    currentState.showtimeCount > 0;

  return {
    baselineExists: true,
    showtimesChanged,
    addedShowtimes,
    removedShowtimes,
    shouldAlert: CONFIG.alertOnShowtimeChanges && showtimesChanged && basicPageHealthy,
    reason: showtimesChanged ? "Showtime list changed." : "No showtime change detected."
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
    comparison.addedShowtimes.slice(0, 20).forEach((item) => lines.push(`+ ${item}`));
    lines.push("");
  }

  if (comparison.removedShowtimes.length) {
    lines.push("❌ Removed timings:");
    comparison.removedShowtimes.slice(0, 20).forEach((item) => lines.push(`- ${item}`));
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
  return [...new Set(terms.map((x) => String(x || "").trim()).filter(Boolean))].filter(
    (term) => lowerText.includes(term.toLowerCase())
  );
}

function normalizeTime(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
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
  const cleanTerms = [...new Set(terms.map((x) => String(x || "").trim()).filter(Boolean))];

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
