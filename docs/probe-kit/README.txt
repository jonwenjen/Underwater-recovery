Underwater probe kit — 用另一個 App 處理這些檔案，存成同名（副檔名可不同）的檔案放到一個資料夾，再執行：
  node --experimental-strip-types scripts/probe-kit.ts compare <這個資料夾> <App 輸出資料夾>
用最高畫質存檔（JPEG／「最相容」，不要 HEIC，不要截圖）；強度用 App 預設值，全部同一設定。

1-chart.png  色卡在 6 m 深、2 m 距離的藍水中：色彩還原 ΔE、灰階是否中性
1-ramps.png  純色漸層（每列相同）：斷階、同色不同位置是否輸出相同（點運算 vs 空間運算）
2-depth-ramp.png  同一紅色物體在 1/5/10/20 m：遠處紅色補償是否隨距離增加（深度感知）
3-grey-wedge.png  無色灰階：輸出是否仍中性（不該被當成水下而染紅）
3-land.png  非水下（陸地光線）畫面：應幾乎不改變
6-scene.png  水下畫面（翻轉測試用）：上下顛倒後效果是否跟著翻轉
6-scene-surface.png  有水面高光與光束的水下畫面（翻轉測試用）
6-scene-vflip.png  水下畫面（翻轉測試用）：上下顛倒後效果是否跟著翻轉（翻轉版）
6-scene-hflip.png  水下畫面（翻轉測試用）：上下顛倒後效果是否跟著翻轉（翻轉版）
6-scene-surface-vflip.png  有水面高光與光束的水下畫面（翻轉測試用）（翻轉版）
6-scene-surface-hflip.png  有水面高光與光束的水下畫面（翻轉測試用）（翻轉版）
4-impulse.png  青色背景中央 3×3 白點：影響範圍＝有效感受野（0 ＝逐像素 LUT）
4-impulse-bg.png  青色背景中央 3×3 白點：影響範圍＝有效感受野（0 ＝逐像素 LUT）（無白點的背景，對照用）
5-clip.mp4 / 5-clip-black.mp4 / 5-clip-land.mp4  1 秒水下影片；第 15 幀換成全黑或陸地畫面：第 16 幀起多快恢復（跨幀記憶）
