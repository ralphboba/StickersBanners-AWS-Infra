# 차액을 어떻게 청구하는가 — Draft Order vs Order Edit

Kai가 보내준 인보이스 템플릿을 읽고 정리. 이 선택이 **오더데스크 반영 방식까지 결정한다.**

## 먼저 — 보내준 것은 Draft Order 인보이스다

Order edit이 보내는 "Order invoice"가 아니라 **초안 주문(Draft Order)** 알림이다. 근거:

| 증거 | 의미 |
| --- | --- |
| `Invoice #D169` | `D` 접두사 = Shopify 초안 주문 번호 |
| `{{ invoice_url }}` | 초안 주문 결제 링크 |
| `reserve_inventory_until` | 초안이 재고를 잡아두는 기간 |
| `Confirm order` / `Complete your purchase` | 아직 주문이 **성립 전** |
| `amount_due_now`, `payment_terms` | Net 7 등 초안 결제 조건 |

**즉 Danny의 현재 방식이 초안 주문이다.** 원 주문을 고치는 게 아니라 **새 주문을 하나 더
만들어** 인보이스를 보낸다. 스크린샷의 `Total due September 21, 2026 / Net 7`이 그 증거다.

## Q1. 봇이 자체 발행할 수 있나 — 예. 두 경로 다 사람 없이 된다

| | **A. Draft Order** (지금 방식) | **B. Order Edit** |
| --- | --- | --- |
| API | `draftOrderCreate` → `draftOrderInvoiceSend` | `orderEditBegin` → `orderEditAddShippingLine` → `orderEditCommit` |
| 나가는 메일 | **보내준 바로 그 템플릿** | 다른 템플릿 ("Order invoice") |
| 결과 | **새 주문 D169 생성.** S59131은 그대로 | S59131에 미결제 잔액이 붙음 |
| 원 주문의 배송방법 | **2-Day인 채로 남는다** | 업그레이드분이 라인으로 추가됨 |
| 오더데스크 | ⚠️ **D169를 신규 주문으로 내려받을 수 있다** | 새 주문이 안 생김 |
| 매출 집계 | 배송비가 별도 주문에 흩어짐 | 한 주문에 모임 |

### 권장은 B (Order Edit). 결정적인 이유는 오더데스크다

A로 가면 D169가 **오더데스크에 유령 주문으로 내려올 수 있다.** 아트워크가 없는 주문이므로
인테이크 게이트가 `isMissingFile` → Red → `manual`로 떨어뜨린다. 스태프 큐에 "파일 없는 주문"이
쌓이고, 그게 실은 배송 업그레이드 요금이다.

> **확인 필요:** 오더데스크 Shopify 연동이 초안 유래 주문을 걸러내는지. 안 걸러내면 A는 배제다.

B의 `orderEditAddShippingLine`은 기존 배송 라인을 **바꾸지 않고 한 줄 더 붙인다.** Kai가
"추가요금으로 붙어야 된다"고 한 것과 정확히 맞는다. 결제 시점에 원래 낸 $128.11이 그대로
보이고 그 아래 $33.96이 붙는다.

> **확인 필요:** `orderEditCommit(notifyCustomer: true)`가 실제로 어떤 메일을 보내는지,
> 아니면 `orderInvoiceSend`를 따로 호출해야 하는지. 테스트 주문으로 한 번 봐야 한다.

## Q2. 고객이 결제하면 오더데스크에 반영되나 — 아니오. 우리가 써야 한다

두 가지 이유로 **자동으로는 절대 안 간다:**

1. **오더데스크 Shopify 연동은 신규 주문만 내려받는다.** 주문 수정분은 재동기화되지 않는다.
   이건 이 프로젝트의 핵심 발견이고 `docs/shopify-intake-lambda.md`에 이미 기록돼 있다.
2. A로 가면 애초에 **다른 주문**이다. 원 주문의 `shipping_method`는 영원히 2-Day다.

→ **우리가 오더데스크에 `shipping_method`를 직접 쓴다.**

### 좋은 소식 1 — 그 쓰기 코드가 이미 있다

`src/shared/orderdesk-write.mjs`의 **`applyExpressUpgrade()`**. Linh의 레거시 `changeExpress`를
포팅한 것으로, 하는 일이 정확히 우리가 필요한 것이다:

```js
const updated = {
  ...order,
  shipping_method: upgrade.to,
  order_notes: [...order.order_notes, { username:'SBBot', date_added: stamp, content: upgrade.note }],
};
PUT /orders/{id}
```

킬스위치(`ORDERDESK_WRITES`)와 `DEMO-*`/`ZZ-*` 가드도 이미 통과한다. **노트 문구만 바꿔 재사용한다.**

> ⚠️ 단 이 함수는 `{...order}` 전체를 PUT한다 — `shopify-intake-lambda.md`의 H2와 같은
> lost update 패턴이다. 우리 코드에서도 같은 위험이 있으므로 **PUT 직전에 재조회해서 병합**해야
> 한다. 고객 결제와 오피스 수정이 겹칠 수 있는 구간이라 이건 이론이 아니다.

### 좋은 소식 2 — ShipStation 재동기화가 아예 필요 없다

Kai가 정한 컷오프가 여기서 값을 한다.

```
업그레이드 가능 구간 ──────┤ Awaiting Shipment ├──▶ ShipStation 전송
        ↑                        ↑
  여기서만 쓴다            여기서 처음 나간다
```

업그레이드는 **Awaiting Shipment 이전에만** 허용된다. 그 시점엔 주문이 **아직 ShipStation에
간 적이 없다.** 그래서 우리가 오더데스크에 값을 써두면, 나중에 창고가 폴더를 옮기는 순간
**이미 갱신된 값**이 전송된다.

**쓰기 한 번, 전파 문제 없음.** `Order Details Changed` 룰이 있는지 확인할 필요도 없다.

(주소 변경 프로젝트는 다르다. 주소는 G2a 이후에도 바뀌므로 재동기화가 필요하고, 그건
`Address Change` 룰이 처리한다 — `orderdesk-rules-audit.md` 발견 1.)

## 그래서 결제 후 순서

```
1. 고객 결제 (Shopify)
2. orders/paid 웹훅 수신
3. 오더데스크 폴더 재확인 ─── 이미 Awaiting Shipment면 중단하고 환불/에스컬레이션
4. 오더데스크 주문 재조회 → shipping_method 병합 → PUT   (applyExpressUpgrade)
5. 노트 추가: "Shipping upgraded 2-Day → 1-Day by customer, invoice D###/edit"
```

3번이 필수다. 결제와 창고의 폴더 이동이 경합할 수 있다.

## ★ 확정 — A(Draft Order), 그리고 결제가 먼저다 (Kai, 2026-09-14)

> "결제후 업데이트가 되는 식으로 바껴야지"

B(Order Edit)는 **편집 → 인보이스 → 결제** 순서를 강제한다. 없는 라인을 청구할 수 없기
때문이다. 그래서 고객이 결제를 안 하면 원 주문이 `$312.07 / partially_paid / 1-Day`인 채로
남는다. 버려지는 건수가 결제되는 건수보다 많을 테니 이게 상시 발생한다.

**A는 결제 전까지 원 주문을 건드리지 않는다.** 초안이 버려지면 그만이다.

### 그래서 순서가 이렇게 된다

```
1. 고객이 업그레이드 선택
2. draftOrderCreate — "Shipping Upgrade: 2-Day → 1-Day FedEx" $33.96
3. draftOrderInvoiceSend  →  D### 인보이스 메일         [SHOPIFY_WRITES]
   ── 여기까지 원 주문 S59131은 무손상 ──
4. 고객 결제
5. orders/paid 웹훅
6. 오더데스크 폴더 재확인 — 이미 Awaiting Shipment면 중단·환불
7. 오더데스크 재조회 → shipping_method 병합 → PUT      [ORDERDESK_UPGRADE_WRITES]
8. 노트: "Shipping upgraded 2-Day → 1-Day by customer (D###)"
```

**모든 상태 변경이 4번 뒤에 있다.** 3번까지는 언제 중단돼도 흔적이 인보이스 하나뿐이다.

## 스위치 세 개 (구현 완료)

`src/shared/write-gates.mjs`. 셋 다 기본 OFF, `"enabled"` 정확히 일치해야 무장,
`DEMO-*`/`ZZ-*`는 무조건 차단. 서로 완전히 독립이라 업그레이드만 켜도 인테이크는 안 깨어난다.

| 스위치 | 무장하는 것 | 위 순서의 |
| --- | --- | --- |
| `ORDERDESK_WRITES` | 인테이크 게이트 폴더·태그 이동 (기존) | — (계속 OFF) |
| `ORDERDESK_UPGRADE_WRITES` | 업그레이드 `shipping_method` PUT | 7번 |
| `SHOPIFY_WRITES` | 인보이스 발행 / 주문 편집 — **실제 돈** | 3번 |

## 남은 확인

| # | 내용 | 필요한 것 |
| --- | --- | --- |
| 1 | 오더데스크가 D### 초안 유래 주문을 내려받나 | 테스트 초안 1건 결제. 내려받으면 전용 폴더로 즉시 이동시킨다 |
| 2 | `applyExpressUpgrade`의 lost update | PUT 직전 재조회·병합으로 고친다 |
| 3 | 스위치 무장 | Kai의 명시적 go-live 승인 |

---

## 어느 알림 템플릿으로 나가는가

Kai가 보내준 **Order exceptions** 목록에는 우리가 쓸 것이 없다. 초안 주문 인보이스는
그 그룹이 아니라 **Draft orders** 그룹에 있다 — 앞서 붙여준 `Invoice #D169` 템플릿이 그것이다.

| Order exceptions 항목 | 우리 경로에서 |
| --- | --- |
| **Order invoice** (미결제 잔액) | ❌ Order Edit(B) 경로의 메일. 우리는 A로 간다 |
| **Order edited** (주문 편집 시) | ⚠️ 아래 참조 — 발화시키지 않는다 |
| Order payment receipt / refund / canceled | 평소대로. 우리가 트리거하지 않음 |

**→ 청구 메일 = Draft order invoice (`Invoice #D###`). 손댈 템플릿이 없다.**

### 결제 후 원 주문(S59131)은 어떻게 하나

A 경로에서는 돈이 D###로 들어오므로 **S59131의 Shopify 기록은 2-Day인 채 남는다.**
운영은 오더데스크가 진실이라 안 깨지지만, Shopify와 갈라지는 건 이 프로젝트가 없애려던
바로 그 문제다.

여기서 S59131에 배송 라인을 추가하면 **회수되지 않을 $33.96 미수금**이 생긴다 — 돈은 이미
D###로 받았기 때문이다. 그래서 편집이 아니라 **태그 + 노트**를 쓴다:

```
tag  : SHIPPING-UPGRADED-1DAY
note : Upgraded 2-Day → 1-Day via D169 (customer self-service)
```

금액 변동 없음 → `Order edited` 메일도 안 나간다. 고객은 이미 D### 영수증을 받았으므로
두 번째 메일은 혼란만 준다.

## 결제 → 반영까지 얼마나 걸리나

**보통 수 초. 다만 보장은 아니고, 보장될 필요도 없다.**

| 구간 | 보통 | 나쁠 때 |
| --- | --- | --- |
| 결제 → Shopify `orders/paid` 웹훅 도착 | 수 초 | Shopify 큐가 밀리면 수 분. 실패 시 재시도는 48시간에 걸쳐 띄엄띄엄 |
| Lambda 콜드 스타트 | 0 | +1~3초 |
| 오더데스크 폴더 재확인 (GET) | ~0.5초 | 429 재시도 시 최대 60초 |
| 주문 재조회 → 병합 → PUT | ~1초 | 〃 |

### 왜 빠른가 — 주문을 "찾지" 않기 때문이다

외부 인테이크 Lambda는 주문을 찾는 데 3단 폴백과 최대 5회 재시도(2s→15s)를 쓴다. 우리는
그럴 필요가 없다. **고객이 우리 페이지를 열었다는 것 자체가 어느 주문인지 알려준다.**
오더데스크 주문 id를 이미 들고 있으므로 검색도, 모호성 판정도 없다. GET 하나, PUT 하나다.

### 그리고 속도는 사실 위험 요소가 아니다

10초든 3분이든 그 사이에 주문이 출고되지 않는다. **진짜 경합 상대는 창고가 폴더를
`Awaiting Shipment`로 옮기는 순간**이고, 그건 보통 몇 시간 뒤다.

그래서 시간을 줄이는 대신 **두 번 확인한다**: 인보이스를 보내기 직전에 한 번, 결제 웹훅을
받고 쓰기 직전에 다시 한 번. 두 번째에서 이미 옮겨졌으면 쓰지 않고 에스컬레이션한다.
웹훅이 3분 늦게 와도 잘못된 값을 쓰는 일은 없다.

### 오더데스크 금액도 맞춘다 (Kai 확정, 2026-09-14)

`shipping_method`만 고치면 오더데스크 총액이 고객이 실제로 낸 금액과 어긋난다. 차액을
두 필드에 같이 반영한다:

| 필드 | 예시 |
| --- | --- |
| `shipping_method` | `2-day Shipping` → `1-day Shipping` |
| `shipping_total` | 128.11 → **162.07** |
| `order_total` | 278.11 → **312.07** |

구현: `applyShippingUpgrade()` (`src/shared/orderdesk-write.mjs`).
`ORDERDESK_UPGRADE_WRITES` 게이트, `DEMO-*`/`ZZ-*` 차단.

**금액은 센트 정수로 계산한다.** `278.11 + 33.96`을 부동소수로 하면
`312.06999999999996`이 나온다. 돈에서 이건 허용되지 않는다.

`shipping_total`은 **레코드에 그 필드가 실제로 있을 때만** 건드린다. 없는 스토어에
없던 필드를 만들지 않는다. (`order_total`/`product_total`은 `cleanOrder`가 실주문에서
읽고 있어 존재가 확인됐다. `shipping_total`은 아직 실물 확인 전.)

### 세 가지를 더 한다

**1. 쓰기 직전에 재조회한다.** 레거시는 아까 읽은 레코드를 통째로 PUT해서, 그 사이 오피스가
고친 것을 되돌린다(`shopify-intake-lambda.md` H2). 이 함수는 결제 시점에 새로 GET한 사본에
병합한다. 스태프가 같은 주문을 만지는 시간대라 이 창은 실재한다.

**2. 중복 웹훅을 거부한다.** Shopify는 같은 웹훅을 두 번 보내는 일이 드물지 않다. 그대로
두면 **차액이 총액에 두 번 더해진다.** 인보이스 번호(`D169`)를 노트에서 찾아, 이미 있으면
읽기만 하고 쓰지 않는다.

**3. 폴더는 건드리지 않는다.** 테스트가 `folder_id`가 그대로인지 검증한다.

### 폴더 이동이 필요한 경우 / 아닌 경우

| 주문 위치 | 폴더 이동 | 왜 |
| --- | --- | --- |
| **이미 시설 폴더(GA/NJ/TX/NV/CA)** | **없음** | 사다리 규칙: 기존 생산팀 유지 |
| 아직 QTS · Today · Tomorrow (미라우팅) | **우리는 안 옮긴다** | 나중에 라우팅 캐스케이드가 새 `shipping_method`로 판정한다. 그 결과가 달라질 수는 있지만(1-day는 NV로) 그건 기존 룰이 하는 일이지 우리가 옮기는 게 아니다 |
| Awaiting Shipment 이후 | 해당 없음 | 업그레이드 자체가 차단됨 |

**즉 우리 코드는 어떤 경우에도 폴더를 옮기지 않는다.** `shipping_method` PUT 하나뿐이다.

> **Kai 확인:** "폴더 이동이 필요한 것도 있다"고 하신 게 위 2행(미라우팅 주문이 라우팅
> 캐스케이드에서 NV로 갈 수 있는 경우)을 말씀하신 게 맞는지. 다른 케이스가 있으면 알려주세요.
