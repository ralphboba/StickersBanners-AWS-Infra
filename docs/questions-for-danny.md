# Danny에게 물어볼 것

배송 업그레이드 셀프서비스 관련. **앞의 두 개는 출시를 막고**, 뒤의 두 개는 문구라
기본값으로 가도 되지만 Danny가 정하는 게 맞다.

`questions-for-linh.md`와 짝. Linh 쪽은 라우팅 정합성, 이쪽은 **무엇을 팔아도 되는가**다.

---

## 1. Limitations — 절대 팔면 안 되는 것 ⚠️ 최우선

여기서 잘못 "된다"고 하면 **돈부터 받고 나서 그 서비스가 거기 안 간다는 걸 알게 된다.**
환불 + 사과 전화 + 신뢰 손실이다. 처음엔 과하게 막는 편이 낫다.

- 1-Day·2-Days가 **실제로 못 가는 지역**이 있나? 지금은 어떻게 판단하나 — ZIP 목록? FedEx 조회? 경험?
- **PO box, APO/FPO**, 오버나이트를 안 받는 주소 유형
- **크기·중량** 때문에 물리적으로 1-Day가 불가능한 배너 (오버사이즈, 화물, 일정 길이 초과)
- **B2SIGN 품목 · DC 주문 · lower 48 밖** — 통째로 제외할 것인가
- **픽업 주문** — 픽업↔배송 전환을 열 것인가, 손대지 말 것인가
- **시각 컷오프** — 몇 시 이후엔 업그레이드해도 실제로 더 빨리 안 나가나

## 2. 애드온 목록 ⚠️ 출시 차단

확인 메일에 **"주문에 제품을 추가할 수 있다"고 이미 문구가 들어간다.** 페이지에
placeholder인 채로 나갈 수 없다.

- 어떤 품목 — 스탠드, 카펫, 그 외?
- **개당 가격.** 배너에 따라 달라지나?
- 돈 받기 전에 **사람이 봐야 하는 품목**이 있나?

> 참고: 오더데스크에 이미 `Adding 8' Stand` / `Adding 8' Carpet` 같은 룰이
> STAND/CARPET variation으로 존재한다(`orderdesk-rules-audit.md` 발견 7).
> 그 메커니즘을 재사용할 수 있는지는 Linh 확인 대상.

## 3. 인보이스 라인 문구

고객 인보이스에 실제로 찍히는 텍스트. 지금 쓰는 표현이 있으면 그걸 쓴다.
없으면 기본값: `Shipping Upgrade: 2-Days → 1-Day`

## 4. 이메일 버튼 라벨

`Manage my order` / `Change my order` / `Upgrade my shipping`

블록이 배송 업그레이드 **와** 제품 추가 둘 다 광고하므로, 세 번째는 절반만 설명한다.

---

## 영문 — 그대로 전달용

> Hi Danny,
>
> We're building a page where customers upgrade their own shipping and get the invoice
> automatically, so they stop having to call in. Two things I can't decide without you,
> and two small wording calls.
>
> **1. What must it never offer?**
>
> This is the one that worries me. A wrong "yes" means we take the money and *then* find out
> the service doesn't run to them.
>
> The plan is one step up only: Ground → 3-Days → 2-Days → 1-Day. Saturday Overnight isn't
> offered at all.
>
> - **Destinations** — anywhere 1-Day or 2-Days can't actually reach in time? How do you tell
>   today: a ZIP list, a FedEx lookup, or experience?
> - **Address types** — PO boxes, APO/FPO, anything a courier won't take overnight?
> - **Size and weight** — banners that physically can't go 1-Day? Oversize, freight, rolled
>   over a certain length?
> - **Product types** — should B2SIGN items, DC orders, or anything outside the lower 48 be
>   excluded entirely?
> - **Pickup orders** — offer them pickup-to-delivery, or leave them alone?
> - **Time of day** — is there a point after which an upgrade won't actually make it ship sooner?
>
> If you'd rather over-restrict at the start, say so. I'd much rather add options later than
> refund someone.
>
> **2. Add-ons — what can customers add themselves?**
>
> The confirmation email will tell them they can add a product to their order, so this can't
> ship empty.
>
> - Which items — stands, carpets, anything else?
> - Price for each. Does it depend on the banner?
> - Any that need a person to look before we take the money?
>
> **3 and 4. Two wording calls**
>
> - **Invoice line** — what the customer sees on the invoice. Any phrase you already use?
>   Otherwise: `Shipping Upgrade: 2-Days → 1-Day`
> - **Email button** — `Manage my order` / `Change my order` / `Upgrade my shipping`
>
> One thing already settled, so you know: **once an order hits Awaiting Shipment the page locks
> it.** No changes after that — cancel at 50% or a re-order, and cancelling stays with your team
> rather than becoming a button.
>
> Thanks,
> Kai
