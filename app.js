const form = document.querySelector("#filter-form");
const resetButton = document.querySelector("#reset-button");
const list = document.querySelector("#restaurant-list");
const topPick = document.querySelector("#top-pick");
const resultsTitle = document.querySelector("#results-title");
const resultCount = document.querySelector("#result-count");
const cardTemplate = document.querySelector("#restaurant-card-template");

function getFilters() {
  const data = new FormData(form);
  return {
    category: data.get("category"),
    budget: Number(data.get("budget")),
    yearsOpen: Number(data.get("yearsOpen")),
    distance: Number(data.get("distance")),
    openNow: data.get("openNow") === "on"
  };
}

function matchesBudget(price, budget) {
  if (budget === 999999) return price > 500;
  if (budget === 150) return price <= 150;
  if (budget === 300) return price >= 151 && price <= 300;
  if (budget === 500) return price >= 301 && price <= 500;
  return true;
}

function scoreRestaurant(restaurant, filters) {
  let score = 0;
  score += Math.max(0, 40 - restaurant.distanceKm * 7);
  score += Math.min(restaurant.yearsOpen * 1.5, 20);
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
    .filter((restaurant) => restaurant.yearsOpen >= filters.yearsOpen)
    .filter((restaurant) => restaurant.distanceKm <= filters.distance)
    .filter((restaurant) => !filters.openNow || restaurant.isOpen)
    .map((restaurant) => ({ ...restaurant, score: scoreRestaurant(restaurant, filters) }))
    .sort((a, b) => b.score - a.score);
}

function createCard(restaurant) {
  const card = cardTemplate.content.cloneNode(true);
  card.querySelector(".restaurant-icon").textContent = restaurant.emoji;
  card.querySelector("h3").textContent = restaurant.name;
  const status = card.querySelector(".status");
  status.textContent = restaurant.isOpen ? "營業中" : "休息中";
  status.classList.add(restaurant.isOpen ? "open" : "closed");
  card.querySelector(".restaurant-meta").textContent = `${restaurant.category} · 約 ${restaurant.price} 元／人`;
  card.querySelector(".restaurant-detail").textContent = `距離 ${restaurant.distanceKm} 公里 · 已營業 ${restaurant.yearsOpen} 年`;
  card.querySelector(".match-score").textContent = `${restaurant.score} 分`;
  return card;
}

function renderTopPick(restaurant) {
  topPick.hidden = false;
  topPick.innerHTML = `
    <div class="top-pick-label">⭐ 最適合你</div>
    <div class="top-pick-content">
      <span class="top-pick-emoji">${restaurant.emoji}</span>
      <div>
        <h3>${restaurant.name}</h3>
        <p>距離 ${restaurant.distanceKm} 公里、約 ${restaurant.price} 元，${restaurant.isOpen ? "現在正在營業" : "目前休息中"}。</p>
      </div>
    </div>`;
}

function renderResults() {
  const ranked = filterAndRank();
  list.replaceChildren();
  resultCount.textContent = `${ranked.length} 間符合`;

  if (ranked.length === 0) {
    topPick.hidden = true;
    resultsTitle.textContent = "找不到符合的餐廳";
    list.innerHTML = '<p class="empty-state">試著放寬距離、預算或營業年數的條件吧。</p>';
    return;
  }

  resultsTitle.textContent = "這幾間很適合你";
  renderTopPick(ranked[0]);
  ranked.forEach((restaurant) => list.append(createCard(restaurant)));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  renderResults();
});

form.addEventListener("change", renderResults);
resetButton.addEventListener("click", () => {
  form.reset();
  document.querySelector("#open-now").checked = true;
  renderResults();
});

renderResults();
