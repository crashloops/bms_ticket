import { test } from "@playwright/test";
import * as https from "https";

const CONFIG = {
  activeWatchKey: "bms:active-watch",
  snapshotKeyPrefix: "bms:snapshot:",
  historyKeyPrefix: "bms:history:",
  notifyChatsKey: "bms:notify-chats",
  monitorSchemaVersion: 7,
  pageSettleMs: 12000
};

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_KV_NAMESPACE_ID"
];

type StatusKind =
  | "available"
  | "fast_filling"
  | "housefull_or_unavailable"
  | "unknown";

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
  status: StatusKind;
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

type StatusChange = {
  before: ShowtimeSnapshot;
  after: ShowtimeSnapshot;
};

type Decision = {
  shouldSendTelegram: boolean;
  reason: string;
  added?: ShowtimeSnapshot[];
  removed?: ShowtimeSnapshot[];
  statusChanged?: StatusChange[];
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

  const httpStatus = response ? response.status() : 0;

  await page.waitForTimeout(CONFIG.pageSettleMs);

  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    // Some pages never become fully network-idle. Continue.
  }

  const pageTitle = await page.title();
  const bodyText = await page.locator("body").innerText({ timeout: 15000 });
  const extractedShowtimes = await extractAllShowtimesFromPage(page, bodyText);

  const pageBlocked = isBlockedPage({
    httpStatus,
    pageTitle,
    bodyText
  });
  const pageUsableForMonitoring =
    httpStatus >= 200 &&
    httpStatus < 400 &&
    !pageBlocked &&
    extractedShowtimes.length > 0;

  if (!pageUsableForMonitoring) {
    const reason = pageBlocked
      ? "Page blocked or unusable."
      : "No readable showtimes found.";

    await appendCheckHistory(activeWatch.watchId, {
      checkedAt,
      status: "blocked_or_unusable",
      httpStatus,
      pageTitle,
      targetUrl: activeWatch.targetUrl,
      showCount: extractedShowtimes.length,
      alertSent: false,
      reason,
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
          showtimeCount: extractedShowtimes.length,
          reason
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
    statusChangedCount: decision.statusChanged?.length || 0
  });

  console.log(
    JSON.stringify(
      {
        targetUrl: activeWatch.targetUrl,
        pageTitle,
        httpStatus,
        showtimeCount: currentSnapshot.showCount,
        decisionReason: decision.reason,
        addedCount: decision.added?.length || 0,
        removedCount: decision.removed?.length || 0,
        statusChangedCount: decision.statusChanged?.length || 0
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
  } catch {
    history = [];
  }

  history.unshift(entry);
  history = history.slice(0, 5);

  await writeKvJson(key, history);
}

async function extractAllShowtimesFromPage(page: any, bodyText: string) {
  const textItems = extractAllShowtimesFromText(bodyText);
  return extractShowtimeStatusesFromDom(page, textItems);
}

function stopFooterNoise(text: string) {
  return String(text || "")
    .replace(/HomeCinemas[\s\S]*$/i, "")
    .replace(/List your Show[\s\S]*$/i, "")
    .replace(/Got a show[\s\S]*$/i, "")
    .replace(/24\/7 CUSTOMER CARE[\s\S]*$/i, "")
    .replace(/MOVIES NOW SHOWING[\s\S]*$/i, "")
    .trim();
}

function extractAllShowtimesFromText(bodyText: string) {
  const text = stopFooterNoise(String(bodyText || "").replace(/\r/g, "\n"));

  const movieMarkerRegex =
    /([A-Z][A-Za-z0-9:'\u2019.,&\- ]{2,100}?)\s*\((U|A|UA|UA\d+\+?|U\/A|U\/A\s*\d+\+?)\)/g;

  const markers: Array<{
    index: number;
    endIndex: number;
    fullText: string;
    movie: string;
    rating: string;
  }> = [];

  let match: RegExpExecArray | null;

  while ((match = movieMarkerRegex.exec(text)) !== null) {
    const movie = match[1].trim();

    if (
      /customer care|newsletter|movies now showing|homecinemas|list your show/i.test(
        movie
      )
    ) {
      continue;
    }

    markers.push({
      index: match.index,
      endIndex: match.index + match[0].length,
      fullText: match[0],
      movie,
      rating: match[2].trim()
    });
  }

  const rawResults: Array<
    Omit<ShowtimeSnapshot, "id"> & {
      movie: string;
      rating: string;
      row: string;
      time: string;
      screenText: string;
    }
  > = [];

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const nextMarker = markers[i + 1];
    const blockEnd = nextMarker ? nextMarker.index : text.length;
    let block = text.slice(marker.index, blockEnd);
    block = stopFooterNoise(block);

    const blockBody = block
      .replace(marker.fullText, "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const firstTimeMatch = blockBody.match(
      /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/i
    );

    if (!firstTimeMatch || firstTimeMatch.index === undefined) {
      continue;
    }

    const row = blockBody
      .slice(0, firstTimeMatch.index)
      .replace(/\s+/g, " ")
      .trim();

    if (!row || row.length > 80) {
      continue;
    }

    const timeRegex = /\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/gi;
    const matches = [...blockBody.matchAll(timeRegex)];

    for (let j = 0; j < matches.length; j++) {
      const timeMatch = matches[j];
      if (timeMatch.index === undefined) continue;

      const time = normalizeTime(timeMatch[0]);
      const currentEnd = timeMatch.index + timeMatch[0].length;
      const nextTimeStart =
        j + 1 < matches.length && matches[j + 1].index !== undefined
          ? matches[j + 1].index
          : blockBody.length;

      const screenText = cleanScreenText(
        blockBody.slice(currentEnd, nextTimeStart)
      );

      rawResults.push({
        movie: marker.movie,
        rating: marker.rating,
        row,
        time,
        screenText,
        status: "unknown",
        rawColor: "",
        label: compactShowtime({
          movie: marker.movie,
          row,
          time,
          screenText
        })
      });
    }
  }

  const duplicateCounters = new Map<string, number>();
  const finalResults: ShowtimeSnapshot[] = [];

  for (const item of rawResults) {
    const cleanScreen = cleanScreenText(item.screenText);
    const duplicateBase = `${normalizeKeyPart(item.movie)} | ${normalizeKeyPart(
      item.row
    )} | ${normalizeKeyPart(item.time)}`;

    const needsDuplicateSlot = !normalizeScreenKey(cleanScreen);
    let duplicateSlot = 0;

    if (needsDuplicateSlot) {
      const nextCount = (duplicateCounters.get(duplicateBase) || 0) + 1;
      duplicateCounters.set(duplicateBase, nextCount);
      duplicateSlot = nextCount;
    }

    const id = buildShowtimeId(
      item.movie,
      item.row,
      item.time,
      cleanScreen,
      duplicateSlot
    );

    finalResults.push({
      ...item,
      id,
      screenText: cleanScreen,
      label: compactShowtime({
        movie: item.movie,
        row: item.row,
        time: item.time,
        screenText: cleanScreen
      })
    });
  }

  const unique = new Map<string, ShowtimeSnapshot>();

  for (const item of finalResults) {
    if (!unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }

  return [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

async function extractShowtimeStatusesFromDom(
  page: any,
  items: ShowtimeSnapshot[]
): Promise<ShowtimeSnapshot[]> {
  if (!items.length) return [];

  const statuses = await page.evaluate((expected: ShowtimeSnapshot[]) => {
    function clean(value: unknown) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function colorBucket(value: string) {
      const raw = String(value || "").toLowerCase();
      const match = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

      if (!match) return raw;

      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);

      if (green >= 120 && red <= 140) return "green_like";
      if (red >= 180 && green >= 120 && blue <= 140) {
        return "yellow_or_orange_like";
      }
      if (
        red >= 120 &&
        green >= 120 &&
        blue >= 120 &&
        Math.abs(red - green) <= 35 &&
        Math.abs(green - blue) <= 35
      ) {
        return "grey_like";
      }

      return raw;
    }

    function classifyStatus(rawColor: string): StatusKind {
      const lower = rawColor.toLowerCase();

      if (lower.includes("green_like")) return "available";
      if (lower.includes("yellow_or_orange_like")) return "fast_filling";
      if (lower.includes("grey_like")) return "housefull_or_unavailable";

      return "unknown";
    }

    const nodes = Array.from(document.querySelectorAll("a, button, div, span"));
    const result: Array<{ id: string; status: StatusKind; rawColor: string }> = [];
    const usedIndexes = new Set<number>();

    for (const item of expected) {
      const movie = clean(item.movie).toLowerCase();
      const row = clean(item.row).toLowerCase();
      const time = clean(item.time);
      const screenText = clean(item.screenText).toLowerCase();

      const candidates = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => {
        const text = clean(
          (node as HTMLElement).innerText || node.textContent || ""
        );
        return text === time || text.includes(` ${time} `) || text.includes(time);
      });

      let bestMatch:
        | { element: Element; score: number; index: number }
        | null = null;

      for (const candidate of candidates) {
        const element = candidate.node;
        const nearby = clean(
          [
            (element as HTMLElement).innerText,
            (element.parentElement as HTMLElement | null)?.innerText,
            (element.parentElement?.parentElement as HTMLElement | null)
              ?.innerText,
            (element.parentElement?.parentElement?.parentElement as
              | HTMLElement
              | null)?.innerText
          ].join(" ")
        ).toLowerCase();

        let score = 0;

        if (movie && nearby.includes(movie)) score += 4;
        if (row && nearby.includes(row)) score += 3;
        if (nearby.includes(time.toLowerCase())) score += 2;
        if (screenText && nearby.includes(screenText)) score += 5;
        if (screenText && !nearby.includes(screenText)) score -= 2;
        if (usedIndexes.has(candidate.index)) score -= 4;

        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { element, score, index: candidate.index };
        }
      }

      if (!bestMatch) {
        continue;
      }

      usedIndexes.add(bestMatch.index);

      const style = window.getComputedStyle(bestMatch.element as Element);
      const rawColor = clean(
        [
          `color=${style.color}`,
          `background=${style.backgroundColor}`,
          `border=${style.borderColor}`,
          `bucket=${colorBucket(style.color)}`,
          `bucket=${colorBucket(style.backgroundColor)}`,
          `bucket=${colorBucket(style.borderColor)}`
        ].join("; ")
      );

      result.push({
        id: item.id,
        status: classifyStatus(rawColor),
        rawColor
      });
    }

    const unique = new Map<string, { id: string; status: StatusKind; rawColor: string }>();

    for (const item of result) {
      if (!unique.has(item.id)) {
        unique.set(item.id, item);
      }
    }

    return Array.from(unique.values());
  }, items);

  const byId = new Map(statuses.map((item) => [item.id, item]));

  return items.map((item) => {
    const domStatus = byId.get(item.id);

    if (!domStatus) {
      return {
        ...item,
        label: compactShowtime(item)
      };
    }

    return {
      ...item,
      status: domStatus.status,
      rawColor: domStatus.rawColor,
      label: compactShowtime(item)
    };
  });
}

function decide(
  previousSnapshot: SnapshotState | null,
  currentSnapshot: SnapshotState
): Decision {
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
    previousSnapshot.items.map((item) => [item.id, item] as const)
  );
  const currentById = new Map(
    currentSnapshot.items.map((item) => [item.id, item] as const)
  );

  const added = currentSnapshot.items.filter((item) => !previousById.has(item.id));
  const removed = previousSnapshot.items.filter((item) => !currentById.has(item.id));
  const statusChanged: StatusChange[] = [];

  for (const item of currentSnapshot.items) {
    const previousItem = previousById.get(item.id);

    if (!previousItem || previousItem.status === item.status) {
      continue;
    }

    statusChanged.push({
      before: previousItem,
      after: item
    });
  }

  if (!added.length && !removed.length && !statusChanged.length) {
    return {
      shouldSendTelegram: false,
      reason: "No timing or status changes.",
      added,
      removed,
      statusChanged
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

function buildTelegramMessage(currentSnapshot: SnapshotState, decision: Decision) {
  const lines = ["BMS change detected", "", `Page: ${currentSnapshot.pageTitle}`, ""];

  if (decision.added?.length) {
    lines.push("Added:");
    for (const item of decision.added.slice(0, 20)) {
      lines.push(`+ ${compactShowtime(item)} (${item.status})`);
    }
    lines.push("");
  }

  if (decision.removed?.length) {
    lines.push("Removed:");
    for (const item of decision.removed.slice(0, 20)) {
      lines.push(`- ${compactShowtime(item)}`);
    }
    lines.push("");
  }

  if (decision.statusChanged?.length) {
    lines.push("Status changed:");
    for (const item of decision.statusChanged.slice(0, 20)) {
      lines.push(`* ${compactShowtime(item.after)}`);
      lines.push(`  ${item.before.status} -> ${item.after.status}`);
    }
    lines.push("");
  }

  lines.push(currentSnapshot.targetUrl);
  return lines.join("\n");
}

function buildShowtimeId(
  movie: string,
  row: string,
  time: string,
  screenText: string,
  duplicateSlot = 0
) {
  const movieKey = normalizeKeyPart(movie);
  const rowKey = normalizeKeyPart(row);
  const timeKey = normalizeKeyPart(time);
  const screenKey = normalizeScreenKey(screenText);

  const finalScreenKey = screenKey || `unknown-screen-${duplicateSlot || 1}`;

  return `${movieKey} | ${rowKey} | ${timeKey} | ${finalScreenKey}`;
}

function compactShowtime(item: any) {
  const row = String(item.row || "").replace(/\s+/g, " ").trim();
  const time = String(item.time || "").replace(/\s+/g, " ").trim();
  const screenText = String(item.screenText || "").replace(/\s+/g, " ").trim();

  return `${item.movie || "Unknown movie"} \u2014 ${row} | ${time}${
    screenText ? ` | ${screenText}` : ""
  }`;
}

function normalizeKeyPart(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeScreenKey(value: string) {
  const cleaned = cleanScreenText(value);

  if (!cleaned) return "";

  return cleaned
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanScreenText(value: string) {
  let text = String(value || "")
    .replace(/\bAVAILABLE\b/gi, "")
    .replace(/\bFAST FILLING\b/gi, "")
    .replace(/\bLANG SUBTITLES\b/gi, "")
    .replace(/\bSUBTITLES\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  text = stopFooterNoise(text);

  if (
    /HomeCinemas|List your Show|Got a show|CUSTOMER CARE|MOVIES NOW SHOWING/i.test(
      text
    )
  ) {
    return "";
  }

  if (/\b(?:0?[1-9]|1[0-2]):[0-5][0-9]\s*(?:AM|PM)\b/i.test(text)) {
    return "";
  }

  if (/\((U|A|UA|UA\d+\+?|U\/A|U\/A\s*\d+\+?)\)/i.test(text)) {
    return "";
  }

  return text.slice(0, 80).trim();
}

function isBlockedPage(input: {
  httpStatus: number;
  pageTitle: string;
  bodyText: string;
}) {
  const title = String(input.pageTitle || "").toLowerCase();
  const lowerText = String(input.bodyText || "").toLowerCase();

  return (
    input.httpStatus === 403 ||
    title.includes("attention required") ||
    title.includes("just a moment") ||
    lowerText.includes("sorry, you have been blocked") ||
    lowerText.includes("you are unable to access bookmyshow.com") ||
    lowerText.includes("please enable cookies") ||
    lowerText.includes("cloudflare ray id") ||
    lowerText.includes("verify you are human") ||
    lowerText.includes("checking your browser") ||
    lowerText.includes("captcha")
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
  const chatIds = await getNotificationChatIds();

  if (!chatIds.length) {
    throw new Error("No Telegram notification chat IDs configured.");
  }

  const failures: string[] = [];
  let successCount = 0;

  for (const chatId of chatIds) {
    const response = await httpsTextRequest({
      method: "POST",
      url: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false
      })
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      successCount++;
    } else {
      failures.push(
        `${maskChatId(chatId)}: HTTP ${response.statusCode} ${response.body}`
      );
    }
  }

  console.log("Telegram send result:", {
    targetCount: chatIds.length,
    successCount,
    failureCount: failures.length
  });

  if (failures.length) {
    console.log("Telegram send failures:", failures);
  }

  if (successCount === 0) {
    throw new Error(
      `Telegram failed for all notification chats: ${failures.join(" | ")}`
    );
  }
}

async function getNotificationChatIds() {
  let raw: any = null;

  try {
    raw = await readKvJson(CONFIG.notifyChatsKey);
  } catch (error) {
    console.log("Could not read notification chats from KV. Falling back if possible.", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  let notifyChats: any[] = [];

  if (Array.isArray(raw)) {
    notifyChats = raw;
  } else if (raw && Array.isArray(raw.chats)) {
    notifyChats = raw.chats;
  } else if (raw && Array.isArray(raw.notifyChats)) {
    notifyChats = raw.notifyChats;
  } else if (raw && raw.chatId) {
    notifyChats = [raw];
  }

  const ids = notifyChats
    .map((x) => String(x.chatId || x.id || "").trim())
    .filter(Boolean);

  if (!ids.length && process.env.TELEGRAM_CHAT_ID) {
    ids.push(String(process.env.TELEGRAM_CHAT_ID).trim());
  }

  const uniqueIds = [...new Set(ids)];

  console.log("Telegram notification target count:", uniqueIds.length);
  console.log(
    "Telegram notification target types:",
    notifyChats.map((x) => ({
      type: x.type || "unknown",
      title: x.title || x.firstName || "unknown",
      hasChatId: Boolean(x.chatId || x.id)
    }))
  );

  return uniqueIds;
}

function maskChatId(chatId: string) {
  const value = String(chatId || "");
  if (value.length <= 4) return "****";
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
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
  return normalizeText(String(value || "")).toUpperCase();
}

function dedupeWords(text: string) {
  return normalizeText(String(text || ""));
}
