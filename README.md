# 今晚吃什麼？

依照使用者位置、正餐／飲料店、到店交通工具、到店時間、預算與營業狀態，推薦附近店家。可用滑卡略過、收藏或選定，並查看 Google 評價、照片、三種交通方式時間與 Google Maps 導航。

## 如何開啟

這是純前端網站，可部署於 GitHub Pages。

1. 將 `config.example.js` 複製為 `config.js`。
2. 在 `config.js` 填入已限制網域的 Google Maps API 金鑰。
3. 使用本機伺服器或 GitHub Pages 開啟；定位功能需要 HTTPS（或 `localhost`）。

## 下一步練習

1. 加入使用情境偏好，例如快速吃完、適合聊天或想吃辣。
2. 用瀏覽器儲存待選與略過紀錄。
3. 將跨裝置收藏資料改存到 Supabase。

## Google 地圖

此網站會使用 Maps JavaScript API、Maps Embed API、Places API (New) 與 Routes API。

`config.js` 的前端金鑰會隨網站公開，這是瀏覽器版 Google Maps 的正常做法；安全性來自限制，而不是把金鑰藏起來。請在 Google Cloud Console 對此金鑰設定：

- Application restrictions：HTTP referrers，只允許 `http://localhost:8000/*` 與 `https://bridge0321.github.io/*`。
- API restrictions：只允許上述四個 API。
- Billing：設定每月預算與用量警示。

目前每次搜尋會執行五個 Nearby Search，先為最多約 50 間餐廳計算使用者選定的交通方式，再為前 20 間補算另外兩種方式，約為 90 個路線元素。正式公開前，應持續監控 API 用量與費用。
