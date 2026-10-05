# 가격과 세금 — 어디서 오고, 어떻게 검증했나

2026-09-28, 실제 스토어(stickersbanners.myshopify.com)에서 확인. Kai: "pricing이 제일 큰 문제야.
정확해야돼 돈 계산은."

## 한 줄 요약

**가격도 세금도 우리가 계산하지 않는다. 둘 다 Shopify에 묻는다.** 그리고 고객이 체크아웃에서
실제로 낸 배송비를 우리가 똑같이 재현하지 못하면, 가격을 보여주지 않는다.

| 숫자 | 출처 | 코드 |
| --- | --- | --- |
| 서비스별 배송비 | Shopify가 **그 주문 소계에서 체크아웃이 보여줄 요금** (`draftOrderCalculate` → `availableShippingRates`) | `checkoutRates` |
| 차액 | 위 요금끼리 뺄셈, **정수 센트** | `quoteShippingChange` |
| 차액에 붙는 세금 | Shopify Tax — 차액을 **배송 라인**으로 올린 초안 계산 | `buildChargeDraftInput` + `priceCharge` |
| 고객이 낼 총액 | Shopify가 준 total (= 차액 + 세금인지 검산) | 〃 |

`draftOrderCalculate`는 아무것도 저장하지 않는다 — 초안·주문·이메일 없음.

---

## 1. 가격 — PDF 요금표가 틀렸다

기존 코드는 FedEx가 보낸 PDF를 옮긴 표(`fedex-rates.mjs`)로 가격을 매겼다. 실제 스토어의 배송
요금 설정(General profile · Domestic zone · 167개 요금)과 비교하니 **다르다:**

| | PDF 표 | 실제 스토어 |
| --- | --- | --- |
| 첫 구간 경계 | $98 / $98.01 | **$96 / $96.01** |
| Ground @ $447–521 | $43.00 | **$44.05** |
| Ground @ $238–246 | $27.25 | **$28.30** |
| Ground @ $1117–1266 | $109.15 | **$110.20** |
| 구멍 | 없음 | **$118.00–$118.10에 Ground 없음**, $246.00–$246.10에 전 서비스 없음 |
| 1-Day @ $37–52 | $93.66 | **$99.17** |

**실주문 100건으로 검증 (배송 주문 83건):**

| | 체크아웃 금액과 일치 |
| --- | --- |
| PDF 표 | 69 / 83 — **14건 틀림 (17%)** |
| 실제 스토어 요금 | **83 / 83** |

제일 흔한 오류는 소계 $98.00 주문이다 (인기 상품 가격). PDF는 Ground $15.70이라 하지만
체크아웃은 $20.95를 받았다 — 차액을 매번 $5.25 잘못 계산했을 것.

→ **표를 코드에 두지 않는다.** 요금이 바뀌면(이미 한 번 바뀌었다) 표는 조용히 틀린다. 대신
견적 때마다 Shopify에게 "이 소계, 이 주소에서 체크아웃이 보여줄 요금"을 묻는다. 실제로
확인: $485.10 → Ground $44.05, $98.00 → $20.95, $118.05 → Ground 없음, $150 → $25.67.

### 어떤 소계인가

**Shopify의 할인 후 소계** (`subtotalPriceSet`). OrderDesk의 `product_total`이 아니다 —
S64178은 할인 전 $127.36(→ $25.15)이지만 체크아웃은 할인 후 $112.34(→ **$20.95**)로 매겼다.

### 스티커 프로필

`Bumper / Round / Oval / Custom Shape Kiss-Cut / Political Bumper Stickers`는 별도 배송
프로필이고 요금이 하나뿐이다: **"FedEx 2-days" $0.** Kai 결정으로 **배송 변경에서 제외**
(`sticker_order`). 혹시 이름 매칭을 빠져나가도 가격 검증(`price_unverified`)에서 걸린다.

---

## 2. 세금 — 배송비는 주마다 다르게 과세된다

스토어 설정은 `taxShipping: false`인데, 실주문을 보면 **Shopify Tax가 주별 규칙을 적용한다:**

| 배송비 과세 | 주 (실주문에서 확인) |
| --- | --- |
| **과세** | NJ, TX, FL, PA, NY, GA, TN, MO, IN, LA, NC, OH, SC, WI |
| **비과세** | MA, VA, NV, AL, MI, MD, WV, UT, OK |

그리고 TX는 **판매자 위치 기준**(Carrollton 창고의 시·교통세가 Alvin 주문에도 붙음), TN은
**품목과 배송에 지방세를 나눠 배분**한다. 세율 × 금액으로는 재현이 안 된다.

### 검증 — 실주문 11건을 초안으로 재현

원래 배송비를 **배송 라인**으로, 옆에 $0 과세 품목 하나, 실제 주소와 고객을 넣고
`draftOrderCalculate`:

| 주문 | 주 | 배송비 | 실제 낸 세금 | 재현 |
| --- | --- | --- | --- | --- |
| S64164 | NY | 26.20 | 2.29 | **2.29** |
| S64172 | GA | 15.70 | 0.94 | **0.94** |
| S64175 | MA | 15.70 | 0.00 | **0.00** |
| S64179 | TX | 187.43 | 15.45 | **15.45** |
| S64186 | TN | 33.08 | 3.22 | 3.23 |
| S64191 | FL | 89.25 | 6.25 | **6.25** |
| S64195 | FL | 15.70 | 1.18 | **1.18** |
| S64196 | VA | 25.15 | 0.00 | **0.00** |
| S64199 | TX | 15.70 | 1.30 | **1.30** |
| S64200 | NV | 25.15 | 0.00 | **0.00** |
| S64201 | NJ | 25.67 | 1.70 | **1.70** |

**10/11 센트까지 일치.** TN 1¢ 차이는 원 주문에서 지방세 일부가 품목 쪽에 배분됐기 때문 —
업그레이드 인보이스는 단독 청구이므로 Shopify가 계산하는 3.23이 그 청구의 올바른 세금이고,
**화면에 보여준 금액 = 인보이스 금액**은 그대로 성립한다(같은 계산).

### 기존 방식은 틀렸다

차액을 **과세 상품 라인**으로 올리던 기존 코드를 같은 주소에 돌려보니: MA·VA·NV $0 (맞음),
**NJ도 $0** — 실제는 $1.70. 배송비를 과세하는 주에서 **세금을 덜 받았을 것**(스토어가 대신 납부).

### 실제 페이로드로 최종 확인

코드의 `buildChargeDraftInput`이 만든 입력을 그대로 보냄:

- NJ, Ground → 3-Days: 차액 **$61.06 + 세금 $4.05 = $65.11**
- MA, Ground → 3-Days: 차액 **$17.38 + 세금 $0 = $17.38**

검산 조건(소계 0, 배송 = 차액, 총액 = 배송 + 세금, USD) 모두 통과.

---

## 3. 가격을 안 보여주는 경우 (전부 "Contact us")

견적은 **체크아웃에서 낸 금액을 재현할 수 있을 때만** 나온다.

| 사유 | 뜻 |
| --- | --- |
| `price_unverified` | 오늘 그 서비스의 체크아웃 요금 ≠ 고객이 낸 금액 (요금 변경, 스티커 무료 2-days, 수동 주문 …) |
| `shipping_discounted` | 배송비 할인을 받았다 — 차액을 어떻게 볼지는 Kai 결정 사항 |
| `method_changed` | OrderDesk의 방식 ≠ Shopify에서 결제한 방식 (누가 손으로 바꿈) |
| `service_unavailable` | 이 소계에서 체크아웃이 그 서비스를 안 판다 (구멍) |
| `tax_exempt_order` | 그 주문만 수동 면세 — 새 초안에 안 따라온다 |
| `calc_inconsistent` | Shopify 답이 검산에 실패 |
| `not_usd`, `rates_unavailable`, `calc_failed`, `shopify_error` | — |

고객에게는 내부 사유를 보여주지 않는다("배송 할인을 받으셨네요"는 말할 게 아니다).
면세 고객(`customer.taxExempt`)은 거부하지 않는다 — 고객을 초안에 붙이면 Shopify가 면세를
그대로 적용한다.

실주문 100건 기준: 배송 83건 전부 검증 통과, 픽업 15건은 전환 경로, 스티커 2건 거부.

---

## 4. 인보이스가 다른 금액이 될 수 없는 이유

`buildChargeDraftInput`이 **유일한** 입력 생성기다. 견적은 이것을 `draftOrderCalculate`에,
인보이스(아직 미구현, `SHOPIFY_WRITES`)는 같은 것을 `draftOrderCreate`에 넘긴다. 견적 결과에
`draftInput`이 같이 실려 나온다. 인보이스 코드는 생성 후 `totalPriceSet`이 견적 total과
같은지 다시 확인하고, 다르면 초안을 지우고 멈춰야 한다.

`acceptAutomaticDiscounts: false` + `allowDiscountCodesInCheckout: false` — 스토어 자동 할인이나
쿠폰이 차액을 깎지 못하게.

---

## 5. Kai가 할 일 — 커스텀 앱 스코프 정정

앞서 "`read_orders`만"이라고 적었는데 **틀렸다.** `draftOrderCalculate`는 아무것도 저장하지
않지만 Shopify는 **`write_draft_orders`** 스코프를 요구한다.

| 스코프 | 왜 |
| --- | --- |
| `read_orders` | 주문, 결제한 배송 라인, 소계, 주문상태 URL |
| `read_customers` | 주문의 고객 id (면세 적용) |
| `write_draft_orders` | `draftOrderCalculate` (저장 없음), 나중에 인보이스 |

우리 코드의 전송 계층(`shopify-fetch.mjs`)은 스코프와 별개로 **계산 전용 뮤테이션만** 통과시킨다.
한 문서에 `draftOrderCalculate`와 `draftOrderCreate`를 같이 넣어 끼워 넣는 것도 막는다
(이번에 발견해서 고침 — 이전엔 계산 하나만 있으면 통과했다).

## 6. Kai 결정 (2026-09-28)

| 질문 | 결정 | 코드 |
| --- | --- | --- |
| 주문 후 수정된 주문 | **새(현재) 소계**로 계산 | 고객이 낸 금액은 체크아웃 소계로 검증, 차액은 현재 소계의 두 정가 차이 |
| 스티커 제품 | **배송 변경에서 제외** (업그레이드·픽업 전환 모두) | `sticker_order` — Bumper / Round / Oval / Kiss-Cut / Political Bumper |
| 배송비 할인 | 할인 없음 | 실주문 100건 중 0건. 생기면 계속 `shipping_discounted`로 거부 |


## 7. Order Edit 방식 실측 (2026-09-28, 테스트 주문 S64262 · 미리보기 S64227)

인보이스(draft) 대신 **고객 주문 자체를 수정**한다 (`shopify-order-edit.mjs`). 결제된 draft는 새
주문이 되어 OrderDesk → intake Lambda → QTS로 들어가 유령 작업이 되기 때문이다.

| 확인 | 결과 |
| --- | --- |
| 새 주문 번호 | 생기지 않음 (S64262 그대로) |
| 주문 수정 직후 OrderDesk / intake Lambda | 3분 감시 — 반응 없음 |
| 잔액 결제(Mark as paid) 직후 | 6분 감시 — 반응 없음, 폴더·상품·수정시각 그대로 |
| 미리보기 잔액 = 확정 후 잔액 | $33.08 = $33.08 |
| 세금 (S64227, 애틀랜타, 미리보기만) | $68.17 → 세금 **$6.08** (곱셈으로는 $6.07) — 견적은 반드시 같은 수정 미리보기에서 |
| 기존 배송 라인 수정 | 불가 — 삭제 + 새 라인 추가 |
| 결제 알림 → OrderDesk → Chat (서명된 가짜 알림) | 1회 반영, 2회째 중복 거부, Chat 전송 |
| OrderDesk 주소 쓰기 | `Address Change` 룰로 **ShipStation(Manual Orders)에 들어감** — 결제 후에만 쓸 것 |

남은 일: 결제 알림 Lambda 배포(CDK + Shopify 웹훅), 커스텀 앱 권한 `write_order_edits`·`write_orders`,
미결제 수정 자동 되돌리기, 픽업 → 배송 전환의 Order Edit 전환(주소 변경 선행 필요).

## 8. Shopify 앱 (2026-09-29)

Dev Dashboard에 **"Manage My Order Button"** 앱을 수동으로 만들었다(CLI 아님, 관리자 임베드 없음,
스코프 5개: `read_orders` · `read_customers` · `write_draft_orders` · `write_order_edits` · `write_orders`).
Saturday Delivery와 합치지 않은 이유: 쓰기 권한이 이미 운영 중인 앱에 섞이지 않고, 문제가 생기면 이 앱만
끊을 수 있다. 새 앱에는 고정 토큰이 없어서 Lambda가 Client ID/secret을 ~24시간 토큰으로 교환해 메모리에
두고 만료 10분 전에 갱신한다(`shopify-auth.mjs`). 웹훅 서명 키도 같은 client-secret.

**결제 알림은 두 개를 구독한다 (`orders/paid` + `orders/updated`).** 부분 환불 기록이 있는 주문은
잔액을 다 내도 상태가 `partially_refunded`로 남고 `orders/paid`가 안 올 수 있다. 그래서 상태 이름이
아니라 `total_outstanding`이 0인지로 결제를 판단한다(`fullyPaid`). 중복 알림은 변경 기록 상태와
OrderDesk 참조번호가 막는다.

**Mac + 터널 실측 (`scripts/local-e2e.mjs`)**: 배포 코드 그대로(페이지, 라우트, 결제 처리)를 노트북에서
돌리고 Cloudflare 임시 터널로 공개 주소를 얻는다. 쓰기는 `WRITE_ONLY_ORDERS`로 테스트 주문 하나에만,
인보이스는 `INVOICE_TO`로만 간다. 종료 시 웹훅 등록을 지운다.

## 9. AWS 실배포 테스트 결과 (2026-10-01~02, S64262)

`sb-dev-compute/api/webapp`을 `--context testOrders=S64262`로 배포(쓰기는 S64262만). 메일의
**Manage my order**(S64262에게만 보이는 템플릿 블록) → 옵션 선택 → **Shopify 결제 페이지로 바로 이동**
(`paymentCollectionDetails.additionalPaymentCollectionUrl`, 인보이스 메일 없음) → 결제 → Shopify 웹훅
(`orders/updated`, 부분환불 이력 주문) → OrderDesk FedEx 3-Days $33.08 / $40.25 → Google Chat
"S64262 upgraded FedEx Ground → FedEx 3-Days · +$17.38". 처음부터 끝까지 통과.

- 옵션은 더 빠른 서비스 전부(Ground → 3-Days $17.38 / 2-Days $33.86 / 1-Day $73.55), 각각 Shopify 계산.
- 첫 실클릭에서 고친 것: 주문상태 URL이 `stickersbanners.com` 도메인이고, 메일의 `key`(shcct_…)와 API의
  `key`가 달라서 토큰만 비교하도록 변경.
- 환불 대기(잔액 음수)가 있으면 견적을 내지 않는다(확인됨, 환불 후 정상).
- ShipStation: 배송방식 변경으로 생기는 문제 없음(Kai 확인).
- 미결제: OrderDesk와 Chat은 결제 전엔 절대 안 움직인다. Shopify 주문만 새 서비스+잔액으로 남는다 —
  48시간 자동 되돌리기(`sb-dev-shipping-change-expiry`)는 꺼진 상태로 둠.
- 시설별 채팅방(2026-10-03): 모든 변경은 기존 방, 결제 시점에 주문이 들어 있는 OrderDesk 폴더가
  GA/NJ/TX 소속이면 그 시설 방에도 같은 줄(`chatFacilityOf`, `notifyChat`). 등록 안 된 새 폴더는 이름에
  GA/NJ/TX가 단어로 들어가면 그 시설. SSM `gchat/webhook-url-{GA,NJ,TX}`. 28개 폴더 전부 시뮬레이션
  통과(`test/shared/chat-routing.test.mjs`), `scripts/chat-route-check.mjs --send`로 4개 방 모두 HTTP 200
  수신 확인(Kai). 실결제로 시설 방까지 간 건은 아직 없음 — S64262를 실제 시설 폴더에 넣어야 해서 안 함.
- **전체 주문 활성화 (2026-10-04, Kai 승인):** `sb-dev-compute`를 `--context shippingChange=live`로 배포 —
  주문 수정·OrderDesk 반영이 모든 주문에 켜짐(`WRITE_ONLY_ORDERS` 없음, 확인함). 결제 웹훅 2개 필터 없이 재등록.
  미러(`sb-dev-mirror-sync`) ENABLED라 실제 주문 페이지 데이터가 채워짐. 고객 진입점인 확인 메일 버튼만
  S64262 전용으로 남김. 인보이스는 옵션 선택 시점에 Shopify가 발송(결제 후에는 Shopify가 거절).
- 남은 일(Kai 대기): 전 고객용 메일 버튼과 정식 도메인, `testOrders` 없이 정식 배포(실제 돈, 승인 필요).

## 10. 재검증 (2026-10-05, 실주문)

**가격 — 12/12 일치.** 최근 실주문 12건(GA·SC·CT·OH·FL·NJ·DE·VA·TN, 소계 $49.75–$649)을 코드와 같은
`draftOrderCalculate`로 조회: 고객이 고른 서비스의 오늘 체크아웃 요금 = 실제 낸 배송비, 전부 센트까지.

**세금 — 주문 수정(미확정)으로 3/3 일치.** 지금 코드는 세금을 초안이 아니라 **주문 수정 미리보기**에서
받는다. 실주문 3건에 Ground → 3-Days 수정을 만들고(확정 안 함, 흔적·고객 연락 없음) Shopify가 붙인 세금:

| 주문 | 주 | 차액 | 세금 | 검산 |
| --- | --- | --- | --- | --- |
| S66121 | GA Savannah 7% | 22.84 | 1.60 | ✓ |
| S66090 | NJ 6.625% | 66.63 | 4.41 | ✓ |
| S66088 | TX (Carrollton 판매자 위치) 8.25% | 32.59 | 2.69 | ✓ |

세 건 모두 새 총액 − 기존 총액 = 낼 금액(코드의 검산)도 성립. OrderDesk 반영은 shipping_total += 차액,
tax_total += 세금, order_total += 낸 금액.

**아직 실결제로 확인 못 한 것:** S64262는 **면세 고객**(`taxExempt: true`)이라 지금까지 실결제 테스트의
세금은 전부 $0. 세금이 붙는 주문의 실제 결제는 아직 없음. 픽업 실주문은 대부분 Shopify에 배송 주소가 없어서
(창고 픽업) 옵션이 안 뜬다 — 주소가 있는 픽업만 해당, 그 전환의 세금 관할도 미확인.
