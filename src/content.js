function debugLog(...args) {
  console.log(`[Kick Resumer]`, ...args);
}

const CONFIG = {
  SAVE_INTERVAL_MS: 5000,
  SAVE_THROTTLE_MS: 1000,
  ENFORCER_INTERVAL_MS: 250,
  ENFORCER_MAX_ATTEMPTS: 12,
  RESET_THRESHOLD_S: 5,
  MIN_TIME_FOR_ENFORCE_S: 10,
  VIDEO_END_BUFFER_S: 0.5,
  MAX_CACHE_DAYS: 30,
};

let currentVideoId = null;
let currentVideoElement = null;
let saveInterval = null;
let enforcerInterval = null;
let isEnforcing = false;
let lastSaveTime = 0;
let watchedCache = {};
let currentObserver = null;
let initGeneration = 0;
let contextDead = false;
let videoAbortController = null;

async function storageGet(keys) {
  if (contextDead) return {};
  return browser.storage.local.get(keys).catch(() => {
    contextDead = true;
    return {};
  });
}
async function storageSet(items) {
  if (contextDead) return;
  return browser.storage.local.set(items).catch(() => {
    contextDead = true;
  });
}
async function storageRemove(keys) {
  if (contextDead) return;
  return browser.storage.local.remove(keys).catch(() => {
    contextDead = true;
  });
}

function checkUrlAndDom() {
  const videoId = getVideoIdFromUrl();
  debugLog(
    "checkUrlAndDom - videoId:",
    videoId,
    "currentVideoId:",
    currentVideoId,
  );

  if (!videoId) {
    if (currentVideoId) {
      cleanup();
    }
    return;
  }

  if (videoId !== currentVideoId) {
    cleanup();
    currentVideoId = videoId;
  }

  if (currentVideoId) {
    if (currentVideoElement && !currentVideoElement.isConnected) {
      debugLog("video element disconnected, cleaning up");
      cleanupListeners();
      currentVideoElement = null;
    }

    if (!currentVideoElement) {
      const video = document.querySelector("video");
      debugLog("querySelector video:", video ? "found" : "NOT FOUND");
      if (video) {
        currentVideoElement = video;
        debugLog("calling initializeVideo for", currentVideoId);
        initializeVideo(currentVideoId, currentVideoElement);
      }
    } else {
      debugLog("already have video element, skipping setup");
    }
  }
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function getWatchTime(data) {
  if (typeof data === "number") return data;
  if (data && typeof data.time === "number") return data.time;
  return 0;
}

function getVideoIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/\/videos\/([a-zA-Z0-9-]+)/);
  const id = match ? match[1] : null;
  debugLog("getVideoIdFromUrl: path=" + path + " => " + id);
  return id;
}

function cleanup() {
  initGeneration++;
  currentVideoId = null;
  cleanupListeners();
  currentVideoElement = null;
  isEnforcing = false;
  currentVodExpiry = null;

  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
  if (enforcerInterval) {
    clearInterval(enforcerInterval);
    enforcerInterval = null;
  }
}

function cleanupListeners() {
  if (videoAbortController) {
    videoAbortController.abort();
    videoAbortController = null;
  }
}

async function initializeVideo(videoId, video) {
  const gen = ++initGeneration;
  debugLog("initializeVideo start - videoId:", videoId, "gen:", gen);

  const expiry = parseUnavailableAfter();
  if (expiry && Date.now() > expiry) {
    debugLog("VOD expired, removing");
    await storageRemove(videoId);
    delete watchedCache[videoId];
    debugLog("VOD " + videoId + " is unavailable, progress deleted");
    return;
  }
  currentVodExpiry = expiry;
  let savedTime = 0;
  const result = await storageGet(videoId);
  const data = result[videoId];
  debugLog("storage lookup for " + videoId + ":", data);
  if (typeof data === "number") {
    savedTime = data;
  } else if (data && typeof data === "object") {
    savedTime = data.time;
  }

  if (gen !== initGeneration) return;

  debugLog("savedTime:", savedTime, "readyState:", video.readyState);

  if (savedTime && typeof savedTime === "number") {
    const performRestore = () => {
      const seekTarget = video.duration
        ? Math.min(savedTime, video.duration - CONFIG.VIDEO_END_BUFFER_S)
        : savedTime;
      debugLog("restoring to time:", seekTarget);
      performSeek(video, seekTarget);
    };

    if (video.readyState >= 1) {
      performRestore();
    } else {
      video.addEventListener("loadedmetadata", performRestore, { once: true });
    }
  } else {
    debugLog("no saved time, setting up fresh saver");
  }

  setupSaver(videoId, video);
}

function performSeek(video, targetTime) {
  isEnforcing = true;

  video.currentTime = targetTime;

  try {
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set("t", Math.floor(targetTime));
    window.history.replaceState(null, "", newUrl.toString());
  } catch (e) {
    console.log("[Kick Resumer] Failed to update URL state", e);
  }

  if (enforcerInterval) clearInterval(enforcerInterval);

  let attempts = 0;

  let enforcerAbortController = new AbortController();

  const killEnforcer = () => {
    if (enforcerInterval) {
      clearInterval(enforcerInterval);
      enforcerInterval = null;
    }
    isEnforcing = false;
    enforcerAbortController.abort();
    if (currentVideoId && video.currentTime >= CONFIG.RESET_THRESHOLD_S) {
      saveProgress(currentVideoId, video.currentTime);
    }
  };

  document.addEventListener("mousedown", killEnforcer, {
    capture: true,
    signal: enforcerAbortController.signal,
  });
  document.addEventListener("keydown", killEnforcer, {
    capture: true,
    signal: enforcerAbortController.signal,
  });

  let retrySeekAttempts = 0;

  const onTimeUpdate = () => {
    if (isEnforcing) return;
    if (!video.isConnected || !currentVideoId) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      return;
    }
    if (video.currentTime >= CONFIG.RESET_THRESHOLD_S) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      return;
    }
    retrySeekAttempts++;
    video.currentTime = targetTime;
    if (retrySeekAttempts >= 10) {
      video.removeEventListener("timeupdate", onTimeUpdate);
    }
  };

  enforcerInterval = setInterval(() => {
    attempts++;

    if (!video.isConnected) {
      killEnforcer();
      return;
    }

    if (
      targetTime > CONFIG.MIN_TIME_FOR_ENFORCE_S &&
      video.currentTime < CONFIG.RESET_THRESHOLD_S
    ) {
      video.currentTime = targetTime;
    }

    if (attempts >= CONFIG.ENFORCER_MAX_ATTEMPTS) {
      killEnforcer();
      if (targetTime > CONFIG.MIN_TIME_FOR_ENFORCE_S) {
        video.addEventListener("timeupdate", onTimeUpdate);
      }
    }
  }, CONFIG.ENFORCER_INTERVAL_MS);
}

function setupSaver(videoId, video) {
  if (saveInterval) clearInterval(saveInterval);

  cleanupListeners();

  const saveFn = () => {
    if (!currentVideoElement || currentVideoElement !== video) {
      debugLog("saveFn skip: video element mismatch");
      return;
    }
    if (isEnforcing) {
      debugLog("saveFn skip: isEnforcing");
      return;
    }
    if (video.paused || video.ended) {
      debugLog("saveFn skip: paused=" + video.paused + " ended=" + video.ended);
      return;
    }
    if (video.currentTime < CONFIG.RESET_THRESHOLD_S) {
      debugLog(
        "saveFn skip: currentTime " +
          video.currentTime +
          " < " +
          CONFIG.RESET_THRESHOLD_S,
      );
      return;
    }

    debugLog("saveFn: saving time=" + video.currentTime);
    saveProgress(videoId, video.currentTime);
  };

  saveInterval = setInterval(saveFn, CONFIG.SAVE_INTERVAL_MS);

  const eventSave = () => {
    if (isEnforcing) {
      debugLog("eventSave skip: isEnforcing");
      return;
    }
    if (video.currentTime < 1) {
      debugLog("eventSave skip: currentTime " + video.currentTime + " < 1");
      return;
    }

    const now = Date.now();
    if (now - lastSaveTime < CONFIG.SAVE_THROTTLE_MS) {
      debugLog("eventSave skip: throttled");
      return;
    }

    debugLog("eventSave: saving time=" + video.currentTime);
    saveProgress(videoId, video.currentTime);
  };

  videoAbortController = new AbortController();

  video.addEventListener("pause", eventSave, {
    signal: videoAbortController.signal,
  });
  video.addEventListener("seeked", eventSave, {
    signal: videoAbortController.signal,
  });
}

async function saveProgress(videoId, time) {
  lastSaveTime = Date.now();
  debugLog("saveProgress: videoId=" + videoId + " time=" + Math.floor(time));
  const data = { time: time, updated: lastSaveTime };
  if (currentVodExpiry) data.expiresAt = currentVodExpiry;
  await storageSet({ [videoId]: data });
  debugLog("saveProgress done for " + videoId);
}

const debouncedCheck = debounce(() => {
  checkUrlAndDom();
}, 500);

const debouncedProcessThumbnails = debounce(() => {
  processThumbnails();
}, 250);

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return 0;

  const parts = durationStr.trim().split(":").map(Number);

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return 0;
}

let currentVodExpiry = null;

function parseUnavailableAfter() {
  const meta = document.querySelector('meta[name="robots"]');
  if (!meta) return null;
  const content = meta.getAttribute("content");
  if (!content) return null;
  const match = content.match(/unavailable_after:\s*(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const date = new Date(match[1] + "T00:00:00Z");
  return isNaN(date.getTime()) ? null : date.getTime();
}

function startObserver() {
  currentObserver = new MutationObserver((mutations) => {
    let shouldProcessThumbnails = false;
    let somethingAdded = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        somethingAdded = true;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (
            node.tagName === "A" &&
            node.getAttribute("href")?.includes("/videos/")
          ) {
            shouldProcessThumbnails = true;
          } else if (node.querySelector?.('a[href*="/videos/"]')) {
            shouldProcessThumbnails = true;
          }
        }
      }
    }

    if (shouldProcessThumbnails) debouncedProcessThumbnails();
    if (somethingAdded) debouncedCheck();
  });

  currentObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("popstate", debouncedCheck);
}

function processThumbnails() {
  const thumbnailLinks = document.querySelectorAll(
    'a[href*="/videos/"]:not(.kick-resumer-processed)',
  );

  thumbnailLinks.forEach((linkElement) => {
    linkElement.classList.add("kick-resumer-processed");

    const href = linkElement.getAttribute("href");
    const match = href.match(/\/videos\/([a-zA-Z0-9-]+)/);
    if (!match) return;

    const videoId = match[1];
    let watchedSeconds = 0;
    if (watchedCache[videoId]) {
      watchedSeconds = getWatchTime(watchedCache[videoId]);
    }

    if (watchedSeconds && watchedSeconds > 30) {
      injectVisualFeedback(linkElement, watchedSeconds);
    }
  });
}

function injectVisualFeedback(linkElement, watchedSeconds) {
  const durationElement = linkElement.querySelector(".top-1\\.5.left-1\\.5");
  if (!durationElement) return;

  const totalSeconds = parseDurationToSeconds(durationElement.textContent);
  if (totalSeconds === 0) return;

  let percentage = (watchedSeconds / totalSeconds) * 100;

  if (percentage > 95) {
    percentage = 100;
  }

  const imageWrapper = linkElement.querySelector("div.relative.h-full.w-full");

  if (!imageWrapper) return;

  const progressBar = document.createElement("div");
  progressBar.style.cssText = `
    position: absolute;
    bottom: 0;
    left: 0;
    height: 4px;
    width: ${percentage}%;
    background-color: #53fc18;
    z-index: 10;
    pointer-events: none;
    border-bottom-left-radius: 2px;
    border-bottom-right-radius: 2px;
    transition: width 0.3s ease;
  `;

  imageWrapper.appendChild(progressBar);
}

async function cleanupCache() {
  const now = Date.now();
  const maxAgeMs = CONFIG.MAX_CACHE_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = [];
  const migratedIds = [];

  for (const [id, data] of Object.entries(watchedCache)) {
    const watchTime = getWatchTime(data);
    if (watchTime === 0) continue;

    if (typeof data === "number") {
      watchedCache[id] = { time: data, updated: now };
      migratedIds.push(id);
    } else if (data && typeof data === "object") {
      if (typeof data.expiresAt === "number") {
        if (now > data.expiresAt) toDelete.push(id);
      } else if (
        typeof data.updated !== "number" ||
        now - data.updated > maxAgeMs
      ) {
        toDelete.push(id);
      }
    }
  }

  if (toDelete.length > 0) {
    debugLog("Cleaning up " + toDelete.length + " old VODs");
    await storageRemove(toDelete);
    for (const id of toDelete) {
      delete watchedCache[id];
    }
  }

  if (migratedIds.length > 0) {
    const toSet = {};
    for (const id of migratedIds) toSet[id] = watchedCache[id];
    await storageSet(toSet);
  }
}

async function init() {
  if (window.__kickResumerInitialized) {
    debugLog("init: already initialized, skipping");
    return;
  }
  window.__kickResumerInitialized = true;
  debugLog("init: content script loaded, path=" + window.location.pathname);

  watchedCache = await storageGet(null);
  debugLog(
    "init: loaded " +
      Object.keys(watchedCache).length +
      " entries from storage",
  );

  await cleanupCache();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      for (let [id, { newValue }] of Object.entries(changes)) {
        if (!newValue) delete watchedCache[id];
        else watchedCache[id] = newValue;
      }
    }
  });

  const emergencySave = () => {
    debugLog(
      "emergencySave triggered: videoId=" +
        currentVideoId +
        " currentTime=" +
        currentVideoElement?.currentTime +
        " hidden=" +
        document.hidden,
    );
    if (currentVideoElement && currentVideoId) {
      if (currentVideoElement.currentTime >= CONFIG.RESET_THRESHOLD_S) {
        saveProgress(currentVideoId, currentVideoElement.currentTime);
      } else {
        debugLog("emergencySave skip: currentTime too low");
      }
    } else {
      debugLog("emergencySave skip: no videoId or videoElement");
    }
  };

  document.addEventListener("visibilitychange", emergencySave);
  window.addEventListener("pagehide", emergencySave);

  startObserver();
  processThumbnails();
  checkUrlAndDom();
}

init();
