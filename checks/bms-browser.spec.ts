import { test } from "@playwright/test";
import * as https from "https";

const CONFIG = {
  watchesKey: "bms:watches",
  activeWatchKey: "bms:active-watch",
  snapshotKeyPrefix: "bms:snapshot:",
  historyKeyPrefix: "bms:history:",
  notifyChatsKey: "bms:notify-chats",
  monitorSchemaVersion: 11,
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

type WatchConfig = {
  active: boolean;
  watchId: string;
  alias: string;
  targetUrl: string;
  mode: "all_movies";
  createdAt: string;
  updatedAt: string;
  createdByChatId: string;
};

type ShowtimeSnapshot = {
  id: string;
  baseKey?: string;
  occurrence?: number;
  originalPageIndex?: number;
  duplicateChangeCount?: number;
  colorBucket?: string;
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
  alias: string;
  watchId: string;
  targetUrl: string;
  pageTitle: string;
  checkedAt: string;
  showCount: number;
  items: ShowtimeSnapshot[];
};

type StatusChange = {
  previous: ShowtimeSnapshot;
  current: ShowtimeSnapshot;
  oldStatus: string;
  newStatus: string;
};

type Decision = {
  shouldSendTelegram: boolean;
  reason: string;
  added?: ShowtimeSnapshot[];
  removed?: ShowtimeSnapshot[];
  statusChanged?: StatusChange[];
  colorChanged?: Array<{
    previous: ShowtimeSnapshot;
    current: ShowtimeSnapshot;
    oldColorBucket: string;
    newColorBucket: string;
  }>;
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

  const activeWatches = await readActiveWatches();
  if (!activeWatches.length) {
    console.log("No active watches. Exiting.");
    return;
  }

  for (const watch of activeWatches) {
    await runSingleWatch(page, watch);
  }
});

async function readWatches() {
  const raw = await readKvJson<any>(CONFIG.watchesKey);
  let watches: any[] = [];

  if (Array.isArray(raw)) {
    watches = raw;
  } else if (raw && Array.isArray(raw.watches)) {
    watches = raw.watches;
  }

  if (!watches.length) {
    const legacyWatch = await readKvJson<any>(CONFIG.activeWatchKey);
    if (legacyWatch?.targetUrl) {
      watches = [legacyWatch];
    }
  }

  return watches
    .map((watch, index) => normalizeWatch(watch, index))
    .filter(Boolean) as WatchConfig[];
}

async function readActiveWatches() {
  const watches = await readWatches();
  return watches.filter((watch) => watch.active === true);
}

function normalizeWatch(watch: any, index: number): WatchConfig | null {
  const targetUrl = String(watch?.targetUrl || "").trim();
  if (!targetUrl) return null;

  return {
    active: watch?.active !== false,
    watchId: String(watch?.watchId || `legacy-watch-${index + 1}`),
    alias: normalizeWatchAlias(watch?.alias, index),
    targetUrl,
    mode: "all_movies",
    createdAt: String(watch?.createdAt || new Date().toISOString()),
    updatedAt: String(watch?.updatedAt || new Date().toISOString()),
    createdByChatId: String(watch?.createdByChatId || "")
  };
}

function normalizeWatchAlias(value: unknown, index: number) {
  const alias = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

  return alias || `watch${index + 1}`;
}

function snapshotKeyForWatch(watchId: string) {
  return `${CONFIG.snapshotKeyPrefix}${watchId}`;
}

function hasMatchingSchemaVersion(
  previousSnapshot: SnapshotState | null,
  currentSnapshot: SnapshotState
) {
  return (
    Number(previousSnapshot?.monitorSchemaVersion || 0) ===
    Number(currentSnapshot.monitorSchemaVersion || 0)
  );
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

async function runSingleWatch(page: any, watch: WatchConfig) {
  const checkedAt = new Date().toISOString();
  const snapshotKey = snapshotKeyForWatch(watch.watchId);
  const previousSnapshot = await readKvJson<SnapshotState>(snapshotKey);

  let httpStatus = 0;
  let pageTitle = "";
  let bodyText = "";
  let extractedShowtimes: ShowtimeSnapshot[] = [];

  try {
    const response = await page.goto(watch.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    httpStatus = response ? response.status() : 0;

    await page.waitForTimeout(CONFIG.pageSettleMs);

    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Some pages never become fully network-idle. Continue.
    }

    pageTitle = await page.title();
    bodyText = await page.locator("body").innerText({ timeout: 15000 });
    extractedShowtimes = await extractAllShowtimesFromPage(page, bodyText);
  } catch (error) {
    const reason = `Watch run failed: ${
      error instanceof Error ? error.message : String(error)
    }`;

    await appendCheckHistory(watch.watchId, {
      checkedAt,
      alias: watch.alias,
      watchId: watch.watchId,
      status: "blocked_or_unusable",
      httpStatus,
      pageTitle,
      targetUrl: watch.targetUrl,
      showCount: 0,
      alertSent: false,
      reason,
      addedCount: 0,
      removedCount: 0,
      statusChangedCount: 0,
      colorChangedCount: 0
    });

    console.log(
      JSON.stringify(
        {
          alias: watch.alias,
          targetUrl: watch.targetUrl,
          reason
        },
        null,
        2
      )
    );
    return;
  }

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

    await appendCheckHistory(watch.watchId, {
      checkedAt,
      alias: watch.alias,
      watchId: watch.watchId,
      status: "blocked_or_unusable",
      httpStatus,
      pageTitle,
      targetUrl: watch.targetUrl,
      showCount: extractedShowtimes.length,
      alertSent: false,
      reason,
      addedCount: 0,
      removedCount: 0,
      statusChangedCount: 0,
      colorChangedCount: 0
    });

    console.log(
      JSON.stringify(
        {
          alias: watch.alias,
          targetUrl: watch.targetUrl,
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
    alias: watch.alias,
    watchId: watch.watchId,
    targetUrl: watch.targetUrl,
    pageTitle,
    checkedAt,
    showCount: extractedShowtimes.length,
    items: extractedShowtimes
  };

  if (
    !previousSnapshot ||
    !hasMatchingSchemaVersion(previousSnapshot, currentSnapshot)
  ) {
    const reason = !previousSnapshot
      ? "No previous snapshot. Baseline created silently."
      : "Schema changed. Baseline refreshed silently.";

    await writeKvJson(snapshotKey, currentSnapshot);

    await appendCheckHistory(watch.watchId, {
      checkedAt,
      alias: watch.alias,
      watchId: watch.watchId,
      status: "readable",
      httpStatus,
      pageTitle,
      targetUrl: watch.targetUrl,
      showCount: currentSnapshot.showCount,
      alertSent: false,
      reason,
      addedCount: 0,
      removedCount: 0,
      statusChangedCount: 0,
      colorChangedCount: 0
    });

    return;
  }

  console.log("Color comparison debug:", {
    alias: watch.alias,
    previousSchema: previousSnapshot?.monitorSchemaVersion,
    currentSchema: currentSnapshot.monitorSchemaVersion,
    colorComparisons: (currentSnapshot.items || []).map((current) => {
      const previous = findPreviousComparableItem(previousSnapshot.items || [], current);
      return {
        label: current.label,
        previousColorBucket: previous?.colorBucket,
        currentColorBucket: current.colorBucket,
        wouldAlert:
          previous?.colorBucket === "grey_like" &&
          ["green_like", "yellow_like", "orange_like", "red_like", "non_grey"].includes(
            String(current.colorBucket || "")
          )
      };
    })
  });

  const diff = compareSnapshots(previousSnapshot, currentSnapshot);

  console.log("Diff summary:", {
    alias: watch.alias,
    addedCount: diff.addedCount,
    removedCount: diff.removedCount,
    statusChangedCount: diff.statusChangedCount,
    colorChangedCount: diff.colorChangedCount,
    changed: diff.changed
  });

  if (diff.changed) {
    await sendTelegram(buildTelegramMessage(currentSnapshot, diff));
  }

  await writeKvJson(snapshotKey, currentSnapshot);

  await appendCheckHistory(watch.watchId, {
    checkedAt,
    alias: watch.alias,
    watchId: watch.watchId,
    status: "readable",
    httpStatus,
    pageTitle,
    targetUrl: watch.targetUrl,
    showCount: currentSnapshot.showCount,
    alertSent: diff.changed,
    reason: diff.changed
      ? "Added, removed, status, or color changes detected."
      : "No timing, status, or color changes.",
    addedCount: diff.addedCount || 0,
    removedCount: diff.removedCount || 0,
    statusChangedCount: diff.statusChangedCount || 0,
    colorChangedCount: diff.colorChangedCount || 0
  });
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

  const rawResults: ShowtimeSnapshot[] = [];

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
        id: "",
        movie: marker.movie,
        rating: marker.rating,
        row,
        time,
        screenText,
        status: "unknown",
        rawColor: "",
        originalPageIndex: rawResults.length,
        label: compactShowtime({
          movie: marker.movie,
          row,
          time,
          screenText
        })
      });
    }
  }

  const sortedResults = rawResults
    .map((item) => {
      const cleanScreen = cleanScreenText(item.screenText);
      return {
        ...item,
        screenText: cleanScreen,
        label: compactShowtime({
          movie: item.movie,
          row: item.row,
          time: item.time,
          screenText: cleanScreen
        })
      };
    })
    .sort(compareShowItems);

  return assignOccurrenceIds(sortedResults);
}

async function extractShowtimeStatusesFromDom(
  page: any,
  items: ShowtimeSnapshot[]
): Promise<ShowtimeSnapshot[]> {
  if (!items.length) return [];

  const domChips = await page.evaluate(() => {
    function normalizeText(value: unknown) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisibleElement(el: Element) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0
      );
    }

    function isTimeOnlyText(text: string) {
      return /^(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM)$/i.test(
        normalizeText(text)
      );
    }

    function parseRgbNumbers(value: string) {
      const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;

      const parts = match[1]
        .split(",")
        .map((x) => Number(String(x).trim()))
        .filter((x) => Number.isFinite(x));

      if (parts.length < 3) return null;

      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length >= 4 ? parts[3] : 1
      };
    }

    function classifyRgbColor(value: string) {
      const rgb = parseRgbNumbers(value);
      if (!rgb) return "unknown";

      const { r, g, b, a } = rgb;
      if (a === 0) return "transparent";

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const spread = max - min;

      if (g >= 110 && g > r + 25 && g > b + 25) return "green_like";
      if (r >= 150 && r > g + 35 && r > b + 35) return "red_like";
      if (r >= 180 && g >= 80 && g <= 190 && b <= 100) return "orange_like";
      if (r >= 170 && g >= 145 && b <= 110) return "yellow_like";

      if (spread <= 20 && max <= 180) return "grey_like";

      return "non_grey";
    }

    function getExactChipColor(el: Element) {
      const style = window.getComputedStyle(el);

      const color = style.color;
      const borderTop = style.borderTopColor;
      const borderRight = style.borderRightColor;
      const borderBottom = style.borderBottomColor;
      const borderLeft = style.borderLeftColor;
      const background = style.backgroundColor;

      const colorBucket = classifyRgbColor(color);

      let finalBucket = colorBucket;

      if (finalBucket === "transparent" || finalBucket === "unknown") {
        const borderBuckets = [
          classifyRgbColor(borderTop),
          classifyRgbColor(borderRight),
          classifyRgbColor(borderBottom),
          classifyRgbColor(borderLeft)
        ].filter((x) => x !== "transparent" && x !== "unknown");

        finalBucket = borderBuckets[0] || "unknown";
      }

      return {
        colorBucket: finalBucket,
        rawColor: `chip.color=${color}; chip.background=${background}; chip.borderTop=${borderTop}; chip.borderRight=${borderRight}; chip.borderBottom=${borderBottom}; chip.borderLeft=${borderLeft}`
      };
    }

    function extractDomTimeChips() {
      const all = Array.from(document.querySelectorAll("a,button,span,div"));
      const chips: Array<{
        time: string;
        colorBucket: string;
        rawColor: string;
        top: number;
        left: number;
        width: number;
        height: number;
      }> = [];

      for (const el of all) {
        const text = normalizeText(el.textContent || "");

        if (!isTimeOnlyText(text)) continue;
        if (!isVisibleElement(el)) continue;

        const rect = el.getBoundingClientRect();

        if (rect.width > 220 || rect.height > 90) continue;

        const colorInfo = getExactChipColor(el);

        chips.push({
          time: text.toUpperCase(),
          colorBucket: colorInfo.colorBucket,
          rawColor: colorInfo.rawColor,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      }

      chips.sort((a, b) => {
        if (a.top !== b.top) return a.top - b.top;
        return a.left - b.left;
      });

      return chips;
    }

    return extractDomTimeChips();
  });

  function statusFromColorBucket(bucket: string): StatusKind {
    const value = String(bucket || "").toLowerCase();

    if (value === "grey_like") return "housefull_or_unavailable";
    if (value === "green_like") return "available";
    if (["yellow_like", "orange_like", "red_like"].includes(value)) {
      return "fast_filling";
    }

    return "unknown";
  }

  const chipsByTime = new Map<string, typeof domChips>();

  for (const chip of domChips) {
    const key = String(chip.time || "").toUpperCase();
    if (!chipsByTime.has(key)) chipsByTime.set(key, []);
    chipsByTime.get(key)!.push(chip);
  }

  const useCountByTime = new Map<string, number>();
  const mergedById = new Map<string, ShowtimeSnapshot>();
  const sortedItems = [...items].sort(
    (a, b) => Number(a.originalPageIndex || 0) - Number(b.originalPageIndex || 0)
  );

  for (const item of sortedItems) {
    const key = String(item.time || "").toUpperCase();
    const used = useCountByTime.get(key) || 0;
    const chip = (chipsByTime.get(key) || [])[used];

    useCountByTime.set(key, used + 1);

    const colorBucket = chip?.colorBucket || "unknown";
    const rawColor = chip?.rawColor || "chip_not_found";

    mergedById.set(item.id, {
      ...item,
      colorBucket,
      rawColor,
      status: statusFromColorBucket(colorBucket),
      label: compactShowtime(item)
    });
  }

  const mergedItems = items.map((item) => {
    return (
      mergedById.get(item.id) || {
        ...item,
        colorBucket: "unknown",
        rawColor: "chip_not_found",
        status: "unknown",
        label: compactShowtime(item)
      }
    );
  });

  console.log(
    "Extracted show colors:",
    mergedItems.map((x) => ({
      label: x.label,
      colorBucket: x.colorBucket,
      rawColor: x.rawColor
    }))
  );

  return mergedItems;
}

function decide(
  previousSnapshot: SnapshotState | null,
  currentSnapshot: SnapshotState
): Decision {
  if (!previousSnapshot || !hasMatchingSchemaVersion(previousSnapshot, currentSnapshot)) {
    return {
      shouldSendTelegram: false,
      reason: !previousSnapshot
        ? "No previous snapshot. Baseline created silently."
        : "Schema changed. Baseline refreshed silently."
    };
  }

  const compared = compareSnapshots(previousSnapshot, currentSnapshot);
  const { added, removed, statusChanged, colorChanged } = compared;

  if (!added.length && !removed.length && !statusChanged.length && !colorChanged.length) {
    return {
      shouldSendTelegram: false,
      reason: "No timing, status, or color changes.",
      added,
      removed,
      statusChanged,
      colorChanged
    };
  }

  return {
    shouldSendTelegram: true,
    reason: "Added, removed, status, or color changes detected.",
    added,
    removed,
    statusChanged,
    colorChanged
  };
}

function buildTelegramMessage(currentSnapshot: SnapshotState, decision: Decision) {
  const lines = [
    "BMS change detected",
    "",
    `Watch: ${currentSnapshot.alias}`,
    `Page: ${currentSnapshot.pageTitle}`,
    ""
  ];

  if (decision.added?.length) {
    lines.push("Added:");
    for (const item of collapseDuplicateChanges(decision.added).slice(0, 20)) {
      lines.push(`+ ${formatDuplicateChangeLine(item)} (${item.status})`);
    }
    lines.push("");
  }

  if (decision.removed?.length) {
    lines.push("Removed:");
    for (const item of collapseDuplicateChanges(decision.removed).slice(0, 20)) {
      lines.push(`- ${formatDuplicateChangeLine(item)}`);
    }
    lines.push("");
  }

  if (decision.statusChanged?.length) {
    lines.push("Status changed:");
    for (const item of decision.statusChanged.slice(0, 20)) {
      lines.push(`* ${compactShowtime(item.current)}`);
      lines.push(`  ${item.oldStatus} -> ${item.newStatus}`);
    }
    lines.push("");
  }

  if (decision.colorChanged?.length) {
    lines.push("");
    lines.push("Color changed:");
    for (const item of decision.colorChanged) {
      lines.push(`* ${compactShowtime(item.current)}`);
      lines.push(`  ${item.oldColorBucket} → ${item.newColorBucket}`);
    }
  }

  lines.push(currentSnapshot.targetUrl);
  return lines.join("\n");
}

function compactShowtime(item: any) {
  const movie = item.movie || "Unknown movie";
  const row = item.row || "Unknown format";
  const time = item.time || "Unknown time";
  const screenText = cleanScreenText(item.screenText);

  return `${movie} \u2014 ${row} | ${time}${
    screenText ? ` | ${screenText}` : " | no screen label"
  }`;
}

function buildShowBaseKey(item: any) {
  return [
    normalizeKeyPart(item.movie),
    normalizeKeyPart(item.row),
    normalizeKeyPart(item.time),
    normalizeScreenKey(item.screenText) || "no-screen"
  ].join(" | ");
}

function assignOccurrenceIds(items: any[]) {
  const counters = new Map<string, number>();

  return items.map((item) => {
    const baseKey = buildShowBaseKey(item);
    const occurrence = (counters.get(baseKey) || 0) + 1;
    counters.set(baseKey, occurrence);

    return {
      ...item,
      baseKey,
      occurrence,
      id: `${baseKey} | occurrence-${occurrence}`
    };
  });
}

function compareShowItems(left: any, right: any) {
  const partsLeft = [
    normalizeKeyPart(left.movie),
    normalizeKeyPart(left.row),
    normalizeKeyPart(left.time),
    normalizeScreenKey(left.screenText),
    Number(left.originalPageIndex || 0).toString().padStart(6, "0")
  ];
  const partsRight = [
    normalizeKeyPart(right.movie),
    normalizeKeyPart(right.row),
    normalizeKeyPart(right.time),
    normalizeScreenKey(right.screenText),
    Number(right.originalPageIndex || 0).toString().padStart(6, "0")
  ];

  return partsLeft.join(" | ").localeCompare(partsRight.join(" | "));
}

function countByBaseKey(items: any[]) {
  const map = new Map<string, { count: number; sample: any }>();

  for (const item of items || []) {
    const baseKey = item.baseKey || buildShowBaseKey(item);
    const existing = map.get(baseKey);

    if (existing) {
      existing.count += 1;
    } else {
      map.set(baseKey, { count: 1, sample: item });
    }
  }

  return map;
}

function compareSnapshots(previous: any, current: any) {
  const oldCounts = countByBaseKey(previous.items || []);
  const newCounts = countByBaseKey(current.items || []);

  const added: any[] = [];
  const removed: any[] = [];

  const allKeys = new Set([...oldCounts.keys(), ...newCounts.keys()]);

  for (const key of allKeys) {
    const oldEntry = oldCounts.get(key);
    const newEntry = newCounts.get(key);

    const oldCount = oldEntry?.count || 0;
    const newCount = newEntry?.count || 0;

    if (newCount > oldCount && newEntry) {
      const diff = newCount - oldCount;
      for (let i = 0; i < diff; i++) {
        added.push({
          ...newEntry.sample,
          duplicateChangeCount: diff
        });
      }
    }

    if (oldCount > newCount && oldEntry) {
      const diff = oldCount - newCount;
      for (let i = 0; i < diff; i++) {
        removed.push({
          ...oldEntry.sample,
          duplicateChangeCount: diff
        });
      }
    }
  }

  const statusChanged = compareStatusChanges(previous.items || [], current.items || []);
  const colorChanged = compareColorChanges(previous.items || [], current.items || []);

  return {
    added,
    removed,
    statusChanged,
    colorChanged,
    addedCount: added.length,
    removedCount: removed.length,
    statusChangedCount: statusChanged.length,
    colorChangedCount: colorChanged.length,
    changed:
      added.length > 0 ||
      removed.length > 0 ||
      statusChanged.length > 0 ||
      colorChanged.length > 0
  };
}

function parseRgbNumbers(value: string) {
  const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const parts = match[1]
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((x) => Number.isFinite(x));

  if (parts.length < 3) return null;

  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: parts.length >= 4 ? parts[3] : 1
  };
}

function classifyRgbColor(value: string) {
  const rgb = parseRgbNumbers(value);
  if (!rgb) return "unknown";

  const { r, g, b, a } = rgb;

  if (a === 0) return "transparent";

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const spread = max - min;

  if (spread <= 18 && max <= 170) return "grey_like";
  if (spread <= 18 && max >= 171) return "grey_like";
  if (g >= 110 && g > r + 25 && g > b + 25) return "green_like";
  if (r >= 150 && r > g + 35 && r > b + 35) return "red_like";
  if (r >= 180 && g >= 80 && g <= 190 && b <= 90) return "orange_like";
  if (r >= 170 && g >= 150 && b <= 100) return "yellow_like";

  return "non_grey";
}

function scoreColorCandidate(candidate: string, bucket: string) {
  const lower = String(candidate || "").toLowerCase();
  let score = 0;

  if (lower.startsWith("self.")) score += 12;
  else if (lower.startsWith("child.")) score += 9;
  else if (lower.startsWith("parent1.")) score += 7;
  else if (lower.startsWith("parent2.")) score += 5;
  else if (lower.startsWith("parent3.")) score += 3;
  else if (lower.startsWith("parent4.")) score += 2;

  if (
    lower.includes(".background=") ||
    lower.includes(".border") ||
    lower.includes(".fill=") ||
    lower.includes(".stroke=") ||
    lower.includes(".svg")
  ) {
    score += 6;
  } else if (lower.includes(".color=")) {
    score += 2;
  }

  if (lower.includes(".before.") || lower.includes(".after.")) {
    score += 4;
  }

  if (bucket === "grey_like") score += 1;
  if (bucket === "green_like") score += 5;
  if (bucket === "yellow_like") score += 4;
  if (bucket === "orange_like") score += 4;
  if (bucket === "red_like") score += 4;
  if (bucket === "non_grey") score += 1;

  return score;
}

function bestBucketFromCandidates(candidates: string[]) {
  const scoreByBucket = new Map<string, number>();

  for (const candidate of candidates) {
    const bucket = classifyRgbColor(candidate);
    if (!bucket || bucket === "transparent" || bucket === "unknown") {
      continue;
    }

    const score = scoreColorCandidate(candidate, bucket);
    scoreByBucket.set(bucket, (scoreByBucket.get(bucket) || 0) + score);
  }

  const priority = [
    "green_like",
    "yellow_like",
    "orange_like",
    "red_like",
    "grey_like",
    "non_grey"
  ];

  let bestBucket = "unknown";
  let bestScore = -1;

  for (const bucket of priority) {
    const score = scoreByBucket.get(bucket) || 0;
    if (score > bestScore) {
      bestBucket = bucket;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestBucket : "unknown";
}

function getColorBucket(item: any) {
  const explicit = String(item?.colorBucket || item?.availabilityColorBucket || "")
    .toLowerCase()
    .trim();
  const raw = String(item?.rawColor || "");

  if (explicit === "yellow_or_orange_like") return "orange_like";
  if (
    [
      "grey_like",
      "green_like",
      "yellow_like",
      "orange_like",
      "red_like",
      "non_grey",
      "unknown"
    ].includes(explicit)
  ) {
    return explicit;
  }

  const rawLower = raw.toLowerCase();

  if (rawLower.includes("bucket=grey_like") || rawLower.includes("grey_like")) {
    return "grey_like";
  }
  if (rawLower.includes("bucket=green_like") || rawLower.includes("green_like")) {
    return "green_like";
  }
  if (rawLower.includes("bucket=yellow_like") || rawLower.includes("yellow_like")) {
    return "yellow_like";
  }
  if (rawLower.includes("bucket=orange_like") || rawLower.includes("orange_like")) {
    return "orange_like";
  }
  if (rawLower.includes("bucket=red_like") || rawLower.includes("red_like")) {
    return "red_like";
  }

  const candidates = raw
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  const derived = bestBucketFromCandidates(candidates);

  return derived;
}

function isGreyBucket(bucket: string) {
  return String(bucket || "").toLowerCase() === "grey_like";
}

function isUsefulNonGreyBucket(bucket: string) {
  return ["green_like", "yellow_like", "orange_like", "red_like", "non_grey"].includes(
    String(bucket || "").toLowerCase()
  );
}

function findPreviousComparableItem(oldItems: any[], current: any) {
  const items = oldItems || [];

  const byId = items.find((x) => x.id === current.id);
  if (byId) return byId;

  const currentBaseKey = String(current.baseKey || buildShowBaseKey(current));
  const currentOccurrence = Number(current.occurrence || 0);
  const sameBaseKey = items.filter(
    (x) => String(x.baseKey || buildShowBaseKey(x)) === currentBaseKey
  );

  if (sameBaseKey.length === 1) {
    return sameBaseKey[0];
  }

  if (sameBaseKey.length > 1 && currentOccurrence > 0) {
    const sameOccurrence = sameBaseKey.find(
      (x) => Number(x.occurrence || 0) === currentOccurrence
    );
    if (sameOccurrence) return sameOccurrence;
  }

  const screenKey = normalizeScreenKey(current.screenText);
  const fallbackCandidates = items.filter((x) => {
    return (
      normalizeKeyPart(x.movie) === normalizeKeyPart(current.movie) &&
      normalizeKeyPart(x.row) === normalizeKeyPart(current.row) &&
      normalizeKeyPart(x.time) === normalizeKeyPart(current.time) &&
      normalizeScreenKey(x.screenText) === screenKey
    );
  });

  if (fallbackCandidates.length === 1) {
    return fallbackCandidates[0];
  }

  if (fallbackCandidates.length > 1 && currentOccurrence > 0) {
    const sameOccurrence = fallbackCandidates.find(
      (x) => Number(x.occurrence || 0) === currentOccurrence
    );
    if (sameOccurrence) return sameOccurrence;
  }

  if (fallbackCandidates.length > 1) {
    const currentIndex = Number(current.originalPageIndex || 0);
    return [...fallbackCandidates].sort((left, right) => {
      return (
        Math.abs(Number(left.originalPageIndex || 0) - currentIndex) -
        Math.abs(Number(right.originalPageIndex || 0) - currentIndex)
      );
    })[0];
  }

  return null;
}

function compareColorChanges(oldItems: any[], newItems: any[]) {
  const changed: Array<{
    previous: ShowtimeSnapshot;
    current: ShowtimeSnapshot;
    oldColorBucket: string;
    newColorBucket: string;
  }> = [];

  for (const current of newItems || []) {
    const previous = findPreviousComparableItem(oldItems || [], current);
    if (!previous) continue;

    const oldColorBucket = String(
      previous.colorBucket || getColorBucket(previous) || "unknown"
    ).toLowerCase();
    const newColorBucket = String(
      current.colorBucket || getColorBucket(current) || "unknown"
    ).toLowerCase();

    if (!(isGreyBucket(oldColorBucket) && isUsefulNonGreyBucket(newColorBucket))) {
      continue;
    }

    changed.push({
      previous,
      current,
      oldColorBucket,
      newColorBucket
    });
  }

  return changed;
}

function compareStatusChanges(oldItems: any[], newItems: any[]) {
  const changed: StatusChange[] = [];

  for (const current of newItems) {
    const previous = findPreviousComparableItem(oldItems || [], current);
    if (!previous) continue;

    const isAmbiguousDuplicate =
      String(current.baseKey || "").includes("| no-screen") &&
      Number(current.occurrence || 0) > 1;

    if (isAmbiguousDuplicate) continue;

    if (
      previous.status &&
      current.status &&
      previous.status !== current.status
    ) {
      changed.push({
        previous,
        current,
        oldStatus: previous.status,
        newStatus: current.status
      });
    }
  }

  return changed;
}

function collapseDuplicateChanges(items: any[]) {
  const grouped = new Map<string, any>();

  for (const item of items || []) {
    const key = item.baseKey || buildShowBaseKey(item);
    const existing = grouped.get(key);

    if (existing) {
      existing.duplicateChangeCount += 1;
    } else {
      grouped.set(key, {
        ...item,
        duplicateChangeCount: 1
      });
    }
  }

  return [...grouped.values()];
}

function formatDuplicateChangeLine(item: any) {
  const count = Number(item.duplicateChangeCount || 1);
  return `${compactShowtime(item)}${count > 1 ? ` x${count}` : ""}`;
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
