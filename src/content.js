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

let activeEventListeners = {
  element: null,
  listeners: [],
};

setInterval(() => {
  checkUrlAndDom();
}, CONFIG.CHECK_INTERVAL_MS);

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
