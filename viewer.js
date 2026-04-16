const DATA_DIR = "Keter-Image_And_Alto";
const MANIFEST_PATH = `${DATA_DIR}/manifest.json`;
const ALIGNMENT_PATH = `${DATA_DIR}/alto_blocks_to_bible_aligned.json`;
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_PUBLIC_DRIVE_FOLDER_ID = "1POm8kAP0868XFKxa1F4be5fNfr_3L5IV";

const state = {
  pages: [],
  alignmentByFile: new Map(),
  globalVerseMap: new Map(),
  globalBookStructure: [],
  currentPageIndex: 0,
  currentPageModel: null,
  selectedVerseKey: null,
  selectedWordId: null,
  xmlCache: new Map(),
  sourceMode: "fetch",
  localFiles: new Map(),
  driveFiles: new Map(),
  driveApiKey: "",
  driveImageIds: new Map(),
  imageUrlCache: new Map(),
  showNikud: true,
  showTaamim: true,
  searchResults: [],
  searchIndex: -1,
  canonicalVerseWords: new Map(),
  selectedCanonWordIdx: null
};

const els = {
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageSelect: document.getElementById("pageSelect"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  folderInput: document.getElementById("folderInput"),
  driveFolderInput: document.getElementById("driveFolderInput"),
  driveApiKeyInput: document.getElementById("driveApiKeyInput"),
  loadDriveBtn: document.getElementById("loadDriveBtn"),
  toggleNikud: document.getElementById("toggleNikud"),
  toggleTaamim: document.getElementById("toggleTaamim"),
  searchInput: document.getElementById("searchInput"),
  searchPrevBtn: document.getElementById("searchPrevBtn"),
  searchNextBtn: document.getElementById("searchNextBtn"),
  clearSearchBtn: document.getElementById("clearSearchBtn"),
  searchMeta: document.getElementById("searchMeta"),
  chapterSelect: document.getElementById("chapterSelect"),
  verseSelect: document.getElementById("verseSelect"),
  goVerseBtn: document.getElementById("goVerseBtn"),
  bookSelect: document.getElementById("bookSelect"),
  status: document.getElementById("status"),
  bookTitle: document.getElementById("bookTitle"),
  hierarchy: document.getElementById("hierarchy"),
  image: document.getElementById("folioImage"),
  overlay: document.getElementById("overlay")
};

init().catch((error) => {
  const protocolHint = window.location.protocol === "file:"
    ? " (פתחו דרך שרת סטטי או השתמשו בכפתור 'בחירת תיקייה מקומית')"
    : "";
  setStatus(`שגיאה בטעינת הצפיין: ${error.message}${protocolHint}`);
  console.error(error);
});

async function init() {
  bindEvents();
  if (els.driveFolderInput && !els.driveFolderInput.value) {
    els.driveFolderInput.value = DEFAULT_PUBLIC_DRIVE_FOLDER_ID;
  }

  try {
    await initFromFetch();
  } catch (error) {
    if (window.location.protocol === "file:") {
      toggleControls(true);
      // Re-enable source-picker controls so the user can still select a local folder or Drive
      if (els.pickFolderBtn) els.pickFolderBtn.disabled = false;
      if (els.loadDriveBtn) els.loadDriveBtn.disabled = false;
      if (els.driveFolderInput) els.driveFolderInput.disabled = false;
      if (els.driveApiKeyInput) els.driveApiKeyInput.disabled = false;
      setStatus("לא ניתן לטעון קבצים אוטומטית מתוך file://. לחצו על 'בחירת תיקייה מקומית'.");
      return;
    }
    throw error;
  }
}

async function initFromFetch() {
  setStatus("טוען נתונים...");

  const [alignmentRows, manifest, driveImageIds] = await Promise.all([
    fetchJson(ALIGNMENT_PATH).catch(() => fetchJson(`${DATA_DIR}/alto_to_bible_anchors.json`)),
    fetchJson(MANIFEST_PATH).catch(() => ({ pages: [] })),
    fetchJson(`${DATA_DIR}/drive-image-ids.json`).catch(() => null)
  ]);

  if (driveImageIds && typeof driveImageIds === "object") {
    state.driveImageIds = new Map(Object.entries(driveImageIds));
  } else {
    state.driveImageIds = new Map();
  }

  normalizeAlignmentRows(alignmentRows);

  const canonicalMap = new Map();
  await Promise.all(collectBookNames(alignmentRows).map(async (book) => {
    const text = await fetchText(`${DATA_DIR}/${book}.xml`).catch(() => null);
    if (text) parseCanonicalXml(text, book, canonicalMap);
  }));
  state.canonicalVerseWords = canonicalMap;
  state.sourceMode = "fetch";
  state.xmlCache.clear();
  state.localFiles = new Map();
  state.driveFiles = new Map();
  state.driveApiKey = "";
  state.alignmentByFile = buildAlignmentIndex(alignmentRows);

  const inferred = inferPagesFromAlignment(alignmentRows);
  const manifestNorm = (manifest.pages || []).map(normalizePage).filter((p) => p.folio);
  const byFolio = new Map();
  inferred.forEach((p) => byFolio.set(p.folio, p));
  manifestNorm.forEach((p) => byFolio.set(p.folio, p));

  state.pages = [...byFolio.values()]
    .filter((p) => state.alignmentByFile.has(p.alto_base_file))
    .sort((a, b) => pageSortKey(a.folio) - pageSortKey(b.folio));

  buildGlobalVerseMap(alignmentRows, state.pages);
  fillGlobalNavSelectors();

  if (!state.pages.length) {
    throw new Error("לא נמצאו עמודים עם מיפוי ALTO");
  }

  fillPageSelector();
  await loadPage(0);
}

async function initFromFolder(files) {
  state.sourceMode = "folder";
  state.xmlCache.clear();
  revokeImageUrls();
  state.driveFiles = new Map();
  state.driveApiKey = "";

  const fileMap = new Map();
  files.forEach((file) => fileMap.set(file.name, file));
  state.localFiles = fileMap;

  const alignmentFile = fileMap.get("alto_blocks_to_bible_aligned.json")
    || fileMap.get("alto_to_bible_anchors.json");
  if (!alignmentFile) {
    throw new Error("לא נמצא קובץ מיפוי ALTO (alto_blocks_to_bible_aligned.json או alto_to_bible_anchors.json) בתיקייה שנבחרה");
  }

  const alignmentRows = JSON.parse(await alignmentFile.text());
  normalizeAlignmentRows(alignmentRows);

  const canonicalMap = new Map();
  await Promise.all(collectBookNames(alignmentRows).map(async (book) => {
    const f = fileMap.get(`${book}.xml`);
    if (f) parseCanonicalXml(await f.text(), book, canonicalMap);
  }));
  state.canonicalVerseWords = canonicalMap;

  let manifestPages = [];
  const manifestFile = fileMap.get("manifest.json");
  if (manifestFile) {
    const manifest = JSON.parse(await manifestFile.text());
    manifestPages = manifest.pages || [];
  }

  state.alignmentByFile = buildAlignmentIndex(alignmentRows);

  const inferred = inferPagesFromAlignment(alignmentRows);
  const manifestNorm = manifestPages.map(normalizePage).filter((p) => p.folio);
  const byFolio = new Map();
  inferred.forEach((p) => byFolio.set(p.folio, p));
  manifestNorm.forEach((p) => byFolio.set(p.folio, p));

  // Resolve alto_file: use _with_bible_text variant if present; otherwise fall back to base xml
  const resolvedPages = [...byFolio.values()].map((p) => {
    const altoFile = fileMap.has(p.alto_file) ? p.alto_file : p.alto_base_file;
    return { ...p, alto_file: altoFile };
  });

  state.pages = resolvedPages
    .filter((p) => state.alignmentByFile.has(p.alto_base_file) && fileMap.has(p.alto_file) && fileMap.has(p.image_file))
    .sort((a, b) => pageSortKey(a.folio) - pageSortKey(b.folio));

  buildGlobalVerseMap(alignmentRows, state.pages);
  fillGlobalNavSelectors();

  if (!state.pages.length) {
    throw new Error("לא נמצאו זוגות תקינים של JPG + XML עם מיפוי ALTO");
  }

  fillPageSelector();
  await loadPage(0);
}

async function initFromDriveFolder(folderId, apiKey) {
  state.sourceMode = "drive";
  state.xmlCache.clear();
  revokeImageUrls();
  state.driveApiKey = apiKey;
  state.localFiles = new Map();

  const driveFiles = await listDriveFilesRecursive(folderId, apiKey);
  state.driveFiles = driveFiles;

  const alignmentName = driveFiles.has("alto_blocks_to_bible_aligned.json")
    ? "alto_blocks_to_bible_aligned.json"
    : (driveFiles.has("alto_to_bible_anchors.json") ? "alto_to_bible_anchors.json" : "");

  if (!alignmentName) {
    throw new Error("לא נמצא קובץ מיפוי ALTO בתיקיית Drive");
  }

  const alignmentRows = JSON.parse(await getDriveText(alignmentName));
  normalizeAlignmentRows(alignmentRows);

  const canonicalMap = new Map();
  await Promise.all(collectBookNames(alignmentRows).map(async (book) => {
    const xmlName = `${book}.xml`;
    if (!driveFiles.has(xmlName)) return;
    parseCanonicalXml(await getDriveText(xmlName), book, canonicalMap);
  }));
  state.canonicalVerseWords = canonicalMap;

  let manifestPages = [];
  if (driveFiles.has("manifest.json")) {
    const manifest = JSON.parse(await getDriveText("manifest.json"));
    manifestPages = manifest.pages || [];
  }

  state.alignmentByFile = buildAlignmentIndex(alignmentRows);

  const inferred = inferPagesFromAlignment(alignmentRows);
  const manifestNorm = manifestPages.map(normalizePage).filter((p) => p.folio);
  const byFolio = new Map();
  inferred.forEach((p) => byFolio.set(p.folio, p));
  manifestNorm.forEach((p) => byFolio.set(p.folio, p));

  const resolvedPages = [...byFolio.values()].map((p) => {
    const altoFile = driveFiles.has(p.alto_file) ? p.alto_file : p.alto_base_file;
    return { ...p, alto_file: altoFile };
  });

  state.pages = resolvedPages
    .filter((p) => state.alignmentByFile.has(p.alto_base_file) && driveFiles.has(p.alto_file) && driveFiles.has(p.image_file))
    .sort((a, b) => pageSortKey(a.folio) - pageSortKey(b.folio));

  buildGlobalVerseMap(alignmentRows, state.pages);
  fillGlobalNavSelectors();

  if (!state.pages.length) {
    throw new Error("לא נמצאו זוגות תקינים של JPG + XML עם מיפוי ALTO בתיקיית Drive");
  }

  fillPageSelector();
  await loadPage(0);
}

function bindEvents() {
  els.prevBtn.addEventListener("click", () => {
    if (state.currentPageIndex < state.pages.length - 1) {
      loadPage(state.currentPageIndex + 1);
    }
  });

  els.nextBtn.addEventListener("click", () => {
    if (state.currentPageIndex > 0) {
      loadPage(state.currentPageIndex - 1);
    }
  });

  els.pageSelect.addEventListener("change", () => {
    const idx = Number(els.pageSelect.value);
    if (!Number.isNaN(idx)) {
      loadPage(idx);
    }
  });

  els.pickFolderBtn.addEventListener("click", () => {
    els.folderInput.click();
  });

  els.folderInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    try {
      toggleControls(true);
      setStatus("טוען נתונים מהתיקייה המקומית...");
      await initFromFolder(files);
    } catch (error) {
      setStatus(`שגיאה בטעינת תיקייה מקומית: ${error.message}`);
      console.error(error);
      toggleControls(true);
    }
  });

  els.loadDriveBtn.addEventListener("click", async () => {
    const rawFolder = (els.driveFolderInput.value || "").trim();
    const folderId = extractDriveFolderId(rawFolder) || DEFAULT_PUBLIC_DRIVE_FOLDER_ID;
    const apiKey = (els.driveApiKeyInput.value || "").trim();

    if (!apiKey) {
      setStatus("נדרש Google API Key כדי לקרוא קבצים מתיקיית Drive ציבורית.");
      return;
    }

    try {
      toggleControls(true);
      setStatus("טוען נתונים מ-Google Drive...");
      await initFromDriveFolder(folderId, apiKey);
    } catch (error) {
      setStatus(`שגיאה בטעינת Google Drive: ${error.message}`);
      console.error(error);
      toggleControls(true);
    }
  });

  els.toggleNikud.addEventListener("click", () => {
    state.showNikud = !state.showNikud;
    els.toggleNikud.classList.toggle("is-active", state.showNikud);
    updateTextDisplay();
  });

  els.toggleTaamim.addEventListener("click", () => {
    state.showTaamim = !state.showTaamim;
    els.toggleTaamim.classList.toggle("is-active", state.showTaamim);
    updateTextDisplay();
  });

  els.searchInput.addEventListener("input", () => {
    runSearch(true);
  });

  els.searchPrevBtn.addEventListener("click", async () => {
    await goSearchResult(-1);
  });

  els.searchNextBtn.addEventListener("click", async () => {
    await goSearchResult(1);
  });

  els.clearSearchBtn.addEventListener("click", () => {
    els.searchInput.value = "";
    runSearch(true);
  });

  els.bookSelect.addEventListener("change", () => {
    fillChapterSelectForBook(els.bookSelect.value);
  });

  els.chapterSelect.addEventListener("change", () => {
    fillVerseSelectForChapter(els.chapterSelect.value);
  });

  els.goVerseBtn.addEventListener("click", async () => {
    const key = getSelectedVerseKey();
    if (!key) return;
    const targetPage = findPageForVerse(key);
    if (targetPage >= 0 && targetPage !== state.currentPageIndex) {
      await loadPage(targetPage);
    }
    selectVerse(key, true);
  });

  els.image.addEventListener("load", () => {
    syncOverlayToImage();
  });

  window.addEventListener("resize", () => {
    syncOverlayToImage();
  });

  document.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
      event.preventDefault();
      await goSearchResult(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === "ArrowLeft") {
      if (state.currentPageIndex < state.pages.length - 1) {
        loadPage(state.currentPageIndex + 1);
      }
      return;
    }

    if (event.key === "ArrowRight") {
      if (state.currentPageIndex > 0) {
        loadPage(state.currentPageIndex - 1);
      }
      return;
    }

    if (event.key === "Escape") {
      state.selectedWordId = null;
      state.selectedVerseKey = null;
      applyHighlights();
    }
  });
}

function filterText(raw) {
  let text = raw || "";
  if (!state.showTaamim) {
    text = text.replace(/[\u0591-\u05AF]/g, "");
  }
  if (!state.showNikud) {
    text = text.replace(/[\u05B0-\u05C7]/g, "");
  }
  return text;
}

function foldForSearch(text) {
  return (text || "")
    .replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, "")
    .replace(/[\u05BE\u05C0\u05C3\u05F3\u05F4.,:;!?()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitWords(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

// Strip niqqud, taamim and maqaf to produce a plain-consonants key for matching
function normalizeHebrew(s) {
  return (s || "").replace(/[\u0591-\u05C7\u05BE]/g, "").trim();
}


function updateTextDisplay() {
  document.querySelectorAll(".text-word").forEach((btn) => {
    const raw = btn.dataset.raw || btn.textContent;
    btn.dataset.raw = raw;
    btn.textContent = filterText(raw);
  });
}

function buildGlobalVerseMap(rows, pages) {
  const map = new Map();
  const pageIndexByFolio = new Map(pages.map((p, i) => [p.folio, i]));

  rows.forEach((row) => {
    const folio = extractFolio(row.alto_file);
    if (!folio) {
      return;
    }

    const vKey = verseKey(row.book, row.chapter, row.verse);
    const key = `${folio}|${vKey}`;
    let item = map.get(key);

    if (!item) {
      item = {
        folio,
        pageIndex: pageIndexByFolio.has(folio) ? pageIndexByFolio.get(folio) : -1,
        verseKey: vKey,
        chapter: row.chapter,
        verse: row.verse,
        textParts: []
      };
      map.set(key, item);
    }

    const src = row.bible_text || row.line_string_alto || "";
    if (src) {
      item.textParts.push(src);
    }
  });

  map.forEach((item) => {
    item.searchableText = foldForSearch(item.textParts.join(" "));
  });

  state.globalVerseMap = map;
}

function runSearch(resetPosition) {
  const q = foldForSearch(els.searchInput.value);

  if (!q) {
    state.searchResults = [];
    state.searchIndex = -1;
    applySearchClasses();
    updateSearchMeta();
    return;
  }

  state.searchResults = [...state.globalVerseMap.values()]
    .filter((item) => item.pageIndex >= 0 && item.searchableText.includes(q))
    .sort((a, b) => pageSortKey(a.folio) - pageSortKey(b.folio) || Number(a.chapter) - Number(b.chapter) || Number(a.verse) - Number(b.verse));

  if (!state.searchResults.length) {
    state.searchIndex = -1;
  } else if (resetPosition || state.searchIndex < 0 || state.searchIndex >= state.searchResults.length) {
    state.searchIndex = 0;
    goToSearchResult(state.searchResults[0]);
  }

  applySearchClasses();
  updateSearchMeta();
}

async function goSearchResult(direction) {
  if (!state.searchResults.length) {
    return;
  }

  const len = state.searchResults.length;
  state.searchIndex = (state.searchIndex + direction + len) % len;
  await goToSearchResult(state.searchResults[state.searchIndex]);
  applySearchClasses();
  updateSearchMeta();
}

async function goToSearchResult(result) {
  if (!result) {
    return;
  }

  if (state.currentPageIndex !== result.pageIndex) {
    await loadPage(result.pageIndex);
  }

  selectVerse(result.verseKey, true);
}

function applySearchClasses() {
  document.querySelectorAll(".is-search-hit").forEach((el) => el.classList.remove("is-search-hit"));
  document.querySelectorAll(".is-search-current").forEach((el) => el.classList.remove("is-search-current"));

  const byVerseKey = new Map();
  state.searchResults.forEach((item, idx) => {
    if (item.pageIndex === state.currentPageIndex) {
      byVerseKey.set(item.verseKey, idx);
    }
  });

  byVerseKey.forEach((idx, key) => {
    const row = document.querySelector(`.verse-row[data-verse-key="${cssEscape(key)}"]`);
    if (!row) {
      return;
    }

    row.classList.add("is-search-hit");
    if (idx === state.searchIndex) {
      row.classList.add("is-search-current");
    }
  });
}

function updateSearchMeta() {
  if (!state.searchResults.length) {
    els.searchMeta.textContent = els.searchInput.value.trim() ? "ללא תוצאות" : "";
    return;
  }

  const current = state.searchResults[state.searchIndex];
  els.searchMeta.textContent = `${state.searchIndex + 1} / ${state.searchResults.length} | ${current.folio} • ${current.chapter}:${current.verse}`;
}

function fillPageSelector() {
  els.pageSelect.innerHTML = "";
  state.pages.forEach((page, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `עמוד ${page.folio}`;
    els.pageSelect.appendChild(option);
  });
}

// Build an ordered array [{book, chapters:[{chapter, verses:['1','2',...]}]}]
// from the canonical verse-words map (every loaded book XML)
function buildGlobalBookStructure(canonicalVerseWords) {
  const books = new Map();
  canonicalVerseWords.forEach((words, key) => {
    const parts = key.split("|");
    const book = parts[0], chapter = parts[1], verse = parts[2];
    if (!books.has(book)) books.set(book, new Map());
    const chapters = books.get(book);
    if (!chapters.has(chapter)) chapters.set(chapter, []);
    chapters.get(chapter).push(verse);
  });
  return [...books.entries()].map(([book, chapters]) => ({
    book,
    chapters: [...chapters.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([chapter, verses]) => ({
        chapter,
        verses: verses.sort((a, b) => Number(a) - Number(b))
      }))
  }));
}

// Fill book/chapter/verse selectors once from all loaded canonical XMLs
function fillGlobalNavSelectors() {
  state.globalBookStructure = buildGlobalBookStructure(state.canonicalVerseWords);

  els.bookSelect.innerHTML = "";
  state.globalBookStructure.forEach(({ book }) => {
    const option = document.createElement("option");
    option.value = book;
    option.textContent = book;
    els.bookSelect.appendChild(option);
  });

  const firstBook = state.globalBookStructure[0] ? state.globalBookStructure[0].book : "";
  if (firstBook) fillChapterSelectForBook(firstBook);
}

// After loading a page, move the nav selectors to show the first verse on it
function syncNavSelectorsToPage(model) {
  if (!model || !model.verses.length) return;
  const first = model.verses[0];

  if (els.bookSelect.value !== first.book) {
    els.bookSelect.value = first.book;
    fillChapterSelectForBook(first.book);
  }
  if (els.chapterSelect.value !== first.chapter) {
    els.chapterSelect.value = first.chapter;
    fillVerseSelectForChapter(first.chapter);
  }
  els.verseSelect.value = first.key;
}

// Return the pageIndex of the first page that contains verseKey vKey, or -1
function findPageForVerse(vKey) {
  for (const item of state.globalVerseMap.values()) {
    if (item.verseKey === vKey && item.pageIndex >= 0) {
      return item.pageIndex;
    }
  }
  return -1;
}

function fillChapterSelectForBook(book) {
  els.chapterSelect.innerHTML = "";

  const bookData = state.globalBookStructure.find((b) => b.book === book);
  if (!bookData) return;

  bookData.chapters.forEach(({ chapter }) => {
    const option = document.createElement("option");
    option.value = chapter;
    option.textContent = `פרק ${chapter}`;
    els.chapterSelect.appendChild(option);
  });

  const firstChapter = bookData.chapters[0] ? bookData.chapters[0].chapter : "";
  if (firstChapter) fillVerseSelectForChapter(firstChapter);
}

function fillVerseSelectForChapter(chapter) {
  els.verseSelect.innerHTML = "";

  const book = els.bookSelect.value;
  const bookData = state.globalBookStructure.find((b) => b.book === book);
  const chapterData = bookData && bookData.chapters.find((c) => c.chapter === chapter);
  if (!chapterData) return;

  chapterData.verses.forEach((verse) => {
    const option = document.createElement("option");
    option.value = verseKey(book, chapter, verse);
    option.textContent = `פסוק ${verse}`;
    els.verseSelect.appendChild(option);
  });
}

function getSelectedVerseKey() {
  return els.verseSelect.value || null;
}

async function loadPage(index) {
  const page = state.pages[index];
  if (!page) {
    return;
  }

  toggleControls(true);
  setStatus(`טוען עמוד ${page.folio}...`);
  state.currentPageIndex = index;
  els.pageSelect.value = String(index);

  const alignmentRows = state.alignmentByFile.get(page.alto_base_file) || [];
  if (!alignmentRows.length) {
    throw new Error(`לא נמצא מיפוי ALTO לעמוד ${page.folio}`);
  }

  const xmlText = await getXmlText(page.alto_file);
  const alto = parseAlto(xmlText);
  const pageModel = buildPageModel(page, alto, alignmentRows);

  state.currentPageModel = pageModel;
  state.selectedVerseKey = null;
  state.selectedWordId = null;

  renderPage(pageModel);
  syncNavSelectorsToPage(pageModel);
  applySearchClasses();

  toggleControls(false);
  setStatus(`עמוד ${page.folio}: ${pageModel.book} | ${pageModel.chapterCount} פרקים | ${pageModel.verseCount} פסוקים`);
}

async function getXmlText(xmlName) {
  if (state.xmlCache.has(xmlName)) {
    return state.xmlCache.get(xmlName);
  }

  let text = "";
  if (state.sourceMode === "folder") {
    const file = state.localFiles.get(xmlName);
    if (!file) {
      throw new Error(`קובץ XML לא זמין: ${xmlName}`);
    }
    text = await file.text();
  } else if (state.sourceMode === "drive") {
    text = await getDriveText(xmlName);
  } else {
    let response = await fetch(`${DATA_DIR}/${xmlName}`);
    if (!response.ok && /_with_bible_text\.xml$/i.test(xmlName)) {
      const baseName = xmlName.replace(/_with_bible_text\.xml$/i, ".xml");
      response = await fetch(`${DATA_DIR}/${baseName}`);
    }
    if (!response.ok) {
      throw new Error(`קובץ XML לא זמין: ${xmlName}`);
    }
    text = await response.text();
  }

  state.xmlCache.set(xmlName, text);
  return text;
}

function parseAlto(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) {
    throw new Error("נכשלה קריאת XML");
  }

  const pageEl = firstByTag(doc, "Page");
  const width = numAttr(pageEl, "WIDTH");
  const height = numAttr(pageEl, "HEIGHT");
  const lines = [];

  byTag(doc, "TextLine").forEach((lineEl, idx) => {
    const lineId = lineEl.getAttribute("ID");
    if (!lineId) {
      return;
    }

    const words = byTag(lineEl, "String")
      .filter((stringEl) => stringEl.parentNode === lineEl)
      .map((stringEl) => ({
        id: stringEl.getAttribute("ID"),
        lineId,
        content: normalizeWord(stringEl.getAttribute("CONTENT")),
        x: numAttr(stringEl, "HPOS"),
        y: numAttr(stringEl, "VPOS"),
        width: numAttr(stringEl, "WIDTH"),
        height: numAttr(stringEl, "HEIGHT")
      }))
      .filter((word) => word.id && word.content && !isDecorative(word.content) && word.width > 0 && word.height > 0);

    if (!words.length) {
      return;
    }

    lines.push({
      id: lineId,
      index: idx,
      x: numAttr(lineEl, "HPOS"),
      y: numAttr(lineEl, "VPOS"),
      words
    });
  });

  return { width, height, lines };
}

function buildPageModel(page, alto, alignmentRows) {
  const lineMap = new Map(alto.lines.map((line) => [line.id, line]));
  const verses = new Map();
  const wordToVerse = new Map();

  alignmentRows.forEach((row) => {
    const line = lineMap.get(row.line_id);
    if (!line) {
      return;
    }

    const key = verseKey(row.book, row.chapter, row.verse);
    let verse = verses.get(key);
    if (!verse) {
      verse = {
        key,
        book: row.book,
        chapter: row.chapter,
        chapterNum: Number(row.chapter),
        verse: row.verse,
        verseNum: Number(row.verse),
        rows: [],
        altoWords: [],
        words: []
      };
      verses.set(key, verse);
    }

    verse.rows.push(row);

    line.words.forEach((word) => {
      verse.altoWords.push(word);
      wordToVerse.set(word.id, key);
    });
  });

  const sortedVerses = [...verses.values()].sort((a, b) => a.chapterNum - b.chapterNum || a.verseNum - b.verseNum);

  // Compute verse text from canonical Ezekiel.xml (authoritative source, clean verse division)
  // Falls back to bible_text from alignment rows if XML not loaded
  sortedVerses.forEach((verse) => {
    verse.words = state.canonicalVerseWords.get(verse.key)
      || splitWords(verse.rows.map((row) => row.bible_text || "").join(" "));
  });

  // Build word-level canonical→ALTO mapping for click interactions.
  // Each alignment row's bible_text tells us which canonical words appear on that ALTO line.
  // We find where each row's first word sits in the canonical verse array (with a small
  // look-back to handle the 1-word overlap between consecutive rows), then zip positionally.
  const altoToCanon = new Map();
  sortedVerses.forEach((verse) => {
    verse.wordAltoIds = new Array(verse.words.length).fill(null);
    const canonNorm = verse.words.map(normalizeHebrew);
    let cursor = 0;

    verse.rows.forEach((row) => {
      const line = lineMap.get(row.line_id);
      if (!line) return;
      const rowWords = splitWords(row.bible_text || "");
      if (!rowWords.length) return;

      const firstNorm = normalizeHebrew(rowWords[0]);
      let start = cursor;
      const searchFrom = Math.max(0, cursor - 2);
      for (let i = searchFrom; i < canonNorm.length; i++) {
        if (canonNorm[i] === firstNorm) { start = i; break; }
      }

      const count = Math.min(rowWords.length, line.words.length);
      for (let i = 0; i < count; i++) {
        const canonIdx = start + i;
        if (canonIdx >= verse.words.length) break;
        if (verse.wordAltoIds[canonIdx] === null) {
          verse.wordAltoIds[canonIdx] = line.words[i];
          altoToCanon.set(line.words[i].id, { verseKey: verse.key, wordIdx: canonIdx });
        }
      }
      cursor = start + rowWords.length;
    });
  });

  // Build flat chapters list (for navigation selectors) and nested books list (for display)
  const chaptersMap = new Map();
  const booksMap = new Map();

  sortedVerses.forEach((verse) => {
    if (!chaptersMap.has(verse.chapter)) {
      chaptersMap.set(verse.chapter, []);
    }
    chaptersMap.get(verse.chapter).push(verse);

    if (!booksMap.has(verse.book)) {
      booksMap.set(verse.book, new Map());
    }
    const bookChapters = booksMap.get(verse.book);
    if (!bookChapters.has(verse.chapter)) {
      bookChapters.set(verse.chapter, []);
    }
    bookChapters.get(verse.chapter).push(verse);
  });

  const chapterList = [...chaptersMap.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([chapter, items]) => ({ chapter, verses: items }));

  const bookList = [...booksMap.entries()].map(([book, bookChaptersMap]) => ({
    book,
    chapters: [...bookChaptersMap.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([chapter, items]) => ({ chapter, verses: items }))
  }));

  const firstVerse = sortedVerses[0];

  return {
    page,
    alto,
    books: bookList,
    chapters: chapterList,
    verses: sortedVerses,
    wordToVerse,
    altoToCanon,
    words: sortedVerses.flatMap((verse) => verse.altoWords),
    book: firstVerse ? firstVerse.book : "",
    chapterCount: chapterList.length,
    verseCount: sortedVerses.length
  };
}



function renderPage(model) {
  const { page, alto, books, words } = model;
  els.bookTitle.textContent = `${model.book || "ספר לא מזוהה"} | עמוד ${page.folio}`;

  els.image.src = getImageSrc(page.image_file);
  els.image.alt = `עמוד ${page.folio}`;

  els.overlay.setAttribute("viewBox", `0 0 ${alto.width} ${alto.height}`);
  els.overlay.setAttribute("preserveAspectRatio", "none");
  els.overlay.innerHTML = "";
  syncOverlayToImage();

  words.forEach((word) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(word.x));
    rect.setAttribute("y", String(word.y));
    rect.setAttribute("width", String(word.width));
    rect.setAttribute("height", String(word.height));
    rect.setAttribute("rx", "8");
    rect.setAttribute("ry", "8");
    rect.dataset.wordId = word.id;
    rect.dataset.verseKey = model.wordToVerse.get(word.id) || "";
    rect.classList.add("word-box");
    rect.addEventListener("click", () => selectWord(word.id));
    els.overlay.appendChild(rect);
  });

  els.hierarchy.innerHTML = "";
  books.forEach((bookData) => {
    const bookEl = document.createElement("section");
    bookEl.className = "book";

    const bookTitle = document.createElement("h2");
    bookTitle.className = "book-title";
    bookTitle.textContent = bookData.book;
    bookEl.appendChild(bookTitle);

    bookData.chapters.forEach((chapterData) => {
      const chapterEl = document.createElement("section");
      chapterEl.className = "chapter";

      const title = document.createElement("h3");
      title.className = "chapter-title";
      title.textContent = `פרק ${chapterData.chapter}`;
      chapterEl.appendChild(title);

      chapterData.verses.forEach((verse) => {
      const row = document.createElement("div");
      row.className = "verse-row";
      row.dataset.verseKey = verse.key;

      const verseBtn = document.createElement("button");
      verseBtn.type = "button";
      verseBtn.className = "verse-number";
      verseBtn.dataset.verseKey = verse.key;
      verseBtn.textContent = verse.verse;
      verseBtn.addEventListener("click", () => selectVerse(verse.key, true));
      row.appendChild(verseBtn);

      const wordsWrap = document.createElement("span");
      verse.words.forEach((word, i) => {
        const wordBtn = document.createElement("button");
        wordBtn.type = "button";
        wordBtn.className = "text-word";
        wordBtn.dataset.verseKey = verse.key;
        wordBtn.dataset.wordIdx = String(i);
        wordBtn.dataset.raw = word;
        wordBtn.textContent = filterText(word);
        wordBtn.addEventListener("click", () => selectCanonWord(verse.key, i));
        wordsWrap.appendChild(wordBtn);
      });

        row.appendChild(wordsWrap);
        chapterEl.appendChild(row);
      });

      bookEl.appendChild(chapterEl);
    });

    els.hierarchy.appendChild(bookEl);
  });
}

function syncOverlayToImage() {
  const w = els.image.clientWidth;
  const h = els.image.clientHeight;
  if (!w || !h) {
    return;
  }

  els.overlay.style.width = `${w}px`;
  els.overlay.style.height = `${h}px`;
}

function buildDriveDirectUrl(fileId) {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&authuser=0`;
}

function getImageSrc(imageName) {
  if (state.sourceMode === "fetch") {
    // If we have a pre-built Drive image ID manifest, load the image directly
    // from Google Drive — no API key needed at runtime.
    if (state.driveImageIds.has(imageName)) {
      return buildDriveDirectUrl(state.driveImageIds.get(imageName));
    }
    return `${DATA_DIR}/${imageName}`;
  }

  if (state.sourceMode === "drive") {
    const entry = state.driveFiles.get(imageName);
    if (!entry) {
      throw new Error(`קובץ תמונה לא זמין: ${imageName}`);
    }
    return buildDriveMediaUrl(entry.id, state.driveApiKey);
  }

  const file = state.localFiles.get(imageName);
  if (!file) {
    throw new Error(`קובץ תמונה לא זמין: ${imageName}`);
  }

  if (!state.imageUrlCache.has(imageName)) {
    state.imageUrlCache.set(imageName, URL.createObjectURL(file));
  }

  return state.imageUrlCache.get(imageName);
}

function revokeImageUrls() {
  state.imageUrlCache.forEach((url) => URL.revokeObjectURL(url));
  state.imageUrlCache.clear();
}

function selectWord(wordId) {
  const model = state.currentPageModel;
  if (!model) return;

  const verseKeyVal = model.wordToVerse.get(wordId) || null;
  const mapping = model.altoToCanon ? model.altoToCanon.get(wordId) : null;

  state.selectedVerseKey = verseKeyVal;
  state.selectedWordId = wordId;
  state.selectedCanonWordIdx = mapping ? mapping.wordIdx : null;

  syncSelectorsToSelectedVerse();
  applyHighlights();

  // Scroll the matching text word into view
  if (mapping) {
    const textWord = document.querySelector(
      `.text-word[data-verse-key="${cssEscape(mapping.verseKey)}"][data-word-idx="${mapping.wordIdx}"]`
    );
    if (textWord) textWord.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function selectCanonWord(verseKeyVal, wordIdx) {
  const model = state.currentPageModel;
  if (!model) return;

  const verse = model.verses.find((v) => v.key === verseKeyVal);
  const altoWord = verse && verse.wordAltoIds ? verse.wordAltoIds[wordIdx] : null;

  state.selectedVerseKey = verseKeyVal;
  state.selectedWordId = altoWord ? altoWord.id : null;
  state.selectedCanonWordIdx = wordIdx;

  syncSelectorsToSelectedVerse();
  applyHighlights();

  // Scroll the matching ALTO rect into view on the image
  if (altoWord) {
    const rect = document.querySelector(`.word-box[data-word-id="${cssEscape(altoWord.id)}"]`);
    if (rect) rect.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
}

function selectVerse(verseKeyValue, scrollToImage) {
  state.selectedVerseKey = verseKeyValue;
  state.selectedWordId = null;
  state.selectedCanonWordIdx = null;
  syncSelectorsToSelectedVerse();
  applyHighlights();

  const verseRow = document.querySelector(`.verse-row[data-verse-key="${cssEscape(verseKeyValue)}"]`);
  if (verseRow) {
    verseRow.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (scrollToImage) {
    const firstRect = document.querySelector(`.word-box[data-verse-key="${cssEscape(verseKeyValue)}"]`);
    if (firstRect) {
      firstRect.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }
  }
}

function syncSelectorsToSelectedVerse() {
  if (!state.selectedVerseKey || !state.currentPageModel) {
    return;
  }

  const verse = state.currentPageModel.verses.find((item) => item.key === state.selectedVerseKey);
  if (!verse) {
    return;
  }

  els.bookSelect.value = verse.book;
  els.chapterSelect.value = verse.chapter;
  fillVerseSelectForChapter(verse.chapter);
  els.verseSelect.value = verse.key;
}

function renderVerseHighlight(activeVerseKey) {
  const existing = document.getElementById("verse-highlight-layer");
  if (existing) {
    existing.remove();
  }

  if (!activeVerseKey || !state.currentPageModel) {
    return;
  }

  const verse = state.currentPageModel.verses.find((item) => item.key === activeVerseKey);
  if (!verse || !verse.altoWords.length) {
    return;
  }

  const sortedWords = [...verse.altoWords].sort((a, b) => a.y - b.y || a.x - b.x);
  const avgHeight = sortedWords.reduce((acc, word) => acc + word.height, 0) / sortedWords.length;
  const threshold = Math.max(22, avgHeight * 0.95);
  const rowGroups = [];

  sortedWords.forEach((word) => {
    const centerY = word.y + word.height / 2;
    const hit = rowGroups.find((group) => Math.abs(group.centerY - centerY) < threshold);

    if (!hit) {
      rowGroups.push({ centerY, words: [word] });
      return;
    }

    const n = hit.words.length;
    hit.centerY = (hit.centerY * n + centerY) / (n + 1);
    hit.words.push(word);
  });

  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.id = "verse-highlight-layer";

  rowGroups.forEach((group) => {
    const minX = Math.min(...group.words.map((word) => word.x)) - 9;
    const minY = Math.min(...group.words.map((word) => word.y)) - 5;
    const maxX = Math.max(...group.words.map((word) => word.x + word.width)) + 9;
    const maxY = Math.max(...group.words.map((word) => word.y + word.height)) + 5;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(minX));
    rect.setAttribute("y", String(minY));
    rect.setAttribute("width", String(maxX - minX));
    rect.setAttribute("height", String(maxY - minY));
    rect.setAttribute("rx", "13");
    rect.setAttribute("ry", "13");
    rect.classList.add("verse-line-highlight");
    layer.appendChild(rect);
  });

  els.overlay.insertBefore(layer, els.overlay.firstChild);
}

function applyHighlights() {
  document.querySelectorAll(".is-verse-active").forEach((el) => el.classList.remove("is-verse-active"));
  document.querySelectorAll(".is-word-active").forEach((el) => el.classList.remove("is-word-active"));

  if (state.selectedVerseKey) {
    const vk = cssEscape(state.selectedVerseKey);
    // Highlight each word button of the verse (tight per-word bg, not the full row)
    document
      .querySelectorAll(`.text-word[data-verse-key="${vk}"], .verse-number[data-verse-key="${vk}"]`)
      .forEach((el) => el.classList.add("is-verse-active"));
    renderVerseHighlight(state.selectedVerseKey);
  }

  // Word-level: highlight the specific ALTO rect on the image
  if (state.selectedWordId) {
    document
      .querySelectorAll(`.word-box[data-word-id="${cssEscape(state.selectedWordId)}"]`)
      .forEach((el) => el.classList.add("is-word-active"));
  }

  // Word-level: highlight the specific canonical word button in the text panel
  if (state.selectedVerseKey !== null && state.selectedCanonWordIdx !== null) {
    const vk = cssEscape(state.selectedVerseKey);
    document
      .querySelectorAll(`.text-word[data-verse-key="${vk}"][data-word-idx="${state.selectedCanonWordIdx}"]`)
      .forEach((el) => el.classList.add("is-word-active"));
  }
}

// Collect all unique book names present in alignment rows
function collectBookNames(rows) {
  const books = new Set();
  rows.forEach((row) => { if (row.book) books.add(row.book); });
  return [...books];
}

// Strip any leading directory path (e.g. "HTR_Altos\") from alto_file values in-place
function normalizeAlignmentRows(rows) {
  rows.forEach((row) => {
    if (row.alto_file) {
      row.alto_file = row.alto_file.replace(/^.*[/\\]/, "");
    }
  });
}

function buildAlignmentIndex(rows) {
  const byFile = new Map();
  rows.forEach((row) => {
    if (!byFile.has(row.alto_file)) {
      byFile.set(row.alto_file, []);
    }
    byFile.get(row.alto_file).push(row);
  });
  return byFile;
}

function inferPagesFromAlignment(alignmentRows) {
  const byBase = new Map();

  alignmentRows.forEach((row) => {
    const base = row.alto_file;
    if (!base || byBase.has(base)) {
      return;
    }

    const folio = extractFolio(base);
    if (!folio) {
      return;
    }

    byBase.set(base, {
      folio,
      alto_base_file: base,
      alto_file: base.replace(/\.xml$/i, "_with_bible_text.xml"),
      image_file: base.replace(/\.xml$/i, ".jpg")
    });
  });

  return [...byBase.values()];
}

function extractFolio(fileName) {
  const match = /_(\d+[rv])_/i.exec(fileName || "");
  return match ? match[1].toLowerCase() : "";
}

function normalizePage(page) {
  const base = page.alto_base_file || "";
  const folio = page.folio || extractFolio(base) || extractFolio(page.alto_file || "");
  const altoBase = base || (page.alto_file || "").replace(/_with_bible_text\.xml$/i, ".xml");
  const altoFile = page.alto_file || `${altoBase.replace(/\.xml$/i, "")}_with_bible_text.xml`;
  const imageFile = page.image_file || altoBase.replace(/\.xml$/i, ".jpg");

  return {
    folio,
    alto_base_file: altoBase,
    alto_file: altoFile,
    image_file: imageFile
  };
}

function verseKey(book, chapter, verse) {
  return `${book}|${chapter}|${verse}`;
}

function byTag(root, localName) {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

function firstByTag(root, localName) {
  const node = byTag(root, localName)[0];
  if (!node) {
    throw new Error(`תגית חסרה ב-XML: ${localName}`);
  }
  return node;
}

function normalizeWord(value) {
  if (!value) {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function isDecorative(word) {
  if (/^\u27e6.*\u27e7$/u.test(word)) {
    return true;
  }
  return !/[\p{L}\p{M}\u05be]/u.test(word);
}

function numAttr(node, attr) {
  const value = Number(node.getAttribute(attr));
  return Number.isFinite(value) ? value : 0;
}

function pageSortKey(folio) {
  const match = /^(\d+)([rv])$/i.exec(folio || "");
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }

  const num = Number(match[1]);
  const side = match[2].toLowerCase() === "r" ? 0 : 1;
  return num * 2 + side;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function toggleControls(disabled) {
  [
    els.prevBtn,
    els.nextBtn,
    els.pageSelect,
    els.searchPrevBtn,
    els.searchNextBtn,
    els.goVerseBtn,
    els.pickFolderBtn,
    els.loadDriveBtn,
    els.driveFolderInput,
    els.driveApiKeyInput
  ].forEach((el) => {
    if (!el) return;
    el.disabled = disabled;
  });

  if (!disabled && state.pages.length) {
    els.prevBtn.disabled = state.currentPageIndex >= state.pages.length - 1;
    els.nextBtn.disabled = state.currentPageIndex <= 0;
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`לא ניתן לטעון: ${path}`);
  }
  return response.json();
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`לא ניתן לטעון: ${path}`);
  }
  return response.text();
}

function extractDriveFolderId(input) {
  if (!input) return "";
  const fromUrl = /\/folders\/([a-zA-Z0-9_-]+)/.exec(input);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  return "";
}

function buildDriveMediaUrl(fileId, apiKey) {
  return `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
}

async function listDriveFilesRecursive(folderId, apiKey) {
  const byName = new Map();
  const folderQueue = [folderId];
  const seenFolders = new Set();

  while (folderQueue.length) {
    const currentFolder = folderQueue.shift();
    if (!currentFolder || seenFolders.has(currentFolder)) {
      continue;
    }
    seenFolders.add(currentFolder);

    let pageToken = "";
    do {
      const q = `'${currentFolder}' in parents and trashed = false`;
      const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType)")}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${encodeURIComponent(apiKey)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Google Drive API נכשל (${response.status})`);
      }

      const data = await response.json();
      const files = Array.isArray(data.files) ? data.files : [];
      files.forEach((item) => {
        if (item.mimeType === "application/vnd.google-apps.folder") {
          folderQueue.push(item.id);
          return;
        }

        // Keep first file per name to match local-folder naming logic.
        if (!byName.has(item.name)) {
          byName.set(item.name, item);
        }
      });

      pageToken = data.nextPageToken || "";
    } while (pageToken);
  }

  return byName;
}

async function getDriveText(fileName) {
  const entry = state.driveFiles.get(fileName);
  if (!entry) {
    throw new Error(`קובץ לא זמין בתיקיית Drive: ${fileName}`);
  }

  const response = await fetch(buildDriveMediaUrl(entry.id, state.driveApiKey));
  if (!response.ok) {
    throw new Error(`לא ניתן לקרוא קובץ מתיקיית Drive: ${fileName}`);
  }

  return response.text();
}

function parseCanonicalXml(xmlText, bookName, targetMap) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const map = targetMap || new Map();

  byTag(doc, "c").forEach((cEl) => {
    const ch = cEl.getAttribute("n");
    if (!ch) return;

    byTag(cEl, "v").forEach((vEl) => {
      if (vEl.parentNode !== cEl) return;
      const ve = vEl.getAttribute("n");
      if (!ve) return;

      const words = byTag(vEl, "w")
        .map((w) => w.textContent.trim())
        .filter(Boolean);

      if (words.length) {
        map.set(verseKey(bookName, ch, ve), words);
      }
    });
  });

  return map;
}

function setStatus(text) {
  els.status.textContent = text;
}
