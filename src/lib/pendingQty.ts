// 발주·입고 대기량. 상세_알고리즘_설계.md §8.
// 원천 사건(quantity_events)은 보관하고, 대기 숫자는 재계산 가능한 캐시로 다룬다.

export type QuantityEventKind = "order" | "receipt" | "order_cancel" | "count" | "stock_adjustment";

export interface QuantityEvent {
  id: string;
  kind: QuantityEventKind;
  /** receipt/order/order_cancel은 양수, count는 0 이상, stock_adjustment는 0이 아닌 부호값. */
  quantity: number;
  occurredAt: string; // timestamptz ISO
  recordedSeq: number; // DB 생성 순번. (occurredAt, recordedSeq) 순서로 처리.
}

export interface PendingQtyResult {
  pending: number;
  /** 각 receipt 이벤트별 초과/미연결 수량. 0보다 크면 관리자 화면에 표시한다. */
  excessByReceiptEventId: Map<string, number>;
  /** order_cancel이 남은 대기량보다 커서 정정 검토가 필요한 이벤트 id 목록. */
  cancelReviewWarnings: string[];
}

function sortEvents(events: QuantityEvent[]): QuantityEvent[] {
  return [...events].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    return a.recordedSeq - b.recordedSeq;
  });
}

/**
 * 품목별 사건을 시간순으로 처리해 현재 발주-입고 대기량을 계산한다.
 * count/stock_adjustment는 물리 수량에만 영향을 주고 pending에는 영향을 주지 않는다.
 */
export function computePendingQty(events: QuantityEvent[]): PendingQtyResult {
  let pending = 0;
  const excessByReceiptEventId = new Map<string, number>();
  const cancelReviewWarnings: string[] = [];

  for (const event of sortEvents(events)) {
    switch (event.kind) {
      case "order":
        pending += event.quantity;
        break;
      case "receipt": {
        const applied = Math.min(pending, event.quantity);
        pending -= applied;
        const extra = event.quantity - applied;
        if (extra > 0) excessByReceiptEventId.set(event.id, extra);
        break;
      }
      case "order_cancel": {
        const appliedCancel = Math.min(pending, event.quantity);
        pending -= appliedCancel;
        if (appliedCancel < event.quantity) cancelReviewWarnings.push(event.id);
        break;
      }
      case "count":
      case "stock_adjustment":
        break;
    }
  }

  return { pending, excessByReceiptEventId, cancelReviewWarnings };
}

/** 진행 중 항목(waiting)이 완료(received)로 닫히는 시점: 대기량이 정확히 0이 된 순간. */
export function isFullyReceived(pending: number): boolean {
  return pending === 0;
}
