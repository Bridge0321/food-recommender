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
const travelModeInput = document.querySelector("#travel-mode");
const travelModeHint = document.querySelector("#travel-mode-hint");
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
let usingDistanceFallback = false;
let usingRelaxedFallback = false;
let excludePreviouslySeenResults = false;

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

function priceFromGoogle(priceLevel) {
  const prices = { FREE: 0, INEXPENSIVE: 150, MODERATE: 300, EXPENSIVE: 500, VERY_EXPENSIVE: 800 };
  return prices[priceLevel] ?? 300;
}

const foodKinds = {
  meal: { label: "正餐", types: ["restaurant", "meal_takeaway", "breakfast_restaurant", "brunch_restaurant", "fast_food_restaurant"] },
  drink: { label: "飲料店", types: ["coffee_shop", "tea_house", "tea_store", "juice_shop"] }
};

function placeName(place) {
  return typeof place.displayName === "string" ? place.displayName : place.displayName?.text ?? "未命名餐廳";
}

function matchesFoodKind(place, foodKind) {
  const placeTypes = [place.primaryType, ...(place.types ?? [])].filter(Boolean);
  return placeTypes.some((type) => foodKind.types.includes(type));
}

function nearbySearchAreas(position, includeOuterRing) {
  const latitude = position.coords.latitude;
  const longitude = position.coords.longitude;
  const metersToLatitude = 1 / 111000;
  const metersToLongitude = 1 / (111000 * Math.cos(latitude * Math.PI / 180));
  const areas = [{ lat: latitude, lng: longitude, radius: currentSearchRadiusMeters }];
  // 單一 Nearby Search 最多只有 20 筆；中心與東西南北分區同時搜，避免熱門結果遮住附近小店。
  const offset = includeOuterRing ? 6000 : 2500;
  const areaRadius = includeOuterRing ? 3000 : 2500;
  [[offset, 0], [-offset, 0], [0, offset], [0, -offset]].forEach(([northSouth, eastWest]) => {
    areas.push({
      lat: latitude + northSouth * metersToLatitude,
      lng: longitude + eastWest * metersToLongitude,
      radius: areaRadius
    });
  });
  return areas;
}

async function searchNearbyRestaurants(position, rankPreference = "popularity") {
  await loadGoogleMaps();
  const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary("places");
  const filters = getFilters();
  const foodKind = foodKinds[filters.foodKind] ?? foodKinds.meal;
  const request = {
    fields: ["displayName", "formattedAddress", "location", "rating", "userRatingCount", "priceLevel", "primaryType", "types", "googleMapsURI", "currentOpeningHours", "photos", "reviews"],
    includedTypes: foodKind.types,
    maxResultCount: 10,
    rankPreference: rankPreference === "distance" ? SearchNearbyRankPreference.DISTANCE : SearchNearbyRankPreference.POPULARITY,
    language: "zh-TW",
    region: "tw"
  };
  const areas = nearbySearchAreas(position, excludePreviouslySeenResults);
  const placeGroups = await Promise.all(areas.map(async (area) => {
    const areaRequest = { ...request, locationRestriction: { center: { lat: area.lat, lng: area.lng }, radius: area.radius } };
    const result = await Place.searchNearby(areaRequest);
    return result.places ?? [];
  }));
  // 台灣手搖飲店常未被一致標記為 tea_house；以文字搜尋補足迷客夏、五桐號等品牌。
  if (filters.foodKind === "drink") {
    const { places: teaPlaces } = await Place.searchByText({
      textQuery: "手搖飲",
      fields: request.fields,
      locationBias: { lat: position.coords.latitude, lng: position.coords.longitude },
      maxResultCount: request.maxResultCount,
      language: "zh-TW",
      region: "tw"
    });
    // 文字搜尋可能因菜單或評論提到手搖飲而帶回餐廳、便利商店；只保留真正飲料店類型。
    placeGroups.push((teaPlaces ?? []).filter((place) => matchesFoodKind(place, foodKind)));
  }
  const places = [];
  // 交錯取各區結果，讓最終候選不會全由中心區最熱門的店組成。
  for (let index = 0; index < request.maxResultCount; index += 1) {
    placeGroups.forEach((group) => {
      if (group[index]) places.push(group[index]);
    });
  }
  const uniquePlaces = [...new Map(places.map((place) => [place.id ?? place.googleMapsURI ?? JSON.stringify(place.location), place])).values()];
  const eligiblePlaces = excludePreviouslySeenResults
    ? uniquePlaces.filter((place) => !skippedRestaurantNames.has(placeName(place)))
    : uniquePlaces;
  // places 已依各區的熱門名次交錯排列；保留約 50 間，讓熱門度決定推薦優先順序。
  const placesToProcess = eligiblePlaces.slice(0, 50);
  const realRestaurants = await Promise.all(placesToProcess.map(async (place, popularityRank) => {
    const isOpen = typeof place.isOpen === "function" ? await place.isOpen() : true;
    const photos = (place.photos ?? []).slice(0, 5).map((photo) => ({
      url: typeof photo.getURI === "function" ? photo.getURI({ maxHeight: 900, maxWidth: 900 }) : null,
      attributions: photo.authorAttributions ?? []
    })).filter((photo) => photo.url);
    const reviews = (place.reviews ?? []).slice(0, 5).map((review) => ({
      text: typeof review.text === "string" ? review.text : review.text?.text ?? "",
      rating: review.rating ?? 0,
      authorName: review.authorAttribution?.displayName ?? "Google 使用者",
      authorUri: review.authorAttribution?.uri ?? "",
      relativeTime: review.relativePublishTimeDescription ?? "",
      googleMapsUri: review.googleMapsURI ?? ""
    })).filter((review) => review.text);
    return {
      name: placeName(place),
      category: foodKind.label,
      foodType: place.primaryType ?? "restaurant",
      popularityRank,
      price: priceFromGoogle(place.priceLevel),
      yearsOpen: 0,
      isGooglePlace: true,
      rating: place.rating ?? 0,
      ratingCount: place.userRatingCount ?? null,
      isOpen: isOpen ?? true,
      emoji: "🍽️",
      address: place.formattedAddress ?? "地址未提供",
      location: place.location,
      googleMapsURI: place.googleMapsURI,
      imageUrl: photos[0]?.url ?? null,
      photoAttributions: photos[0]?.attributions ?? [],
      photos,
      reviews,
      placeAttributions: place.attributions ?? [],
      travelMinutes: { drive: 0, bike: 0, walk: 0 }
    };
  }));
  const unseenRestaurants = excludePreviouslySeenResults
    ? realRestaurants.filter((restaurant) => !skippedRestaurantNames.has(restaurant.name))
    : realRestaurants;
  if (!unseenRestaurants.length) throw new Error("附近找不到尚未看過的餐廳，請調整設定或移動位置後再試。"
  );
  restaurants.splice(0, restaurants.length, ...unseenRestaurants);
  currentBatchIndex = 0;
}

const routeModes = [
  ["DRIVING", "drive"],
  ["TWO_WHEELER", "bike"],
  ["WALKING", "walk"]
];

async function updateTravelTimes(position, modes = routeModes) {
  await loadGoogleMaps();
  const [{ RouteMatrix }, { UnitSystem }] = await Promise.all([
    google.maps.importLibrary("routes"),
    google.maps.importLibrary("core")
  ]);
  const origin = { lat: position.coords.latitude, lng: position.coords.longitude };
  const destinations = restaurants.map((restaurant) => restaurant.location ?? restaurant.address);
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
    foodKind: data.get("foodKind"),
    budget: Number(data.get("budget")),
    travelTime: Number(data.get("travelTime")),
    travelMode: data.get("travelMode"),
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

function ratingSummary(restaurant) {
  return Number.isFinite(restaurant.ratingCount) ? `★ ${restaurant.rating} · ${restaurant.ratingCount.toLocaleString("zh-TW")} 則評價` : `★ ${restaurant.rating}`;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function renderReviewTicker(restaurant) {
  if (!restaurant.reviews?.length) return '<p class="review-unavailable">目前沒有可顯示的 Google 評論。</p>';
  const reviewItems = restaurant.reviews.map((review) => {
    const author = escapeHtml(review.authorName);
    const authorMarkup = review.authorUri ? `<a href="${review.authorUri}" target="_blank" rel="noreferrer">${author}</a>` : author;
    const fullReviewLink = review.googleMapsUri ? `<a class="full-review-link" href="${review.googleMapsUri}" target="_blank" rel="noreferrer">完整評論 ↗</a>` : "";
    return `<article class="review-item"><span class="review-stars">★ ${review.rating}</span><p>「${escapeHtml(review.text)}」</p><span class="review-author">— ${authorMarkup}${review.relativeTime ? ` · ${escapeHtml(review.relativeTime)}` : ""}</span>${fullReviewLink}</article>`;
  }).join("");
  const providerAttribution = restaurant.placeAttributions?.length ? `<span class="review-provider">${restaurant.placeAttributions.map(escapeHtml).join(" · ")}</span>` : "";
  return `<section class="review-ticker" aria-label="Google 使用者評論"><div class="review-ticker-heading"><span>Google 評價 · ${ratingSummary(restaurant)}</span>${providerAttribution}</div><div class="review-viewport"><div class="review-track ${restaurant.reviews.length > 1 ? "is-moving" : ""}">${reviewItems}${restaurant.reviews.length > 1 ? reviewItems : ""}</div></div></section>`;
}

function scoreRestaurant(restaurant, filters) {
  let score = 0;
  score += Math.max(0, 40 - restaurant.travelMinutes[filters.travelMode] * 2);
  score += restaurant.rating * 3;
  if (restaurant.isOpen) score += 25;
  if (matchesBudget(restaurant.price, filters.budget)) score += 10;
  return Math.round(score);
}

function filterAndRank() {
  const filters = getFilters();
  const rankedRestaurants = restaurants
    .filter((restaurant) => usingRelaxedFallback || matchesBudget(restaurant.price, filters.budget))
    // 交通工具與到店時間是使用者主動設定的條件，任何備援搜尋都不能略過。
    .filter((restaurant) => {
      const minutes = restaurant.travelMinutes[filters.travelMode];
      return Number.isFinite(minutes) && minutes > 0 && minutes <= filters.travelTime;
    })
    .filter((restaurant) => usingRelaxedFallback || !filters.openNow || restaurant.isOpen)
    .map((restaurant) => ({ ...restaurant, score: scoreRestaurant(restaurant, filters) }));

  return rankedRestaurants.sort((a, b) => {
    if (usingDistanceFallback) {
      return a.travelMinutes[filters.travelMode] - b.travelMinutes[filters.travelMode] || b.score - a.score;
    }
    return a.popularityRank - b.popularityRank || b.score - a.score;
  });
}

function availableCandidates() {
  const ranked = filterAndRank();
  return excludePreviouslySeenResults
    ? ranked.filter((restaurant) => !skippedRestaurantNames.has(restaurant.name))
    : ranked;
}

function renderTopPick(restaurant) {
  topPick.hidden = false;
  topPick.innerHTML = `
    <div class="top-pick-label">♥ 你選定了</div>
    <div class="top-pick-content">
      <span class="top-pick-emoji">${restaurant.emoji}</span>
      <div>
        <h3>${restaurant.name}</h3>
        <p>${ratingSummary(restaurant)} · 約 ${restaurant.price} 元／人 · ${travelTimeSummary(restaurant)}</p>
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
          <div><strong>${restaurant.name}</strong><p>${ratingSummary(restaurant)} · ${restaurant.price} 元 · ${travelTimeSummary(restaurant)}</p></div>
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
  const candidates = availableCandidates();
  const selected = ranked.find((restaurant) => restaurant.name === selectedRestaurantName);
  const batchStart = currentBatchIndex * batchSize;
  const currentBatch = candidates.slice(batchStart, batchStart + batchSize);
  // 外圈補搜時也要套用本輪剛略過的店，否則卡片會一直停在同一間。
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
    swipeDeck.innerHTML = '<p class="empty-state">試著放寬到店時間、預算或「只顯示營業中」的條件吧。</p>';
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
    const hasNextBatch = candidates.length > batchStart + batchSize;
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
      <p class="swipe-meta">${restaurant.category} · 約 ${restaurant.price} 元／人 · ${ratingSummary(restaurant)}</p>
      <p class="swipe-reason">${travelTimeSummary(restaurant)}，符合你的設定。</p>${renderReviewTicker(restaurant)}</div>
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
  const candidates = availableCandidates();
  if ((currentBatchIndex + 1) * batchSize >= candidates.length) return;
  currentBatchIndex += 1;
  renderResults();
}

async function expandSearchRadius() {
  if (!currentPosition || currentSearchRadiusMeters >= expandedSearchRadiusMeters) return;
  currentSearchRadiusMeters = expandedSearchRadiusMeters;
  currentBatchIndex = 0;
  excludePreviouslySeenResults = true;
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
  const modeLabels = { drive: "開車 🚗", bike: "騎車 🛵", walk: "走路 🚶" };
  travelTimeValue.textContent = `${travelTimeInput.value} 分鐘內`;
  budgetValue.textContent = `${Number(budgetInput.value).toLocaleString("zh-TW")} 元以下`;
  travelModeHint.textContent = `以${modeLabels[travelModeInput.value]}時間計算`;
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
  currentSearchRadiusMeters = 5000;
  excludePreviouslySeenResults = false;
  setSettingsOpen(false);
  renderResults();
});

form.addEventListener("change", async (event) => {
  selectedRestaurantName = null;
  skippedRestaurantNames = new Set();
  currentBatchIndex = 0;
  excludePreviouslySeenResults = false;
  // 種類、交通工具與到店時間改變後重新搜尋，必要時可改用最近餐廳備援。
  if (currentPosition && ["foodKind", "travelMode", "travelTime"].includes(event.target.name)) {
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
  currentSearchRadiusMeters = 5000;
  excludePreviouslySeenResults = false;
  syncRangeLabels();
  renderResults();
});
settingsButton.addEventListener("click", () => setSettingsOpen(form.hidden));
settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));
travelTimeInput.addEventListener("input", syncRangeLabels);
budgetInput.addEventListener("input", syncRangeLabels);
travelModeInput.addEventListener("change", syncRangeLabels);

async function refreshNearbyResults() {
  if (!currentPosition) return;

  locationButton.disabled = true;
  setTravelStatus("正在依目前條件搜尋附近餐廳…");
  try {
    usingDistanceFallback = false;
    usingRelaxedFallback = false;
    await searchNearbyRestaurants(currentPosition, "popularity");
    const selectedMode = getFilters().travelMode;
    const selectedRouteMode = routeModes.find(([, property]) => property === selectedMode);
    await updateTravelTimes(currentPosition, [selectedRouteMode]);

    if (!availableCandidates().length) {
      usingDistanceFallback = true;
      await searchNearbyRestaurants(currentPosition, "distance");
      await updateTravelTimes(currentPosition, [selectedRouteMode]);
    }

    if (!availableCandidates().length) usingRelaxedFallback = true;

    const displayCandidates = availableCandidates().slice(0, 20);
    if (displayCandidates.length) {
      const restaurantsByName = new Map(restaurants.map((restaurant) => [restaurant.name, restaurant]));
      restaurants.splice(0, restaurants.length, ...displayCandidates.map((restaurant) => restaurantsByName.get(restaurant.name)).filter(Boolean));
      // 只替會出現在卡片上的餐廳補算另外兩種交通方式。
      await updateTravelTimes(currentPosition, routeModes.filter(([, property]) => property !== selectedMode));
    }

    const distanceNote = usingDistanceFallback ? "熱門店沒有符合結果，已改以距離顯示最近餐廳。" : "";
    const relaxedNote = usingRelaxedFallback ? "目前沒有符合設定的店，已放寬預算與營業狀態。" : "";
    setTravelStatus(`已找到附近真實餐廳並更新交通時間。${distanceNote}${relaxedNote} 步行與兩輪路線可能有資料不完整的情況。Powered by Google ©2026`);
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
      excludePreviouslySeenResults = false;
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
