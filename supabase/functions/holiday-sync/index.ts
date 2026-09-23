// 공휴일 동기화 Edge Function. 소프트웨어_요구사항_명세서.md IR-09, 시스템_구조_설계.md "계산과 정기 작업"(매일 02:00 KST).
//
// 사용 API: 공공데이터포털 "한국천문연구원 특일 정보" 서비스의 getHoliDeInfo 오퍼레이션.
//   GET https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getHoliDeInfo
//   파라미터: ServiceKey, solYear(필수), solMonth(선택), pageNo, numOfRows, _type=json
//   응답 필드: resultCode, resultMsg, totalCount, items.item[].{locdate, dateName, isHoliday, dateKind, seq}
//   isHoliday === "Y"인 항목만 실제 쉬는 날(대체공휴일 포함)이다. 이 값과 필드명은 2026-09-23
//   공공데이터포털 문서 조회로 확인했으나, 배포 전 실제 서비스 키로 한 번 더 검증해야 한다
//   (docs/미확인_항목.md). API가 없는 기간을 조용히 "휴일 없음"으로 해석하지 않는다.
//
// 필요한 환경변수 (Supabase 프로젝트 시크릿으로만 설정, 프론트엔드에 노출 금지):
//   HOLIDAY_API_SERVICE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(Supabase가 자동 주입)

import { createClient } from "npm:@supabase/supabase-js@2";

const HOLIDAY_API_BASE =
  "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getHoliDeInfo";

interface HolidayApiItem {
  locdate: number; // YYYYMMDD
  dateName: string;
  isHoliday: "Y" | "N";
  dateKind: string;
  seq: number;
}

interface HolidayApiResponse {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      totalCount: number;
      items: { item?: HolidayApiItem | HolidayApiItem[] } | "";
    };
  };
}

function toIsoDate(locdate: number): string {
  const s = String(locdate);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function fetchYear(year: number, serviceKey: string): Promise<HolidayApiItem[]> {
  const url = new URL(HOLIDAY_API_BASE);
  url.searchParams.set("ServiceKey", serviceKey);
  url.searchParams.set("solYear", String(year));
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("_type", "json");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`HOLIDAY_API_HTTP_ERROR: ${res.status}`);
  }
  const json = (await res.json()) as HolidayApiResponse;
  const header = json.response?.header;
  if (!header || header.resultCode !== "00") {
    throw new Error(`HOLIDAY_API_RESULT_ERROR: ${header?.resultCode} ${header?.resultMsg}`);
  }
  const items = json.response.body.items;
  if (items === "" || !items.item) return [];
  return Array.isArray(items.item) ? items.item : [items.item];
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const holidayApiKey = Deno.env.get("HOLIDAY_API_SERVICE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("MISSING_SUPABASE_ENV", { status: 500 });
  }
  if (!holidayApiKey) {
    // 실패를 휴일 없음으로 해석하지 않는다: 이전 성공 캐시를 그대로 두고 실패만 기록한다.
    return new Response("MISSING_HOLIDAY_API_KEY", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear, currentYear + 1]; // 현재/다음 연도 매일 갱신 (IR-19)

  const results: Array<{ year: number; status: string; error?: string }> = [];

  for (const year of years) {
    try {
      const items = await fetchYear(year, holidayApiKey);
      const holidays = items.filter((i) => i.isHoliday === "Y");

      if (holidays.length > 0) {
        const rows = holidays.map((h) => ({
          holiday_date: toIsoDate(h.locdate),
          name: h.dateName,
          source: "data.go.kr:getHoliDeInfo",
        }));
        const { error: upsertError } = await supabase
          .from("holiday_dates")
          .upsert(rows, { onConflict: "holiday_date,source,name" });
        if (upsertError) throw upsertError;
      }

      await supabase.from("holiday_sync_runs").insert({
        year,
        status: holidays.length > 0 ? "success" : "empty_confirmed",
        coverage_start: `${year}-01-01`,
        coverage_end: `${year}-12-31`,
      });
      results.push({ year, status: "success" });
    } catch (e) {
      await supabase.from("holiday_sync_runs").insert({
        year,
        status: "failed",
        last_error: String(e),
      });
      results.push({ year, status: "failed", error: String(e) });
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
  });
});
