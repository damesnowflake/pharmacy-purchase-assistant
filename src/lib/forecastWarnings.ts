export const forecastWarningLabel = (code: string): string => ({
  negative_forecast: "음수 예측 발생 · 계산에는 0 적용",
  short_history: "관측기간 56일 미만",
  incomplete_window: "180일 자료 미완성",
}[code] ?? code);
