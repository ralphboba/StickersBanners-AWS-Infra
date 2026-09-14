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

## 열린 결정

| # | 내용 | 필요한 것 |
| --- | --- | --- |
| 1 | A(Draft Order) vs **B(Order Edit)** | 오더데스크가 초안 유래 주문을 내려받는지 확인 |
| 2 | `orderEditCommit`이 보내는 메일 | 테스트 주문 1건 |
| 3 | **`ORDERDESK_WRITES` 무장** | 이 기능은 쓰기가 필수다. Kai의 명시적 go-live 승인 필요 |
