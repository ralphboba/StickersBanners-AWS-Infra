# Manage my order — 배송 변경 프로그램 명세 (현재 동작 그대로)

이 문서는 고객 셀프 배송 변경("Manage my order") 프로그램이 **지금 실제로 어떻게 동작하는지**와
**Kai가 정한 규칙**을 한곳에 모은 것이다. 코드를 바꾸기 전에 반드시 여기부터 읽는다.
규칙이 바뀌면 이 문서를 같은 커밋에서 고친다.

마지막 정리: 2026-10-08 (c4ce09a 기준)

---

## 1. Kai가 정한 규칙 (어기지 말 것)

날짜는 Kai가 말한 날이다.

**작업 방식**
- 시킨 것만 한다. 임의로 기능을 추가하지 않는다.
- 답은 항상 한국어로 한다.

**고객 화면**
- 버튼은 **모든 고객**에게 보인다. 확인 메일 템플릿의 S64262 조건은 2026-10-05에 제거했다.
- 페이지는 **주문이 어느 폴더에 있든 열린다** (2026-10-06).
- **변경 가능 여부: Completed Orders 폴더만 막는다. 그 외 모든 폴더는 변경 가능하다** (2026-10-08).
  - 출고 대기(Awaiting Shipment), 픽업 대기(Awaiting Pickup), Pay By Check, 목록에 없는 새 폴더 모두 포함한다.
- 옵션은 **미리 선택하지 않는다.** 결제 대기 중인 변경이 있어도 옵션을 다시 전부 보여 준다 (2026-10-04).
- 더 빠른 서비스는 **전부** 보여 준다(한 칸만이 아니다) (2026-10-01). Ground도 사다리에 포함한다 (2026-09-28).
- 픽업 주문은 **주소를 먼저 입력**받고, 그 주소 기준 옵션을 보여 준다. 체크아웃과 같은 순서다 (2026-10-05).

**돈**
- 배송비와 세금은 **Shopify가 계산한 금액**만 쓴다. 코드 안에 요금표를 두지 않는다.
- 결제는 **Shopify 결제 페이지**에서만 받는다. 우리 페이지에서 카드를 받지 않는다.
- 옵션을 고르는 순간 Shopify 주문을 수정하고 **Shopify 인보이스 메일**을 보낸다 (2026-10-04).

**OrderDesk**
- **폴더를 절대 옮기지 않는다.** 결제 후 배송 방법, 배송비, 세금, 총액, 노트만 바꾼다.
- 공장(facility)도 바꾸지 않는다.

**알림**
- 결제된 변경 1건마다 Google Chat에 한 줄 보낸다. 기본 방에 가고, OrderDesk 폴더 이름에 GA/NJ/TX가 들어 있으면 그 공장 방에도 간다 (2026-10-02).
- 반영 실패 경고는 "shipping upgrade" Chat 방으로 간다 (2026-10-06). SSM `gchat/webhook-url-alerts`.
- 매일 업그레이드 건수는 **kai@ 메일로만** 보낸다. Chat에는 보내지 않는다 (2026-10-04).

**제외 상품** (어느 폴더든)
- 스티커 주문: 자체 배송 프로필 (2026-09-28)
- B2Sign 주문(깃발, 텐트, 야드사인, 캔버스): 공급업체가 만든다 (2026-09-24)

---

## 2. 전체 흐름

### 2-1. 버튼
- Shopify 주문 확인 메일의 "Manage my order"를 누르면
  `https://d1z2r5w66e9a93.cloudfront.net/my-order?o=<주문번호>&s=<Shopify 주문 상태 링크>`가 열린다.
- 로그인은 없다. `s` 링크 안의 주문 토큰이 본인 확인이다. `key=`는 비교하지 않는다.

### 2-2. 주문 읽기 (order-status-api, 읽기 전용)
1. 미러가 저장한 주문 정보가 있고 최신이면(미러 행, 링크와 폴더가 있음) 그것을 쓴다.
2. 없거나, 실제 접수(poller)가 가져간 주문이면 **그 자리에서 직접 읽는다.**
   1. Shopify에서 주문 링크를 받아 토큰을 대조한다.
   2. 맞을 때만 OrderDesk에서 현재 폴더, 상품, 배송, 주소를 읽는다.
3. 토큰이 틀리면 "We couldn't open this order"가 나온다.

### 2-3. 무엇을 보여 주나
- **배송 주문:** 지금보다 빠른 서비스 전부. 사다리는 FedEx Ground → FedEx 3-Days → FedEx 2-Days → FedEx 1-Day.
- **픽업 주문** ("Warehouse" 또는 "pickup"이 들어간 배송): 주소 입력 → 그 주소 기준 Ground, 3-Days, 2-Days, 1-Day 전부.
- 먼저 옵션 이름만 바로 뜨고("Calculating…"), 몇 초 뒤 가격이 채워진다.

### 2-4. 가격 (shopify-pricing.mjs)
- 요금: Shopify 체크아웃 요금(`draftOrderCalculate`)을 할인 후 소계 기준으로 받는다.
- 업그레이드 차액 = 새 요금 − 기존 요금 (현재 소계 기준)
- 픽업 전환 = 새 요금 전액. 픽업은 $0이다.
- 세금: Shopify 주문 수정을 걸어 보고(확정하지 않음), 늘어난 미결제 금액에서 배송 차액을 뺀 값이다.
- 화면 금액 = 배송 차액 + 세금 = 고객이 결제할 금액. 2026-10-06 S66300, 2026-10-07 S66881에서 센트 단위까지 일치를 확인했다.

### 2-5. 고객이 옵션을 고르고 Pay를 누름 (order-change-request)
1. 가격을 다시 계산한다. 화면 금액과 다르면 "가격이 바뀌었습니다"와 새 금액을 보여 준다.
2. 픽업이면 입력한 주소를 Shopify 주문에 넣는다(`orderUpdate`).
3. 변경 기록(`CHANGE`, status `pending`)을 **먼저** 저장한다.
4. Shopify 주문 수정을 확정한다. 기존 배송 줄을 빼고 새 줄을 넣는다. 고객에게 Shopify의 수정 알림 메일은 가지 않는다.
5. 확정된 미결제 금액이 견적과 같은지 확인한다. 다르면 `attention`으로 표시하고 Chat 경고를 보낸다.
6. Shopify 인보이스 메일을 보낸다. 문구는 "Your shipping is changing to X…", Pay now 버튼이 들어 있다.
7. 고객 화면이 Shopify 결제 페이지로 넘어간다.

### 2-6. 결제 안 하고 다시 들어오면
- 옵션이 다시 다 보이고(미리 선택 없음) 결제 버튼도 있다.
- 다른 옵션을 고르면 Shopify 주문을 한 번에 그 옵션으로 바꾼다. 이전 기록은 `replaced`가 된다.

### 2-7. 결제 후 (shopify-paid webhook + 5분마다 재확인)
- Shopify webhook(`orders/paid`, `orders/updated`)이 1차로 처리한다.
- `shipping-change-reconcile`이 5분마다 결제 대기 기록을 Shopify에 직접 확인해서, webhook이 놓친 건을 2차로 처리한다.
- 둘 다 같은 코드(`settleChange`)를 쓰고, 한 번에 하나만 처리한다(잠금).
- 처리 순서:
  1. "결제됨" 확인: 미결제 0이고, **새 배송 줄이 실제로 주문에 있어야 한다.**
  2. OrderDesk 폴더 재확인: **Completed Orders면 반영하지 않는다.** `attention`으로 표시하고 Chat에 "환불 필요"를 보낸다.
  3. OrderDesk 수정: 배송 방법, 배송비 += 차액, 세금 += 세금, 총액 += 결제액, 노트를 남긴다. 픽업이면 주소도 바꾼다. **폴더는 그대로 둔다.**
  4. 기록을 `done`으로 바꾸고, Chat 업그레이드 알림을 보내고, 일일 집계에 남긴다.
- 결제됐는데 30분이 지나도 반영이 안 되면 shipping upgrade Chat 방에 경고 1번을 보낸다.

### 2-8. 매일 8:52 (뉴욕 시간)
- 전날 요청 건수와 결제 건수를 kai@로 메일 보낸다.

---

## 3. 언제 되고 언제 안 되나

### 페이지가 열리나
- **열림:** 확인 메일 버튼(올바른 토큰), 어느 폴더든
- **안 열림:** 토큰이 틀림, Shopify나 OrderDesk 일시 장애

### 옵션이 나오나 — 안 나오는 경우와 화면 문구 (Kai, 2026-10-08)
모든 문구 끝에 " If you have any questions, please contact our team."이 붙는다.
- Completed Orders (배송 주문) → "Your order has been shipped and is on its way to your address."
- Completed Orders (픽업 주문) → "Your order has been completed."
- 이미 FedEx 1-Day → "This order is already on our fastest service."
- 사다리 밖 배송(Saturday Overnight, 알 수 없는 이름) → "This order's shipping cannot be upgraded online."
- B2Sign 상품 → "This order is made by one of our partners, so changes go through our team."
- 스티커 상품 → "Sticker orders ship on their own schedule, so the shipping can't be changed online."
- 배송 불가 지역 → "We can't change shipping for this delivery address."
- PO Box → "We can't ship to a PO box."
- 픽업 주소 입력: 미국 밖 → "We can only deliver within the United States." / 빈칸 → "Please fill in the street, city, state and ZIP code."

### 가격이 안 나오나 — 경우마다 다른 문구 (Kai, 2026-10-08)
Shopify 금액을 정확히 재현할 수 없으면 가격을 보여 주지 않는다. 문구는 경우마다 다르다
(`routes.mjs` REFUSAL_COPY). 내부 코드명은 화면에 나오지 않는다.
- `shipping_discounted` 배송비 할인 → "Your order got a shipping discount… Contact us…"
- `method_changed` 직원이 배송을 이미 바꿈(예: S67179) → "Our team has already changed the shipping…"
- `price_unverified` 주문 후 요금이 바뀜 → "Shipping rates have changed since you placed this order…"
- `balance_due` 원래 주문 미결제(예: Pay By Check) → "This order still has a balance to pay. Once it's paid…"
- `tax_exempt_order` 손으로 면세 처리 → "This order has a tax exemption we can't apply online…"
- `not_usd` 다른 통화 → "Orders paid in another currency can't be changed online…"
- `shipping_unverified` 배송 줄이 여러 개 → "This order has more than one shipping charge…"
- `no_address` 주소 없음 → "We don't have a delivery address on this order…"
- `service_unavailable` 이 주소에 더 빠른 배송 없음 → "Faster shipping isn't available for this order's delivery address."
- `rates_unavailable` Shopify 요금 조회 실패 → "We couldn't get shipping prices right now. Please try again…"
- `edit_begin_failed` Shopify가 주문 수정을 거부(결제 방식 등) → "This order can't be edited online because of how it was paid…"
- 그 외 → "We can't price a shipping change for this order online. Contact us…"

### Pay를 누른 뒤 실패하면 — 경우마다 다른 문구
- 결제 대기 중 직원 확인 필요(`attention`) / 확정 금액 불일치 → "Our team is reviewing a shipping change on this order and will contact you."
- 주소 저장 실패 → "We couldn't save that delivery address…"
- Shopify 확정 실패 → "We couldn't update your order just now — nothing was charged…"
- 방금 다른 변경이 들어옴 → "This order was just changed. Refresh the page…"
- 이미 결제됨 → "Your payment for this change is already in…"
- 스위치 꺼짐(배포 실수) → "Shipping changes aren't available online right now…"

### 확인되지 않은 것
- Shop Pay 할부 결제 주문은 Shopify가 주문 수정을 막는 것으로 알려져 있다. 실제로 시도된 적은 아직 없다.

---

## 4. 결정된 것
- **3-Days 주문은 어느 폴더에서든 업그레이드 가능** (Kai, 2026-10-08: "3 day여도 업그레이드 가능하게",
  "3에서 2데이는 뭐 알아서 하겠지"). 예전에는 공장 폴더에 들어가기 전까지 막았다. Linh 프로그램이
  오후 3~6시에 3-Days를 2-Days로 무료로 올려 줄 수 있어서였는데, 그 규칙은 없앴다.

## 5. 스위치와 배포

- 배포: `npx cdk deploy sb-dev-compute --context env=dev --context shippingChange=live`
  - `shippingChange=live`가 빠지면 `SHOPIFY_WRITES`와 `ORDERDESK_UPGRADE_WRITES`가 꺼진다. 고객이 골라도 "지금은 안 됩니다"가 나온다.
- 결제 안 된 변경 자동 되돌리기(`shipping-change-expiry`)는 **꺼져 있다.** 결제 안 된 변경은 그대로 남는다(기록에 48시간 기한만 적어 둔다).
- 실제 주문 접수(`sb-dev-poller`)는 이 프로그램과 무관하다. CLAUDE.md 기준으로 꺼져 있어야 한다.

## 6. 변경 기록(CHANGE) 상태
- `pending`: 고른 뒤 결제 대기
- `done`: 결제되어 OrderDesk에 반영됨
- `attention`: 사람이 봐야 함. 확정 금액이 견적과 다르거나, 결제 시점에 Completed 상태였던 경우
- `replaced`: 결제 전에 다른 옵션으로 바꿈
- `failed`: Shopify 확정 실패, Shopify 주문은 그대로

## 7. 실제 이력
- 2026-10-06 S66300 (테스트, 세금 있는 주문): 처음부터 끝까지 검증
- 2026-10-07 **S66881: 첫 실제 고객.** Ground → 1-Day, $112.92 결제, OrderDesk와 Chat 정상
- 2026-10-08 S67136: 픽업 전환이 주소 단계에서 실패. `orderUpdate`가 쓰기 허용 목록에 없었다(5501b6d에서 수정). 주문은 변경 없음.
- 2026-10-08 S67179: NJ Awaiting Shipment라서 막힘 → 규칙 변경(c4ce09a). 직원이 이미 OrderDesk를 1-Day로 바꿔 둔 상태였고, 차액은 수동 인보이스로 받아야 한다.

---

## 8. Add-on (상품 추가) — 2026-10-08

### Kai 규칙
- 목록: **Stand / Red Carpets 메뉴(Shopify 컬렉션 `stands-and-carpets`)의 모든 상품.** 단 Kai가 막아 둔 상품은 뺀다. 막아 둔 상품 = DRAFT이거나 온라인 스토어에 공개되지 않은 상품.
  - 인쇄가 필요한 상품(X-Banner, Retractable Banner)은 **"Stand Only" 옵션만** 보인다. 고객은 파일을 올릴 수 없기 때문이다(Linh 규칙).
  - 목록은 Shopify에서 읽는다(10분 캐시). 컬렉션에 상품을 넣거나 빼면 배포 없이 바뀐다.
- **수량 한도 없음.**
- **배송비는 상품을 고를 때마다 체크아웃처럼 다시 계산한다.** 새 소계 기준 체크아웃 요금 − 원래 소계 기준 요금을, 원래 낸 배송 줄에 더한다.
  - 아무도 수정하지 않은 주문이면 결과는 정확히 "새 소계의 체크아웃 요금"이다.
  - 픽업 주문은 $0 픽업 그대로 두고, 상품은 픽업할 때 같이 가져간다.
- **결제되면 OrderDesk에 상품 줄을 추가**하고 총액, 배송비, 세금, 노트를 바꾼다. 폴더는 그대로 둔다.
- 폴더 규칙은 배송 변경과 같다(Completed Orders만 막음). B2Sign과 스티커 주문에는 보이지 않는다.

### 켜는 범위 (Kai, 2026-10-08: "라이브 말고 주문 하나에만")
- 배포할 때 정한다. 기본은 **꺼짐**이다.
  - `--context addOnOrders=S64262`: 그 주문(쉼표로 여러 개 가능)에서만 보이고 받는다.
  - `--context addOns=live`: 모든 주문에서 보이고 받는다.
- 다른 주문에서는 GET 목록이 비어 있고, quote와 request를 보내도 거절된다.

### 흐름
1. GET: `addOns`에 목록이 들어간다.
2. 고객이 수량을 고르면 `POST /my-order/quote {addOns, service?}`를 호출한다. Shopify 주문 수정을 걸어 보고(확정 안 함) 상품, 배송 재계산, 세금, 합계를 받는다.
3. 위쪽에서 더 빠른 배송을 같이 골랐으면 **한 번의 수정, 한 번의 결제**로 같이 처리한다.
4. `POST /my-order/request {addOns, service?, expectedTotal}`: 금액 재확인 → 기록(`kind: 'addons'`) → Shopify 주문 수정 확정 → 새로 생긴 상품 줄 id 기록 → 인보이스 → Shopify 결제 페이지.
5. 결제 안 하고 다시 고르면, 이전 선택의 상품 줄을 같은 수정 안에서 0개로 빼고 새 선택으로 바꾼다.
6. 결제 확인은 webhook과 5분 재확인이 같은 코드로 한다. 이 경우 새 배송 줄과 상품 줄이 둘 다 주문에 있어야 "결제됨"이다.
   그다음 OrderDesk에 상품 줄과 금액을 반영하고, Chat에 "S… added … · shipping +$ · +$ items + $ tax = $"를 보낸다.

### 필요한 것 / 확인 안 된 것
- **Shopify 앱에 `read_products` 권한이 필요하다.** 없으면 목록을 못 읽고, 페이지에 add-on 칸이 보이지 않는다(다른 기능은 영향 없음).
- OrderDesk에 상품 줄을 PUT으로 추가하는 방식은 **실제 OrderDesk로는 아직 시험하지 않았다.** 테스트 주문으로 확인이 필요하다.
- Shopify 데이터 문제:
  - 20'x8' 단독 상품 SKU가 `SKUBS08X16`이다(→ `SKUBS08X20`이어야 함).
  - Retractable "Stand Only"가 `SKU-545`다(→ `SKU-546`이어야 함).
  - X-Banner와 Double X-Banner "Stand Only" SKU(`SKUXBS`, `SKUDXBS`)는 확인이 필요하다.
  - 스탠드가 "Banner Stands" 옵션과 단독 상품으로 **중복** 노출된다.
