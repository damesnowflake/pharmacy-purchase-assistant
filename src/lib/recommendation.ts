// 추천 발주량. 소프트웨어_요구사항_명세서.md FR-26, 상세_알고리즘_설계.md §7.

export class InvalidPurchaseTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPurchaseTermsError";
  }
}

export interface PurchaseTerms {
  /** 기준 단위의 최소주문수량. 양수여야 한다. */
  moq: number;
  /** 기준 단위의 발주 단위. 양수여야 한다. 낱개 주문 가능이 확인된 품목만 1이어야 한다. */
  orderStep: number;
}

/**
 * 추천 발주량 = U * ceil(max(M, 7일 예상 수요) / U)
 * 부동소수 오차로 단위가 한 번 더 붙지 않도록 정수 배 여부를 먼저 확인한다.
 */
export function recommendedOrderQuantity(
  terms: PurchaseTerms,
  sevenDayDemand: number,
): number {
  const { moq, orderStep } = terms;
  if (!(moq > 0) || !(orderStep > 0)) {
    throw new InvalidPurchaseTermsError(
      `MOQ(${moq})와 발주 단위(${orderStep})는 모두 양수여야 합니다. 값이 없으면 임의로 확정하지 않고 입력을 요청해야 합니다.`,
    );
  }
  const target = Math.max(moq, sevenDayDemand);
  const steps = Math.ceil(roundAwayFloatNoise(target / orderStep));
  return roundAwayFloatNoise(steps * orderStep);
}

/** 1e-9 이하의 부동소수 오차를 제거해 정수 배가 한 단위 더 올라가는 것을 방지한다. */
function roundAwayFloatNoise(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded;
}

export interface SevenDayDemandInput {
  /** A부터 A+6일까지 각 날짜의 f(d)=max(0,예측값). 예측 없음인 날짜는 이 배열에 넣지 않는다. */
  dailyForecasts: number[];
  /** 7일 중 예측이 없는 날짜 수. 0보다 크면 호출측에서 신뢰도 경고를 표시해야 한다. */
  daysWithoutForecast: number;
}

export function sevenDayDemand(input: SevenDayDemandInput): number {
  return input.dailyForecasts.reduce((a, b) => a + b, 0);
}
