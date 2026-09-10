# Problem Report 시트 분석 — 환불 원장의 실제 모습

Danny의 "Refund List"를 실제로 열어본 결과. 추측으로 잡았던 스키마 초안
(`docs/order-lifecycle-and-refunds.md` P5)을 **이 문서가 대체한다.**

출처: `Problem Report Responses.xlsx` (Google Sheets 연동). 2026-01-02 ~ 2026-09-10.

## 무엇이었나

**손으로 관리하는 목록이 아니라 Google Form 응답 시트다.** 스태프가 폼을 제출하면
행이 쌓인다. 즉 **입력은 이미 자동화되어 있다.**

| | |
| --- | --- |
| 응답 수 | **2,263건** (8개월) |
| 환불 총액 | **$241,382** (월평균 약 $30k) |
| 제출자 | 세일즈/CS 담당자 (christianmark, linh, davidyi …) |
| 시트 구성 | 응답 원본 + Daily Report + Weekly Report + Weekly Data(피벗) + 4 Weeks + 연도별(2019–2025) |

### 폼 구조

공통: `Timestamp · Email · Order Number · Ticket Number · Type`
그다음 **Type에 따라 분기**한다.

| Type | 건수 | 분기 필드 |
| --- | --- | --- |
| **Refund** | 2,141 | Reason · Detail · Order Total · Refund Amount · File · Warehouse Responsible |
| **Store Credit** | 77 | Reason · Account Email · Detail · Amount |
| **Reprint** | 45 | **Location(시설)** · Reason(자유입력) · Detail · File |

## 발견 1 — 정식 이유 체계는 15개이고 이미 5년째 쓰인다

`Weekly Data` 시트의 피벗 헤더가 정식 목록이다:

```
Shipping Issue · Duplicate · Low Resolution · Tax Exempt · Shipping Fee ·
Product Change · Trade Mark / Copy Right · Guaranteed Delivery · System Error ·
Product Issue · No file / requesting design · No contact · Returned · Cancel · Other
```

2026년 폼에서 실제로 나온 값은 이 중 12개다 (`Low Resolution`, `Trade Mark / Copy Right`,
`System Error`, `No contact`은 올해 0건 — 목록에는 살아 있다).

> **새 카테고리를 만들면 안 된다.** 2019–2025 시트가 전부 이 체계로 집계되어 있어
> 갈아엎으면 연도 비교가 끊긴다. 우리는 이 15개를 그대로 받고, 코드값만 붙인다.

### 정리해야 할 오염

- 대소문자 변형: `Product change` 2건, `Tax exempt` 1건 → 정규화 필요
- 목록에 없는 값: `Shipping Delay` 1건 (→ `Shipping Issue`로 흡수)
- **Reason 공란 120건** — 폼이 필수 항목이 아니다

## 발견 2 — "자동 차감"의 실제 대상은 아주 작다

요구사항 ④(환불액을 매출/정산에서 자동 차감)를 데이터에 대보면:

| 이유 | 건수 | 환불액 | 공장 귀책? |
| --- | --- | --- | --- |
| **Cancel** | 592 | **$116,936** (48%) | ❌ 고객 취소 |
| Other | 155 | $29,495 | 혼재 |
| Shipping Issue | 121 | $23,230 | ❌ 배송사 |
| Product Change | 262 | $18,258 | ❌ 고객 변경 |
| Tax Exempt | 517 | $13,112 | ❌ 세무 |
| Shipping Fee | 344 | $12,313 | ❌ 픽업 전환 등 |
| Duplicate | 70 | $12,210 | ❌ 중복 주문 |
| Returned | 43 | $8,396 | 혼재 |
| **Product Issue** | 25 | $4,362 | ✅ |
| Guaranteed Delivery | 12 | $2,408 | ❌ 배송사 |

**금액의 절반이 Cancel이고, 공장 귀책으로 볼 수 있는 것은 전체의 2% 수준이다.**

공장 귀책이 실제로 기록되는 곳은 **`Type = Reprint`** 뿐이다 — 45건/8개월. 여기에만
`Location`(GA/NJ/TX/NV/CA)과 원인이 자유입력으로 붙는다:

```
Production · Shipping · ink/toner issue · adhesive damaged/creases ·
pole pockets coming apart · grommets stuck together · received another
customer's banner · needed full 48in · Ink bleeding on logo …
```

`Weekly Data` 시트 맨 끝에도 `Reprint / Product Issue | GA | NJ | TX | CA | AZ` 열이 있다.
**즉 시설별 귀책 집계는 이미 이 슬라이스에만 존재한다.**

> **Kai 확인 필요:** 요구사항 ④가 말하는 "정산 차감"이
> (a) Reprint/Product Issue만인지, (b) 전체 환불액인지.
> (a)면 월 몇 백 달러 규모이고, (b)면 공장과 무관한 고객 취소까지 공장에서 깎게 된다.

### `Warehouse Responsible` 필드는 귀책이 아니다

`Refund` 분기에 있고 228건(10%) 채워져 있는데, 그 안에 **Tax Exempt 51건, Cancel 64건**이
섞여 있다. 세금 환불이 창고 잘못일 수 없으므로 이 필드는 "귀책"이 아니라 "해당 주문을
처리한 창고" 쯤으로 쓰이고 있다. 자동 차감의 근거로 쓸 수 없다.

## 발견 3 — 주문번호 형식이 섞여 있어 매칭이 어렵다

| 형식 | 건수 | 정체 |
| --- | --- | --- |
| `S#####` | 2,045 | Shopify order name — 우리 `orderName`과 동일 ✅ |
| 9자리 이상 숫자 | 185 | Shopify order **id** |
| `000#####` | 21 | DC 주문 |
| `S1299-M`, `S23766-2-M`, `S42473-2` | 10 | 접미사가 붙은 변형 |
| 6–8자리 | 2 | OrderDesk id 추정 |

**90%는 그대로 매칭되지만 나머지는 정규화가 필요하다.** 접미사(`-M`, `-2`)의 의미는 확인이
필요하다(수동 주문? 분할 주문?).

## 이 분석이 설계에 미치는 영향

1. **카테고리는 새로 만들지 않고 기존 15개를 코드화한다.** 연속성이 최우선.
2. **`Type`이 최상위 축이다** — Refund / Store Credit / Reprint. 환불만 다루는 게 아니다.
   `Reprint`는 돈이 아니라 재작업이므로 정산 처리가 다르다.
3. **귀책(fault)은 새 필드로 추가해야 한다.** 지금 데이터에는 없다. 이유에서 기본값을
   유도하고(예: `Guaranteed Delivery`→carrier, `Product Issue`→factory) 사람이 고칠 수 있게.
4. **진짜 고통은 입력이 아니라 집계일 가능성이 높다.** 입력은 Google Form이 이미 처리한다.
   Danny가 유지하는 것은 Daily/Weekly/4-Week/연도별 피벗이다.
   → **1단계 산출물을 "입력 화면"이 아니라 "주간·월간 집계 화면"으로 잡는 편이 낫다.**
5. **검증 기준이 생겼다** — 우리 집계가 `Weekly Report` 시트의 주별 숫자를 그대로 재현하면 통과.

## Danny에게 확인할 것

1. 폼 입력이 불편한가, 아니면 **집계 유지가 불편한가**? (프로젝트의 방향이 갈린다)
2. `Warehouse Responsible` 필드를 무슨 의미로 쓰고 있나
3. 주문번호 접미사 `-M` / `-2`의 의미
4. `Low Resolution` · `System Error` · `No contact` · `Trade Mark`가 올해 0건인 이유 —
   폼 선택지에서 빠졌나, 실제로 안 생기나
5. Reprint의 자유입력 원인을 **선택지로 고정**해도 되나 (그래야 시설별 집계가 됨)
