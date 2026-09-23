import { useCallback, useRef } from "react";

// 시나리오 2: 통신 오류로 저장 결과를 알 수 없을 때, 재시도가 새 요청이 되지 않도록 한다.
//
// 사용법: 저장 버튼을 누른 시점의 입력을 buildKey로 정규화한 문자열 하나로 만든다. 같은 키로
// 다시 mutate를 호출하면(재시도·새로고침 후 재시도) 같은 request_id를 그대로 재사용한다. 입력이
// 달라지면(사용자가 값을 고쳤으면) 새 request_id를 만든다. 서버가 성공을 확인해 주면
// clearOnSuccess()를 호출해 다음 저장을 위한 새 request_id를 준비한다. "확정된 입력 오류로
// 아무것도 저장되지 않았다"는 것을 호출자가 알고 있으면 clearPending()으로 같은 효과를 낸다
// (사용자가 값을 고치면 다음 시도는 자연히 새 키·새 ID가 된다).
//
// sessionStorage에는 request_id와 정규화된 key(텍스트)만 저장한다. 사진·OCR 원문·토큰은
// 여기 담지 않는다. storageKey는 사용자별로 달라야 하므로 호출자가 사용자 ID를 포함해 만든다.
export function useIdempotentRequest(storageKey: string) {
  const pendingRef = useRef<{ key: string; requestId: string } | null>(null);

  const readStorage = useCallback((): { key: string; requestId: string } | null => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.key === "string" && typeof parsed?.requestId === "string") return parsed;
      return null;
    } catch {
      return null;
    }
  }, [storageKey]);

  const writeStorage = useCallback(
    (v: { key: string; requestId: string } | null) => {
      try {
        if (v) sessionStorage.setItem(storageKey, JSON.stringify(v));
        else sessionStorage.removeItem(storageKey);
      } catch {
        // sessionStorage를 쓸 수 없어도(사생활 보호 모드 등) 메모리 상태만으로 계속 동작한다.
      }
    },
    [storageKey],
  );

  const getRequestId = useCallback(
    (key: string): string => {
      const current = pendingRef.current ?? readStorage();
      if (current && current.key === key) {
        pendingRef.current = current;
        return current.requestId;
      }
      const next = { key, requestId: crypto.randomUUID() };
      pendingRef.current = next;
      writeStorage(next);
      return next.requestId;
    },
    [readStorage, writeStorage],
  );

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    writeStorage(null);
  }, [writeStorage]);

  return { getRequestId, clearPending };
}
