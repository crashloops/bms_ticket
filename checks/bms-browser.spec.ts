import { test } from "@playwright/test";
import * as https from "https";

const CONFIG = {
  activeWatchKey: "bms:active-watch",
  snapshotKeyPrefix: "bms:snapshot:",
  historyKeyPrefix: "bms:history:",
  monitorSchemaVersion: 4,
  pageSettleMs: 12000
};

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_KV_NAMESPACE_ID"
];

type ActiveWatch = {
  active: boolean;
  watchId: string;
  targetUrl: string;
  mode: "all_movies";
  createdAt: string;
  updatedAt: string;
  createdByChatId: string;
};

type ShowtimeSnapshot = {
  id: string;
  movie: string;
  rating: string;
  row: string;
  time: string;
  screenText: string;
  status: "available" | "fast_filling" | "housefull_or_unavailable" | "unknown";
  rawColor: string;
  label: string;
};

type SnapshotState = {
  monitorSchemaVersion: number;
  watchId: string;
  targetUrl: string;
  pageTitle: string;
  checkedAt: string;
  showCount: number;
  items: ShowtimeSnapshot[];
};

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  const placeholderValues = REQUIRED_ENV.filter((key) => {
    const value = String(process.env[key] || "");
    return (
      value.includes("PASTE_") ||
      value.includes("YOUR_") ||
      value.includes("NEW_TOKEN_HERE")
    );
  });

  if (placeholderValues.length) {
    throw new Error(
      `Environment variables still contain placeholder values: ${placeholderValues.join(", ")}`
    );
  }

  if (String(process.env.CLOUDFLARE_API_TOKEN || "").startsWith("Bearer ")) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN should contain only the token value, not the word Bearer."
    );
  }

  if (String(process.env.CLOUDFLARE_API_TOKEN || "").length < 30) {
    throw new Error("CLOUDFLARE_API_TOKEN looks too short or invalid.");
  }

  if (String(process.env.CLOUDFLARE_ACCOUNT_ID || "").length < 20) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID looks too short or invalid.");
  }

  if (String(process.env.CLOUDFLARE_KV_NAMESPACE_ID || "").length < 20) {
    throw new Error("CLOUDFLARE_KV_NAMESPACE_ID looks too short or invalid.");
  }
}

test.setTimeout(90000);

test("Monitor BookMyShow listing changes", async ({ page }) => {
  validateEnv();

  const activeWatch = await readActiveWatch();
  if (!activeWatch) {
    console.log("No active watch. Exiting.");
    return;
  }

  if (activeWatch.active !== true) {
    console.log("Active watch is stopped. Exiting.");
    return;
  }

  const checkedAt = new Date().toISOString();
  const snapshotKey = snapshotKeyForWatch(activeWatch.watchId);
  const previousSnapshot = await readKvJson<SnapshotState>(snapshotKey);

  const response = await page.goto(activeWatch.targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });

  const httpStatus = response ? response.status() : null;

  await page.waitForTimeout(CONFIG.pageSettleMs);

  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    // Some pages never become fully network-idle. Continue.
  }

  const pageTitle = await page.title();
  const bodyText = await page.locator("body").innerText({ timeout: 15000 });
  const extractedShowtimes = await extractAllMovieShowtimes(page, bodyText);

  const pageUsableForMonitoring =
    httpStatus !== null &&
    httpStatus >= 200 &&
    httpStatus < 400 &&
    !isBlockedPage({
      httpStatus,
      pageTitle,
      bodyText
    }) &&
    extractedShowtimes.length > 0;

  if (!pageUsableForMonitoring) {
    const blockedDecision = {
      shouldSendTelegram: false,
      reason: "Page blocked or unusable."
    };

    await appendCheckHistory(activeWatch.watchId, {
      checkedAt,
      status: "blocked_or_unusable",
      httpStatus,
      pageTitle,
      targetUrl: activeWatch.targetUrl,
      showCount: extractedShowtimes.length,
      alertSent: false,
      reason: blockedDecision.reason,
      addedCount: 0,
      removedCount: 0,
      statusChangedCount: 0
    });

    console.log(
      JSON.stringify(
        {
          targetUrl: activeWatch.targetUrl,
          pageTitle,
          httpStatus,
          pageUsableForMonitoring,
          showtimeCount: extractedShowtimes.length,
          decisionReason: blockedDecision.reason
        },
        null,
        2
      )
    );
    return;
  }

  const currentSnapshot: SnapshotState = {
    monitorSchemaVersion: CONFIG.monitorSchemaVersion,
    watchId: activeWatch.watchId,
    targetUrl: activeWatch.targetUrl,
    pageTitle,
    checkedAt,
    showCount: extractedShowtimes.length,
    items: extractedShowtimes
  };

  const decision = decide(previousSnapshot, currentSnapshot);

  await appendCheckHistory(activeWatch.watchId, {
    checkedAt,
    status: "readable",
    httpStatus,
    pageTitle,
    targetUrl: activeWatch.targetUrl,
    showCount: currentSnapshot.showCount,
    alertSent: decision.shouldSendTelegram === true,
    reason: decision.reason,
    addedCount: decision.added?.length || 0,
    removedCount: decision.removed?.length || 0,
    statusChangedCount:
      decision.statusChanged?.length ||
      decision.changedStatus?.length ||
      decision.changedAvailability?.length ||
      0
  });

  console.log(
    JSON.stringify(
      {
        targetUrl: activeWatch.targetUrl,
        pageTitle,
        httpStatus,
        showtimeCount: currentSnapshot.showCount,
        pageUsableForMonitoring,
        decisionReason: decision.reason,
        extractedShowtimes: currentSnapshot.items
      },
      null,
      2
    )
  );

  if (decision.shouldSendTelegram) {
    await sendTelegram(buildTelegramMessage(currentSnapshot, decision));
  }

  await writeKvJson(snapshotKey, currentSnapshot);
});

async function readActiveWatch() {
  return readKvJson<ActiveWatch>(CONFIG.activeWatchKey);
}

function snapshotKeyForWatch(watchId: string) {
  return `${CONFIG.snapshotKeyPrefix}${watchId}`;
}

async function appendCheckHistory(watchId: string, entry: any) {
  const key = `${CONFIG.historyKeyPrefix}${watchId}`;
  let history: any[] = [];

  try {
    const existing = await readKvJson<any[]>(key);
    if (Array.isArray(existing)) {
      history = existing;
    }
  } catch (error) {
    history = [];
  }

  history.unshift(entry);
  history = history.slice(0, 5);

  await writeKvJson(key, history);
}

async function extractAllMovieShowtimes(page: any, bodyText: string) {
  const normalizedText = normalizeText(bodyText);
  const textItems = extractMovieShowtimeSnapshots(normalizedText);
  const domItems = await extractShowtimeStatusesFromDom(page, textItems);

  if (!domItems.length) {
    return textItems;
  }

  const textById = new Map(textItems.map((item) => [item.id, item]));
  return domItems.map((item) => {
    const fallback = textById.get(item.id);
    return fallback
      ? {
          ...fallback,
          status: item.status,
          rawColor: item.rawColor,
          label: buildSnapshotLabel({
            ...fallback,
            status: item.status,
            rawColor: item.rawColor
          })
        }
      : item;
  });
}

function extractMovieShowtimeSnapshots(text: string): ShowtimeSnapshot[] {
  const markerRegex = /([A-Za-z0-9][A-Za-z0-9\s:&'",.!+\-/]+?)\s*\((UA13\+|UA16\+|UA|A|U)\)/g;
  const markers: Array<{
    movie: string;
    rating: string;
    index: number;
    markerText: string;
  }> = [];
  let markerMatch;

  while ((markerMatch = markerRegex.exec(text)) !== null) {
    markers.push({
      movie: dedupeWords(markerMatch[1]),
      rating: markerMatch[2],
      index: markerMatch.index,
      markerText: markerMatch[0]
    });
  }

  if (!markers.length) return [];

  const snapshots: ShowtimeSnapshot[] = [];
  const timeRegex = /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/gi;

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const blockStart = marker.index + marker.markerText.length;
    const blockEnd = markers[i + 1] ? markers[i + 1].index : text.length;
    const block = text.slice(blockStart, blockEnd).trim();

    if (!block) continue;

    const timeMatches = Array.from(block.matchAll(timeRegex));
    if (!timeMatches.length) continue;

    const beforeFirstTime = block.slice(0, timeMatches[0].index || 0);
    const row = dedupeWords(beforeFirstTime).slice(0, 180);

    for (let j = 0; j < timeMatches.length; j++) {
      const currentMatch = timeMatches[j];
      const nextMatch = timeMatches[j + 1];
      const time = normalizeTime(currentMatch[0]);
      const currentIndex = currentMatch.index || 0;
      const currentEnd = currentIndex + currentMatch[0].length;
      const nextIndex = nextMatch ? nextMatch.index || block.length : block.length;
      const screenText = dedupeWords(block.slice(currentEnd, nextIndex)).slice(
        0,
        180
      );
      const id = buildShowtimeId(marker.movie, row, time, screenText);

      const item: ShowtimeSnapshot = {
        id,
        movie: marker.movie,
        rating: marker.rating,
        row,
        time,
        screenText,
        status: "unknown",
        rawColor: "",
        label: ""
      };

      item.label = buildSnapshotLabel(item);
      snapshots.push(item);
    }
  }

  const unique = new Map<string, ShowtimeSnapshot>();
  for (const item of snapshots) {
    if (!unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }

  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function extractShowtimeStatusesFromDom(
  page: any,
  items: ShowtimeSnapshot[]
): Promise<ShowtimeSnapshot[]> {
  if (!items.length) return [];

  return page.evaluate((expected) => {
    function clean(value: any) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function colorNameFromRgb(value: string) {
      const raw = String(value || "").toLowerCase();
      const rgbMatch = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

      if (!rgbMatch) return raw;

      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);

      if (g > 120 && r < 140) return "green_like";
      if (r > 180 && g > 120 && b < 120) return "yellow_or_orange_like";
      if (
        r > 120 &&
        g > 120 &&
        b > 120 &&
        Math.abs(r - g) < 35 &&
        Math.abs(g - b) < 35
      ) {
        return "grey_like";
      }

      return raw;
    }

    function classifyStatus(color: string, backgroundColor: string, borderColor: string) {
      const joined = [color, backgroundColor, borderColor].join(" ").toLowerCase();

      if (joined.includes("green_like")) return "available";
      if (joined.includes("yellow_or_orange_like")) return "fast_filling";
      if (joined.includes("grey_like")) return "housefull_or_unavailable";

      return "unknown";
    }

    const elements = Array.from(document.querySelectorAll("a, button, div, span"));
    const results: any[] = [];

    for (const expectedItem of expected) {
      const movie = clean(expectedItem.movie);
      const row = clean(expectedItem.row);
      const time = clean(expectedItem.time);
      const screenText = clean(expectedItem.screenText);

      const candidates = elements.filter((element: any) => {
        const text = clean(element.innerText || element.textContent || "");
        return text.includes(time);
      });

      let best: any = null;

      for (const element of candidates) {
        const combined = clean(
          [
            element.innerText,
            element.parentElement?.innerText,
            element.parentElement?.parentElement?.innerText,
            element.parentElement?.parentElement?.parentElement?.innerText
          ].join(" ")
        );

        let score = 0;
        if (movie && combined.toLowerCase().includes(movie.toLowerCase())) score += 4;
        if (row && combined.toLowerCase().includes(row.toLowerCase())) score += 3;
        if (
          screenText &&
          combined.toLowerCase().includes(screenText.toLowerCase())
        ) {
          score += 2;
        }
        if (combined.includes(time)) score += 1;

        if (!best || score > best.score) {
          best = { element, score };
        }
      }

      if (!best) continue;

      const target = best.element;
      const style = window.getComputedStyle(target);
      const color = colorNameFromRgb(style.color);
      const backgroundColor = colorNameFromRgb(style.backgroundColor);
      const borderColor = colorNameFromRgb(style.borderColor);
      const rawColor = clean(
        `color=${style.color}; background=${style.backgroundColor}; border=${style.borderColor}`
      );

      results.push({
        id: expectedItem.id,
        movie: expectedItem.movie,
        rating: expectedItem.rating,
        row: expectedItem.row,
        time: expectedItem.time,
        screenText: expectedItem.screenText,
        status: classifyStatus(color, backgroundColor, borderColor),
        rawColor,
        label: expectedItem.label
      });
    }

    const unique = new Map();
    for (const item of results) {
      if (!unique.has(item.id)) {
        unique.set(item.id, item);
      }
    }

    return Array.from(unique.values()).sort((a: any, b: any) =>
      a.id.localeCompare(b.id)
    );
  }, items);
}

function decide(previousSnapshot: SnapshotState | null, currentSnapshot: SnapshotState) {
  if (
    !previousSnapshot ||
    previousSnapshot.monitorSchemaVersion !== CONFIG.monitorSchemaVersion
  ) {
    return {
      shouldSendTelegram: false,
      reason: !previousSnapshot
        ? "No previous snapshot. Baseline created silently."
        : "Schema changed. Baseline refreshed silently."
    };
  }

  const previousById = new Map(
    previousSnapshot.items.map((item) => [item.id, item])
  );
  const currentById = new Map(currentSnapshot.items.map((item) => [item.id, item]));

  const added = currentSnapshot.items.filter((item) => !previousById.has(item.id));
  const removed = previousSnapshot.items.filter((item) => !currentById.has(item.id));
  const statusChanged = currentSnapshot.items
    .map((item) => {
      const previous = previousById.get(item.id);
      if (!previous || previous.status === item.status) return null;

      return {
        before: previous,
        after: item
      };
    })
    .filter(Boolean);

  if (!added.length && !removed.length && !statusChanged.length) {
    return {
      shouldSendTelegram: false,
      reason: "No changes."
    };
  }

  return {
    shouldSendTelegram: true,
    reason: "Added, removed, or status changes detected.",
    added,
    removed,
    statusChanged
  };
}

function buildTelegramMessage(
  currentSnapshot: SnapshotState,
  decision: {
    added?: ShowtimeSnapshot[];
    removed?: ShowtimeSnapshot[];
    statusChanged?: Array<{ before: ShowtimeSnapshot; after: ShowtimeSnapshot }>;
  }
) {
  const lines = [
    "BMS change detected",
    "",
    `Page: ${currentSnapshot.pageTitle || "Unknown page"}`,
    ""
  ];

  if (decision.added?.length) {
    lines.push("Added:");
    decision.added.slice(0, 20).forEach((item) => {
      lines.push(`+ ${compactSnapshot(item)} (${item.status})`);
    });
    lines.push("");
  }

  if (decision.removed?.length) {
    lines.push("Removed:");
    decision.removed.slice(0, 20).forEach((item) => {
      lines.push(`- ${compactSnapshot(item)}`);
    });
    lines.push("");
  }

  if (decision.statusChanged?.length) {
    lines.push("Status changed:");
    decision.statusChanged.slice(0, 20).forEach((item) => {
      lines.push(`* ${compactSnapshot(item.after)}`);
      lines.push(`  ${item.before.status} -> ${item.after.status}`);
    });
    lines.push("");
  }

  lines.push(currentSnapshot.targetUrl);
  return lines.join("\n");
}

function buildShowtimeId(
  movie: string,
  row: string,
  time: string,
  screenText: string
) {
  return `${movie} | ${row} | ${time} | ${screenText}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildSnapshotLabel(item: ShowtimeSnapshot) {
  return compactSnapshot(item);
}

function compactSnapshot(item: ShowtimeSnapshot) {
  return `${item.movie} - ${item.row || "Unknown row"} | ${item.time}${
    item.screenText ? ` | ${item.screenText}` : ""
  }`;
}

function isBlockedPage(input: {
  httpStatus: number | null;
  pageTitle: string;
  bodyText: string;
}) {
  const title = String(input.pageTitle || "").toLowerCase();
  const text = String(input.bodyText || "").toLowerCase();

  return (
    input.httpStatus === 403 ||
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

async function readKvJson<T>(key: string): Promise<T | null> {
  const response = await httpsTextRequest({
    method: "GET",
    url: kvUrl(key),
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
    }
  });

  if (response.statusCode === 404) return null;

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `KV read failed: HTTP ${response.statusCode} ${response.body}`
    );
  }

  return JSON.parse(response.body) as T;
}

async function writeKvJson(key: string, value: unknown) {
  const response = await httpsTextRequest({
    method: "PUT",
    url: kvUrl(key),
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(value)
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `KV write failed: HTTP ${response.statusCode} ${response.body}`
    );
  }
}

async function sendTelegram(text: string) {
  const response = await httpsTextRequest({
    method: "POST",
    url: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Telegram failed: HTTP ${response.statusCode} ${response.body}`
    );
  }
}

function httpsTextRequest(input: {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(input.url);
    const body = input.body || "";

    const request = https.request(
      {
        method: input.method,
        hostname: parsedUrl.hostname,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: {
          ...(input.headers || {}),
          ...(body
            ? {
                "content-length": Buffer.byteLength(body).toString()
              }
            : {})
        }
      },
      (response) => {
        let data = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: data
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(20000, () => {
      request.destroy(new Error("HTTPS request timed out"));
    });

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

function kvUrl(key: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(
    key
  )}`;
}

function normalizeText(value: string) {
  return decodeBasicHtmlEntities(
    decodeUnicodeEscapes(String(value || ""))
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeUnicodeEscapes(text: string) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return _;
    }
  });
}

function decodeBasicHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeTime(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function dedupeWords(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
