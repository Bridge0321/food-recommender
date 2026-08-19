# 今晚吃什麼？

依照餐廳種類、預算、營業年數、距離與目前是否營業，推薦適合的美食。結果會顯示評價，以及開車、騎車與步行的預估時間。

## 如何開啟

直接用瀏覽器打開 `index.html` 即可。這是純前端練習版，餐廳資料放在 `restaurants.js`。

## 下一步練習

1. 在 `restaurants.js` 新增一間餐廳。
2. 點選任一餐廳卡片，觀察系統依 `foodType` 顯示的同類比較。
3. 修改 `app.js` 的推薦分數規則。
4. 將資料改存到 Supabase。
5. 部署到 GitHub Pages。

## Google 地圖

每間餐廳的「用 Google Maps 開車導航」會以 Google Maps 導航網址開啟，不需要 API key。

要顯示地圖預覽、取得真實路線與即時時間，需建立 Google Cloud 專案、啟用 Maps Embed API 與 Maps JavaScript API，並建立有 HTTP referrer 限制的 API key。日後若要搜尋真實店家，再啟用 Places API (New)。

按「用我的位置更新交通時間」後，瀏覽器會要求定位權限，接著使用 Maps JavaScript API 的 Route Matrix 計算目前位置到各餐廳的開車、兩輪與步行預估時間。此功能需要啟用 Maps JavaScript API；在本機直接開啟檔案時，部分瀏覽器可能會封鎖定位，請使用 GitHub Pages 的 HTTPS 網址測試。
