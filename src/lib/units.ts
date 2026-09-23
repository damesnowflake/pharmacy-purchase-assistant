// 단위 환산. 상세_알고리즘_설계.md §1: "mg, g, 정 같은 규격 문자를 임의로 포장 개수로 해석하지 않는다."
// 환산계수가 없으면 값을 만들어내지 않고 명시적으로 실패시킨다.

export class UnknownUnitError extends Error {
  constructor(public readonly productId: string, public readonly unitCode: string) {
    super(`품목 ${productId}에 단위 ${unitCode}의 환산계수가 등록되어 있지 않습니다.`);
    this.name = "UnknownUnitError";
  }
}

export interface UnitConversion {
  /** 기준 단위 = 1. 그 외 단위는 factor_to_base > 0. */
  factorToBase(productId: string, unitCode: string): number | undefined;
}

export function toBaseUnit(
  productId: string,
  quantity: number,
  unitCode: string,
  conversion: UnitConversion,
): number {
  const factor = conversion.factorToBase(productId, unitCode);
  if (factor === undefined) {
    throw new UnknownUnitError(productId, unitCode);
  }
  if (factor <= 0) {
    throw new Error(`품목 ${productId} 단위 ${unitCode}의 환산계수는 양수여야 합니다.`);
  }
  return quantity * factor;
}

/** 정수 단위 품목은 소수 수량을 거부한다 (데이터베이스_설계.md 공통 규칙). */
export function assertQuantityAllowed(
  quantityBase: number,
  allowsFraction: boolean,
  productId: string,
): void {
  if (!allowsFraction && !Number.isInteger(quantityBase)) {
    throw new Error(
      `품목 ${productId}은(는) 소수 수량을 허용하지 않는데 계산 결과 ${quantityBase}가 나왔습니다.`,
    );
  }
}
