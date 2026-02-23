const LOG_PREFIX = "[Kick Resumer]";

const CONFIG = {
  CHECK_INTERVAL_MS: 1000,    // For URL/Video element changes
  SAVE_INTERVAL_MS: 5000,
  SAVE_THROTTLE_MS: 1000,
  ENFORCER_INTERVAL_MS: 250,  // How often the enforcer checks for the reset bug
  ENFORCER_MAX_ATTEMPTS: 12,  // Total enforcer duration (~3 seconds)
  RESET_THRESHOLD_S: 5,       // If time jumps below this, we assume the reset bug happened
  MIN_TIME_FOR_ENFORCE_S: 10, // Only enforce if the target was further than 10s in
  VIDEO_END_BUFFER_S: 0.5,    // Stay slightly before the absolute end to avoid player glitches
};

let currentVideoId = null;
let currentVideoElement = null;
let saveInterval = null;
let enforcerInterval = null;
let isEnforcing = false;
let lastSaveTime = 0;
let watchedCache = {};
let currentObserver = null;

let activeEventListeners = {
  element: null,
  listeners: [],
};

function checkUrlAndDom() {
  const videoId = getVideoIdFromUrl();

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
      cleanupListeners();
      currentVideoElement = null;
    }

    if (!currentVideoElement) {
      const video = document.querySelector("video");
      if (video) {
        currentVideoElement = video;
        initializeVideo(currentVideoId, currentVideoElement);
      }
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

function getVideoIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/\/videos\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

function cleanup() {
  currentVideoId = null;
  cleanupListeners();
  currentVideoElement = null;
  isEnforcing = false;

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
  if (
    activeEventListeners.element &&
    activeEventListeners.listeners.length > 0
  ) {
    activeEventListeners.listeners.forEach(({ type, fn }) => {
      try {
        activeEventListeners.element.removeEventListener(type, fn);
      } catch (e) {}
    });
  }
  activeEventListeners = { element: null, listeners: [] };
}

async function initializeVideo(videoId, video) {
  let savedTime = 0;
  try {
    const result = await browser.storage.local.get(videoId);
    savedTime = result[videoId];
  } catch (error) {
    console.log(`${LOG_PREFIX} Could not read storage for ${videoId}:`, error);
  }

  if (savedTime && typeof savedTime === "number") {
    const performRestore = () => {
      const seekTarget = video.duration
        ? Math.min(savedTime, video.duration - CONFIG.VIDEO_END_BUFFER_S)
        : savedTime;
      performSeek(video, seekTarget);
    };

    if (video.readyState >= 1) {
      performRestore();
    } else {
      video.addEventListener("loadedmetadata", performRestore, { once: true });
    }
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
    console.log(`${LOG_PREFIX} Failed to update URL state`, e);
  }

  if (enforcerInterval) clearInterval(enforcerInterval);

  let attempts = 0;

  const killEnforcer = () => {
    if (enforcerInterval) {
      clearInterval(enforcerInterval);
      enforcerInterval = null;
    }
    isEnforcing = false;
    document.removeEventListener("mousedown", killEnforcer, true);
    document.removeEventListener("keydown", killEnforcer, true);
  };

  document.addEventListener("mousedown", killEnforcer, true);
  document.addEventListener("keydown", killEnforcer, true);

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
    }
  }, CONFIG.ENFORCER_INTERVAL_MS);
}

function setupSaver(videoId, video) {
  if (saveInterval) clearInterval(saveInterval);

  cleanupListeners();

  const saveFn = () => {
    if (!currentVideoElement || currentVideoElement !== video) return;
    if (isEnforcing) return;
    if (video.paused || video.ended) return;
    if (video.currentTime < CONFIG.RESET_THRESHOLD_S) return;

    saveProgress(videoId, video.currentTime);
  };

  saveInterval = setInterval(saveFn, CONFIG.SAVE_INTERVAL_MS);

  const eventSave = () => {
    if (isEnforcing) return;
    if (video.currentTime < 1) return;

    const now = Date.now();
    if (now - lastSaveTime < CONFIG.SAVE_THROTTLE_MS) return;

    saveProgress(videoId, video.currentTime);
  };

  video.addEventListener("pause", eventSave);
  video.addEventListener("seeked", eventSave);

  activeEventListeners.element = video;
  activeEventListeners.listeners.push(
    { type: "pause", fn: eventSave },
    { type: "seeked", fn: eventSave }
  );
}

function saveProgress(videoId, time) {
  lastSaveTime = Date.now();
  try {
    browser.storage.local.set({ [videoId]: time });
  } catch (e) {
    console.log(`${LOG_PREFIX} Failed to save progress for ${videoId}`, e);
  }
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

function startObserver() {
  currentObserver = new MutationObserver((mutations) => {
    let shouldProcessThumbnails = false;
    let somethingAdded = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        somethingAdded = true;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          if (node.tagName === "A" && node.getAttribute("href")?.includes("/videos/")) {
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
    const watchedSeconds = watchedCache[videoId];

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

async function init() {
  watchedCache = await browser.storage.local.get(null);
  
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      for (let [id, { newValue }] of Object.entries(changes)) {
        if (!newValue) delete watchedCache[id];
        else watchedCache[id] = newValue;
      }
    }
  });

  startObserver();
  processThumbnails();
  checkUrlAndDom();
}

init();
