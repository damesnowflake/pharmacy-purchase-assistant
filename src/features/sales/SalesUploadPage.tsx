import { useState } from "react";

// IR-02 판매 업로드. 실제 CatPOS 내보내기 형식(열 구조·반품 표현·전체/증분 여부)을
// 확인하기 전까지는 파서(D-02)를 구현할 수 없다. 화면 골격만 두고 저장은 막아
// 완성되지 않은 기능이 조용히 동작하는 것처럼 보이지 않게 한다.
export function SalesUploadPage() {
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <div className="sales-upload-page">
      <h2>판매 업로드</h2>
      <p className="form-message">
        실제 CatPOS Cloud(팜페이) 내보내기 파일 표본으로 열 구조·반품 표현·전체/증분 여부를 확인한
        뒤 파서를 연결할 예정입니다 (docs/미확인_항목.md D-02). 지금은 파일 선택까지만 동작합니다.
      </p>
      <label>
        판매 파일 선택
        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
        />
      </label>
      {fileName && (
        <p>
          선택한 파일: {fileName} — 실제 표본 확인 전까지 서버로 전송하지 않습니다.
        </p>
      )}
    </div>
  );
}
