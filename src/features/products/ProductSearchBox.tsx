import { useState } from "react";
import { useProductSearch, type ProductSearchResult } from "@/lib/useProductSearch";
import { ProductRegisterForm } from "./ProductRegisterForm";

/**
 * 상품명·규격·별칭·POS 코드·바코드 검색 + 선택 컴포넌트. 상품 관리 화면(설정)과 입고 화면이
 * 동일한 search_products RPC와 이 컴포넌트를 함께 쓴다.
 *
 * 검색 결과가 없으면 같은 화면에서 바로 새 상품을 등록할 수 있고, 등록이 끝나면 그 상품을
 * onSelect로 자동 전달한다(호출부가 입고 행 등에 자동으로 추가하도록).
 */
export function ProductSearchBox({
  onSelect,
  placeholder = "상품명·규격·별칭·바코드로 검색",
  allowRegisterNew = true,
}: {
  onSelect: (p: ProductSearchResult) => void;
  placeholder?: string;
  allowRegisterNew?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const { data: results, isLoading } = useProductSearch(query);

  return (
    <div className="product-search-box">
      <label>
        상품 검색
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} />
      </label>

      {isLoading && <p className="form-message">검색 중...</p>}

      {!isLoading && results && results.length > 0 && (
        <ul className="search-results">
          {results.map((p) => (
            <li key={p.product_id}>
              <button type="button" onClick={() => onSelect(p)}>
                {p.name} {p.spec} ({p.base_unit})
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && query.trim() !== "" && (!results || results.length === 0) && (
        <div>
          <p className="form-message">검색 결과가 없습니다.</p>
          {allowRegisterNew && !showRegister && (
            <button type="button" onClick={() => setShowRegister(true)}>
              새 상품 등록
            </button>
          )}
        </div>
      )}

      {allowRegisterNew && showRegister && (
        <ProductRegisterForm
          initialName={query.trim()}
          onRegistered={(p) => {
            setShowRegister(false);
            setQuery("");
            onSelect(p);
          }}
          onCancel={() => setShowRegister(false)}
        />
      )}
    </div>
  );
}
