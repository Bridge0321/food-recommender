const form = document.querySelector("#filter-form");
const resetButton = document.querySelector("#reset-button");
const topPick = document.querySelector("#top-pick");
const mapPanel = document.querySelector("#map-panel");
const comparisonPanel = document.querySelector("#comparison-panel");
const swipeDeck = document.querySelector("#swipe-deck");
const swipeActions = document.querySelector("#swipe-actions");
const swipeHint = document.querySelector("#swipe-hint");
const skipButton = document.querySelector("#skip-button");
const starButton = document.querySelector("#star-button");
const chooseButton = document.querySelector("#choose-button");
const shortlistButton = document.querySelector("#shortlist-button");
const shortlistCount = document.querySelector("#shortlist-count");
const shortlistPanel = document.querySelector("#shortlist-panel");
const settingsButton = document.querySelector("#settings-button");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const travelTimeInput = document.querySelector("#travel-time");
const budgetInput = document.querySelector("#budget");
const travelTimeValue = document.querySelector("#travel-time-value");
const budgetValue = document.querySelector("#budget-value");
const locationButton = document.querySelector("#location-button");
const travelStatus = document.querySelector("#travel-status");
const resultsTitle = document.querySelector("#results-title");
const resultCount = document.querySelector("#result-count");
let selectedRestaurantName = null;
let currentPosition = null;
let skippedRestaurantNames = new Set();
let starredRestaurantNames = new Set();
let currentBatchIndex = 0;
const batchSize = 10;
let currentSearchRadiusMeters = 5000;
const expandedSearchRadiusMeters = 8000;
const photoIndexByRestaurant = new Map();

function setTravelStatus(message, isError = false) {
  travelStatus.textContent = message;
  travelStatus.classList.toggle("is-error", isError);
}

function loadGoogleMaps() {
  const apiKey = window.APP_CONFIG?.googleMapsApiKey;
  if (!apiKey) return Promise.reject(new Error("請先在 config.js 設定 Google Maps API key。"));
  if (window.google?.maps?.importLibrary) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=beta`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Maps 載入失敗，請確認 API key 與網域限制。"));
    document.head.append(script);
  });
}

function formatMinutes(durationMillis) {
  return Math.max(1, Math.round(durationMillis / 60000));
}

const categoryTypes = {
  "中式": ["chinese_restaurant", "taiwanese_restaurant", "asian_restaurant", "noodle_shop"],
  "西式": ["western_restaurant", "italian_restaurant", "american_restaurant", "european_restaurant", "pizza_restaurant", "steak_house"],
  "日式": ["japanese_restaurant", "ramen_restaurant", "sushi_restaurant", "japanese_izakaya_restaurant", "japanese_curry_restaurant"],
  "韓式": ["korean_restaurant", "korean_barbecue_restaurant", "barbecue_restaurant"],
  "泰式": ["thai_restaurant"],
  "越式": ["vietnamese_restaurant"],
  "速食": ["fast_food_restaurant", "hamburger_restaurant", "chicken_restaurant"],
  "甜點": ["dessert_restaurant", "dessert_shop", "cake_shop"]
};

function priceFromGoogle(priceLevel) {
  const prices = { FREE: 0, INEXPENSIVE: 150, MODERATE: 300, EXPENSIVE: 500, VERY_EXPENSIVE: 800 };
  return prices[priceLevel] ?? 300;
}

async function searchNearbyRestaurants(position) {
  await loadGoogleMaps();
  const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary("places");
  const filters = getFilters();
  const category = filters.category === "all" ? "不限" : filters.category;
  // 先從 5 公里搜尋；看完後才擴大範圍，避免一開始推薦太遠。
  const radius = currentSearchRadiusMeters;
  const request = {
    fields: ["displayName", "formattedAddress", "location", "rating", "priceLevel", "primaryType", "googleMapsURI", "currentOpeningHours", "photos"],
    locationRestriction: { center: { lat: position.coords.latitude, lng: position.coords.longitude }, radius },
    includedTypes: categoryTypes[filters.category] ?? ["restaurant"],
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference.POPULARITY,
    language: "zh-TW",
    region: "tw"
  };
  let { places } = await Place.searchNearby(request);
  let usedCategoryFallback = false;

  // Google 店家類型不一定標記得完整；細分類沒有結果時，不讓使用者看到空白畫面。
  if (!places.length && filters.category !== "all") {
    request.includedTypes = ["restaurant"];
    ({ places } = await Place.searchNearby(request));
    usedCategoryFallback = true;
  }
  const realRestaurants = await Promise.all(places.map(async (place) => {
    const isOpen = typeof place.isOpen === "function" ? await place.isOpen() : true;
    const photos = (place.photos ?? []).slice(0, 5).map((photo) => ({
      url: typeof photo.getURI === "function" ? photo.getURI({ maxHeight: 900, maxWidth: 900 }) : null,
      attributions: photo.authorAttributions ?? []
    })).filter((photo) => photo.url);
    return {
      name: typeof place.displayName === "string" ? place.displayName : place.displayName?.text ?? "未命名餐廳",
      category,
      foodType: place.primaryType ?? "restaurant",
      price: priceFromGoogle(place.priceLevel),
      yearsOpen: 0,
      isGooglePlace: true,
      rating: place.rating ?? 0,
      isOpen: isOpen ?? true,
      emoji: "🍽️",
      address: place.formattedAddress ?? "地址未提供",
      location: place.location,
      googleMapsURI: place.googleMapsURI,
      imageUrl: photos[0]?.url ?? null,
      photoAttributions: photos[0]?.attributions ?? [],
      photos,
      travelMinutes: { drive: 0, bike: 0, walk: 0 }
    };
  }));
  if (!realRestaurants.length) throw new Error("附近找不到符合條件的餐廳，請放寬篩選條件後再試。"
  );
  restaurants.splice(0, restaurants.length, ...realRestaurants);
  currentBatchIndex = 0;
  return usedCategoryFallback;
}

async function updateTravelTimes(position) {
  await loadGoogleMaps();
  const [{ RouteMatrix }, { UnitSystem }] = await Promise.all([
    google.maps.importLibrary("routes"),
    google.maps.importLibrary("core")
  ]);
  const origin = { lat: position.coords.latitude, lng: position.coords.longitude };
  const destinations = restaurants.map((restaurant) => restaurant.location ?? restaurant.address);
  const modes = [
    ["DRIVING", "drive"],
    ["TWO_WHEELER", "bike"],
    ["WALKING", "walk"]
  ];

  for (const [travelMode, property] of modes) {
    const { matrix } = await RouteMatrix.computeRouteMatrix({
      origins: [origin],
      destinations,
      travelMode,
      units: UnitSystem.METRIC,
      language: "zh-TW",
      region: "tw",
      fields: ["durationMillis", "distanceMeters", "condition"]
    });

    matrix.rows[0].items.forEach((item, index) => {
      if (item.condition === "ROUTE_EXISTS" && item.durationMillis) {
        restaurants[index].travelMinutes[property] = formatMinutes(item.durationMillis);
      }
    });
  }
}

function getFilters() {
  const data = new FormData(form);
  return {
    category: data.get("category"),
    budget: Number(data.get("budget")),
    travelTime: Number(data.get("travelTime")),
    openNow: data.get("openNow") === "on"
  };
}

function matchesBudget(price, budget) {
  return price <= budget;
}

function fastestTravelMinutes(restaurant) {
  const times = Object.values(restaurant.travelMinutes).filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  return times.length ? Math.min(...times) : 99;
}

function travelTimeSummary(restaurant) {
  const format = (minutes) => (Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分` : "—");
  return `🚗 ${format(restaurant.travelMinutes.drive)} · 🛵 ${format(restaurant.travelMinutes.bike)} · 🚶 ${format(restaurant.travelMinutes.walk)}`;
}

function restaurantImage(restaurant, className = "restaurant-thumbnail") {
  return restaurant.imageUrl
    ? `<img class="${className}" src="${restaurant.imageUrl}" alt="${restaurant.name} 的餐點或店面照片" />`
    : `<div class="${className} photo-fallback" aria-hidden="true">${restaurant.emoji}</div>`;
}

function getRestaurantPhotos(restaurant) {
  if (restaurant.photos?.length) return restaurant.photos;
  if (restaurant.imageUrl) return [{ url: restaurant.imageUrl, attributions: restaurant.photoAttributions ?? [] }];
  return [];
}

function renderPhotoAttribution(attributions) {
  if (!attributions?.length) return "";
  return `<span class="photo-attribution">${attributions.map((attribution) => `<a href="${attribution.uri}" target="_blank" rel="noreferrer">${attribution.displayName}</a>`).join(" · ")}</span>`;
}

function scoreRestaurant(restaurant, filters) {
  let score = 0;
  score += Math.max(0, 40 - fastestTravelMinutes(restaurant) * 2);
  score += restaurant.rating * 3;
  if (restaurant.isOpen) score += 25;
  if (filters.category !== "all" && restaurant.category === filters.category) score += 10;
  if (matchesBudget(restaurant.price, filters.budget)) score += 10;
  return Math.round(score);
}

function filterAndRank() {
  const filters = getFilters();
  return restaurants
    .filter((restaurant) => filters.category === "all" || restaurant.category === filters.category)
    .filter((restaurant) => matchesBudget(restaurant.price, filters.budget))
    .filter((restaurant) => fastestTravelMinutes(restaurant) <= filters.travelTime)
    .filter((restaurant) => !filters.openNow || restaurant.isOpen)
    .map((restaurant) => ({ ...restaurant, score: scoreRestaurant(restaurant, filters) }))
    .sort((a, b) => b.score - a.score);
}

function renderTopPick(restaurant) {
  topPick.hidden = false;
  topPick.innerHTML = `
    <div class="top-pick-label">♥ 你選定了</div>
    <div class="top-pick-content">
      <span class="top-pick-emoji">${restaurant.emoji}</span>
      <div>
        <h3>${restaurant.name}</h3>
        <p>★ ${restaurant.rating} · 約 ${restaurant.price} 元／人 · ${travelTimeSummary(restaurant)}</p>
        <a class="map-link" href="${restaurant.googleMapsURI ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${restaurant.name} ${restaurant.address}`)}`}" target="_blank" rel="noreferrer">在 Google Maps 開啟 ↗</a>
      </div>
    </div>`;
}

function renderMap(restaurant) {
  const query = encodeURIComponent(`${restaurant.name} ${restaurant.address}`);
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${query}`;
  const apiKey = window.APP_CONFIG?.googleMapsApiKey;

  if (!apiKey) {
    mapPanel.innerHTML = `<div class="map-placeholder"><span>🗺️</span><div><strong>Google 地圖預覽</strong><p>設定 API key 後會在這裡顯示地圖。</p></div><a href="${mapsLink}" target="_blank" rel="noreferrer">開啟地圖 ↗</a></div>`;
    return;
  }

  mapPanel.innerHTML = `<iframe title="${restaurant.name} 的 Google 地圖" src="https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(apiKey)}&q=${query}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>`;
}

function renderComparison() {
  const selected = restaurants.find((restaurant) => restaurant.name === selectedRestaurantName);

  if (!selected) {
    comparisonPanel.hidden = true;
    comparisonPanel.replaceChildren();
    return;
  }

  const similarRestaurants = restaurants
    .filter((restaurant) => restaurant.foodType === selected.foodType && restaurant.name !== selected.name)
    .sort((a, b) => b.rating - a.rating);

  comparisonPanel.hidden = false;
  comparisonPanel.innerHTML = `
    <div class="comparison-heading">
      <div>
        <p class="section-kicker">同類型比較</p>
        <h3>${selected.foodType}：還可以考慮這些店</h3>
      </div>
      <span class="comparison-count">${similarRestaurants.length} 間</span>
    </div>
    <p class="comparison-note">已自動辨識「${selected.name}」屬於 ${selected.foodType}。</p>
    <div class="comparison-list">
      ${similarRestaurants.length ? similarRestaurants.map((restaurant) => `
        <article class="comparison-card">
          ${restaurantImage(restaurant, "comparison-image")}
          <div><strong>${restaurant.name}</strong><p>★ ${restaurant.rating} · ${restaurant.price} 元 · ${travelTimeSummary(restaurant)}</p></div>
        </article>`).join("") : '<p class="empty-state">目前資料中還沒有其他同類餐廳。</p>'}
    </div>`;
}

function renderShortlist() {
  const starred = restaurants.filter((restaurant) => starredRestaurantNames.has(restaurant.name));
  shortlistCount.textContent = starred.length;
  shortlistButton.classList.toggle("has-items", starred.length > 0);

  if (shortlistPanel.hidden) return;
  shortlistPanel.innerHTML = `
    <div class="comparison-heading"><div><p class="section-kicker">待選清單</p><h3>再比較一下</h3></div><button id="close-shortlist" class="text-button" type="button">關閉</button></div>
    <div class="shortlist-grid">${starred.length ? starred.map((restaurant) => `
      <article class="shortlist-card">
        ${restaurantImage(restaurant, "shortlist-image")}
        <div><strong>${restaurant.name}</strong><p>★ ${restaurant.rating} · 約 ${restaurant.price} 元／人</p>
        <button class="shortlist-choose" type="button" data-restaurant-name="${restaurant.name}">選這間</button></div>
      </article>`).join("") : '<p class="empty-state">還沒有待選餐廳，看到喜歡的就按 ☆ 收藏。</p>'}</div>`;
}

function renderResults() {
  const ranked = filterAndRank();
  const selected = ranked.find((restaurant) => restaurant.name === selectedRestaurantName);
  const batchStart = currentBatchIndex * batchSize;
  const currentBatch = ranked.slice(batchStart, batchStart + batchSize);
  const remaining = currentBatch.filter((restaurant) => !skippedRestaurantNames.has(restaurant.name));
  renderShortlist();
  resultCount.textContent = `${remaining.length}／${currentBatch.length} 間待挑選`;

  if (!ranked.length) {
    topPick.hidden = true;
    swipeDeck.replaceChildren();
    swipeActions.hidden = true;
    swipeHint.hidden = true;
    mapPanel.replaceChildren();
    renderComparison();
    resultsTitle.textContent = "找不到符合的餐廳";
    swipeDeck.innerHTML = '<p class="empty-state">試著放寬到店時間、預算或營業年數的條件吧。</p>';
    return;
  }

  if (selected) {
    resultsTitle.textContent = "晚餐決定了！";
    resultCount.textContent = "已選定 1 間";
    swipeDeck.replaceChildren();
    swipeActions.hidden = true;
    swipeHint.hidden = true;
    renderTopPick(selected);
    renderMap(selected);
    renderComparison();
    return;
  }

  if (!remaining.length) {
    const hasNextBatch = ranked.length > batchStart + batchSize;
    const canExpandSearch = currentPosition && currentSearchRadiusMeters < expandedSearchRadiusMeters;
    topPick.hidden = true;
    swipeDeck.innerHTML = `
      <div class="next-batch-state">
        <span aria-hidden="true">↻</span>
        <h3>${hasNextBatch ? "這一輪看完了" : canExpandSearch ? "5 公里內都看完了" : "附近沒有新的餐廳了"}</h3>
        <p>${hasNextBatch ? "下一批不會出現剛看過的餐廳。" : canExpandSearch ? "擴大到 8 公里，繼續找沒看過的店。" : "調整設定或移動位置後，再搜尋新的店家。"}</p>
        ${hasNextBatch ? '<button class="next-batch-button" type="button" data-action="next-batch">下一批推薦</button>' : canExpandSearch ? '<button class="next-batch-button" type="button" data-action="expand-search">擴大範圍找新餐廳</button>' : ""}
      </div>`;
    swipeActions.hidden = true;
    swipeHint.hidden = true;
    mapPanel.replaceChildren();
    comparisonPanel.hidden = true;
    comparisonPanel.replaceChildren();
    resultsTitle.textContent = "沒有更多候選餐廳";
    return;
  }

  const restaurant = remaining[0];
  topPick.hidden = true;
  mapPanel.replaceChildren();
  comparisonPanel.hidden = true;
  comparisonPanel.replaceChildren();
  const photos = getRestaurantPhotos(restaurant);
  const photoIndex = Math.min(photoIndexByRestaurant.get(restaurant.name) ?? 0, Math.max(photos.length - 1, 0));
  const activePhoto = photos[photoIndex];
  const visual = activePhoto
    ? `<div class="photo-carousel"><img src="${activePhoto.url}" alt="${restaurant.name} 的照片，第 ${photoIndex + 1} 張，共 ${photos.length} 張" />${renderPhotoAttribution(activePhoto.attributions)}${photos.length > 1 ? `<button class="photo-control previous-photo" type="button" data-photo-direction="previous" aria-label="上一張照片">‹</button><button class="photo-control next-photo" type="button" data-photo-direction="next" aria-label="下一張照片">›</button><div class="photo-dots" aria-label="照片 ${photoIndex + 1}／${photos.length}">${photos.map((_, index) => `<span class="${index === photoIndex ? "is-active" : ""}"></span>`).join("")}</div>` : ""}</div>`
    : `<div class="photo-fallback" aria-hidden="true">${restaurant.emoji}</div>`;
  swipeDeck.innerHTML = `
    <article class="swipe-card" tabindex="0" aria-label="${restaurant.name}，可向左略過、向右選定">
      <div class="restaurant-visual">${visual}<span class="status ${restaurant.isOpen ? "open" : "closed"}">${restaurant.isOpen ? "營業中" : "休息中"}</span></div>
      <div class="swipe-card-body"><p class="section-kicker">下一間候選</p><h3>${restaurant.name}</h3>
      <p class="swipe-meta">${restaurant.category} · 約 ${restaurant.price} 元／人 · ★ ${restaurant.rating}</p>
      <p class="swipe-reason">${travelTimeSummary(restaurant)}，符合你的設定。</p></div>
      <div class="swipe-labels"><span class="swipe-nope">略過</span><span class="swipe-like">選這間</span></div>
    </article>`;
  swipeActions.hidden = false;
  swipeHint.hidden = false;
  resultsTitle.textContent = "這間怎麼樣？";
  setupSwipeGesture(swipeDeck.querySelector(".swipe-card"), restaurant.name);
}

function skipRestaurant(name) {
  skippedRestaurantNames.add(name);
  renderResults();
}

function starRestaurant(name) {
  starredRestaurantNames.add(name);
  skippedRestaurantNames.add(name);
  renderResults();
}

function chooseRestaurant(name) {
  selectedRestaurantName = name;
  renderResults();
}

function startNextBatch() {
  const ranked = filterAndRank();
  if ((currentBatchIndex + 1) * batchSize >= ranked.length) return;
  currentBatchIndex += 1;
  renderResults();
}

async function expandSearchRadius() {
  if (!currentPosition || currentSearchRadiusMeters >= expandedSearchRadiusMeters) return;
  currentSearchRadiusMeters = expandedSearchRadiusMeters;
  await refreshNearbyResults();
}

function setupSwipeGesture(card, restaurantName) {
  let startX = null;
  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".photo-carousel")) return;
    startX = event.clientX;
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener("pointermove", (event) => {
    if (startX === null) return;
    const deltaX = event.clientX - startX;
    card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 20}deg)`;
    card.classList.toggle("is-skipping", deltaX < -35);
    card.classList.toggle("is-choosing", deltaX > 35);
  });
  card.addEventListener("pointerup", (event) => {
    if (startX === null) return;
    const deltaX = event.clientX - startX;
    startX = null;
    if (deltaX < -80) skipRestaurant(restaurantName);
    else if (deltaX > 80) chooseRestaurant(restaurantName);
    else {
      card.style.transform = "";
      card.classList.remove("is-skipping", "is-choosing");
    }
  });
  card.addEventListener("pointercancel", () => {
    startX = null;
    card.style.transform = "";
    card.classList.remove("is-skipping", "is-choosing");
  });
}

function syncRangeLabels() {
  travelTimeValue.textContent = Number(travelTimeInput.value) === 60 ? "不設上限" : `${travelTimeInput.value} 分鐘內`;
  budgetValue.textContent = Number(budgetInput.value) === 1000 ? "不設上限" : `${budgetInput.value} 元以下`;
}

function setSettingsOpen(isOpen) {
  form.hidden = !isOpen;
  settingsBackdrop.hidden = !isOpen;
  settingsButton.setAttribute("aria-expanded", String(isOpen));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  selectedRestaurantName = null;
  skippedRestaurantNames = new Set();
  starredRestaurantNames = new Set();
  currentBatchIndex = 0;
  setSettingsOpen(false);
  renderResults();
});

form.addEventListener("change", async (event) => {
  selectedRestaurantName = null;
  skippedRestaurantNames = new Set();
  currentBatchIndex = 0;
  // 餐廳種類會改變 Google Nearby Search 的請求，因此需要重新查詢。
  if (currentPosition && event.target.name === "category") {
    currentSearchRadiusMeters = 5000;
    await refreshNearbyResults();
    return;
  }
  renderResults();
});
skipButton.addEventListener("click", () => {
  const [restaurant] = filterAndRank().filter((item) => !skippedRestaurantNames.has(item.name));
  if (restaurant) skipRestaurant(restaurant.name);
});
chooseButton.addEventListener("click", () => {
  const [restaurant] = filterAndRank().filter((item) => !skippedRestaurantNames.has(item.name));
  if (restaurant) chooseRestaurant(restaurant.name);
});
swipeDeck.addEventListener("click", (event) => {
  const photoControl = event.target.closest("[data-photo-direction]");
  if (photoControl) {
    const [restaurant] = filterAndRank()
      .slice(currentBatchIndex * batchSize, (currentBatchIndex + 1) * batchSize)
      .filter((item) => !skippedRestaurantNames.has(item.name));
    if (restaurant) {
      const photos = getRestaurantPhotos(restaurant);
      const currentIndex = photoIndexByRestaurant.get(restaurant.name) ?? 0;
      const step = photoControl.dataset.photoDirection === "next" ? 1 : -1;
      photoIndexByRestaurant.set(restaurant.name, (currentIndex + step + photos.length) % photos.length);
      renderResults();
    }
    return;
  }
  if (event.target.closest('[data-action="next-batch"]')) startNextBatch();
  if (event.target.closest('[data-action="expand-search"]')) expandSearchRadius();
});
starButton.addEventListener("click", () => {
  const [restaurant] = filterAndRank().filter((item) => !skippedRestaurantNames.has(item.name));
  if (restaurant) starRestaurant(restaurant.name);
});
shortlistButton.addEventListener("click", () => {
  shortlistPanel.hidden = !shortlistPanel.hidden;
  shortlistButton.setAttribute("aria-expanded", String(!shortlistPanel.hidden));
  renderShortlist();
});
shortlistPanel.addEventListener("click", (event) => {
  if (event.target.id === "close-shortlist") {
    shortlistPanel.hidden = true;
    shortlistButton.setAttribute("aria-expanded", "false");
    return;
  }
  const choose = event.target.closest(".shortlist-choose");
  if (!choose) return;
  selectedRestaurantName = choose.dataset.restaurantName;
  shortlistPanel.hidden = true;
  shortlistButton.setAttribute("aria-expanded", "false");
  renderResults();
});
resetButton.addEventListener("click", () => {
  form.reset();
  document.querySelector("#open-now").checked = true;
  selectedRestaurantName = null;
  skippedRestaurantNames = new Set();
  starredRestaurantNames = new Set();
  currentBatchIndex = 0;
  syncRangeLabels();
  renderResults();
});
settingsButton.addEventListener("click", () => setSettingsOpen(form.hidden));
settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));
travelTimeInput.addEventListener("input", syncRangeLabels);
budgetInput.addEventListener("input", syncRangeLabels);

async function refreshNearbyResults() {
  if (!currentPosition) return;

  locationButton.disabled = true;
  setTravelStatus("正在依目前條件搜尋附近餐廳…");
  try {
    const usedCategoryFallback = await searchNearbyRestaurants(currentPosition);
    await updateTravelTimes(currentPosition);
    const fallbackNote = usedCategoryFallback ? "這個細分類暫時沒有結果，已改顯示附近餐廳。" : "";
    setTravelStatus(`已找到附近真實餐廳並更新交通時間。${fallbackNote} 步行與兩輪路線可能有資料不完整的情況。Powered by Google ©2026`);
    renderResults();
  } catch (error) {
    setTravelStatus(error.message, true);
  } finally {
    locationButton.disabled = false;
  }
}

function findNearbyFromCurrentLocation() {
  if (!navigator.geolocation) {
    setTravelStatus("這個瀏覽器不支援定位功能。", true);
    return;
  }

  locationButton.disabled = true;
  setTravelStatus("正在取得你的位置並更新交通時間…");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      currentPosition = position;
      currentSearchRadiusMeters = 5000;
      selectedRestaurantName = null;
      skippedRestaurantNames = new Set();
      starredRestaurantNames = new Set();
      await refreshNearbyResults();
    },
    () => {
      setTravelStatus("沒有取得定位權限，因此保留示範時間。", true);
      locationButton.disabled = false;
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

locationButton.addEventListener("click", findNearbyFromCurrentLocation);

renderResults();
syncRangeLabels();
findNearbyFromCurrentLocation();
