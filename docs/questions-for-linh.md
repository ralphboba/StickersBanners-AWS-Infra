# Linh에게 물어볼 것

여러 문서에 흩어져 있던 "Linh 확인 필요" 항목을 모은 것. **대부분 실주문의 생산지나 청구
금액이 바뀌는 문제**라서, 답이 오기 전에는 코드를 고치지 않는다(기존 원칙).

출처: `orderdesk-rules-audit.md` 불일치 1–6, `legacy-collision-audit.md` C5,
`order-lifecycle-and-refunds.md` 미확정 8.

아래 영문 그대로 보내면 된다.

---

## A. 라우팅 — 실제 룰이 Linh가 준 목록과 다르다 (가장 시급)

**1. Montana.** OrderDesk의 TX 주 목록에 `MT`가 있는데 NV 목록에도 있다. Linh가 보내준
   TX 목록에는 MT가 없었다. 몬태나 주문이 실제로 어디서 만들어지나? 룰 두 개에 다 걸려서
   실행 순서에 따라 갈릴 수 있다.

**2. See-thru.** `docs/linh-requirements.md`에는 **see-thru → NV**로 적혀 있고 우리 코드도
   그렇다. 그런데 실제 룰 `CA to TX See through order to Texas for sales rep`은
   CA 폴더 + see-thru + 픽업 아님 → **TX**로 보낸다. 어느 쪽이 맞나?

**3. Sticker.** `Sticker back to GA` 룰이 NJ/TX/CA/NV 폴더의 STICKER 품목을 GA로 되돌린다.
   우리 인테이크 게이트는 스티커를 특수 상품으로 보고 `sales` 폴더로 보낸다. 두 규칙이
   충돌하나, 아니면 서로 다른 단계인가?

**4. Double-Sided X-Banners.** `Double-Sided X-Banners back to GA` (TX/CA 폴더) — 우리
   코드에 없다. 상시 규칙인가?

**5. Weather TX Express to GA.** 이름상 한시적 룰인데 아직 살아 있다. 지금도 유효한가?

**6. `Today - NV (Copy)` / `Tomorrow - CA`.** 룰 이름과 조건이 어긋나 있다
   (`Today - NV (Copy)` 조건에 CA가 들어 있고, `Tomorrow - CA` 조건에 NV 주 목록이 있다).
   의도한 것인가?

## B. 룰 위생

**7. 중복 룰.** `(Copy)` / `(New Site)` 접미사 룰이 아주 많다
   (`GA Awaiting Shipment (New Site)`, `Proof (New Site)`,
   `Approved from the website (Copy) (Copy)` 등). 둘 다 도는가, 하나는 죽은 룰인가?
   **우리가 룰을 추가하기 전에 정리되어야 어떤 게 실제 경로인지 알 수 있다.**

**8. 애드온 룰.** `Adding 8' Stand` 등 STAND/CARPET variation 룰이 `z.Test` 커스텀 버튼
   아래에 있다. 자동으로 도는가, 사람이 버튼을 눌러야 하는가?
   → 고객 셀프 애드온이 이 메커니즘을 재사용할 수 있는지가 여기 달렸다.

## C. 배송 방법 문자열

**9. `changeExpress`가 쓰는 값.** 실제 스토어는 `FedEx Ground / FedEx 3-Days /
   FedEx 2-Days / FedEx 1-Day`를 쓴다(Kai 확인). 그런데 레거시 익스프레스 업그레이드는
   `'2-day Shipping'`을 쓴다 — **넷 중 아무것도 아니다.**
   원래부터 그랬나, 아니면 스토어 표기가 나중에 바뀐 건가?
   지금은 `ORDERDESK_WRITES`가 꺼져 있어 쓰인 적이 없지만, 인테이크 go-live 때 고쳐야 한다.

**10. 3–6pm ET 익스프레스 컷오프.** 3-day 주문을 무료로 2-day로 올려주는 규칙이 지금도
   유효한가? 우리 고객 업그레이드 페이지가 **같은 단계를 유료로 팔기 때문에**, 라우팅 전
   주문에는 3-Day 업그레이드를 숨겨놨다. 이 규칙이 폐지됐다면 그 가드를 뺄 수 있다.

## D. 공존과 컷오버

**11. 레거시 봇 컷오버 일정.** 두 프로그램이 같이 도는 동안에는 우리 게이트가 봇을 막지
   못한다. 언제 끄나?

**12. CA·NV 라벨 경로.** ShipStation store id가 GA(68977)/NJ(68987)/TX(68986)만 있다.
   CA는 별도 OrderDesk 스토어로 가는 것으로 보이는데, **CA·NV는 라벨을 어디서 뽑나?**

---

## 영문 — 그대로 전달용

> Hi Linh,
>
> I'm mapping the current OrderDesk rules against the routing logic we ported from your program,
> and a few things don't line up. These all decide where a real order gets made, so I don't want
> to change anything until you tell me which is right.
>
> **Routing**
>
> 1. **Montana.** Your TX state list didn't include MT, but the live TX rule does — and so does
>    the NV rule. Where should a Montana order actually be produced? Right now both rules match it.
> 2. **See-thru.** Your notes say see-thru goes to NV, and that's what we built. But the rule
>    `CA to TX See through order to Texas for sales rep` sends CA-folder see-thru orders to TX
>    instead. Which is correct?
> 3. **Stickers.** `Sticker back to GA` pulls STICKER items out of NJ/TX/CA/NV back to GA. Our
>    intake gate treats stickers as a special product and sends them to Sales. Do these conflict,
>    or are they different stages?
> 4. **Double-Sided X-Banners back to GA** (TX/CA) isn't in our code at all. Is it a standing rule?
> 5. **Weather TX Express to GA** sounds like it was temporary, but it's still active. Still valid?
> 6. **`Today - NV (Copy)` and `Tomorrow - CA`** have conditions that don't match their names —
>    the NV rule tests CA, and the CA rule tests the NV state list. Intentional?
>
> **Rules hygiene**
>
> 7. There are a lot of `(Copy)` and `(New Site)` duplicates — `GA Awaiting Shipment (New Site)`,
>    `Proof (New Site)`, `Approved from the website (Copy) (Copy)`. Do both fire, or is one dead?
>    I'd rather not add rules on top of a set where I can't tell which path is live.
> 8. The add-on rules (`Adding 8' Stand`, `Adding 8' Carpet`, …) sit under the `z.Test` custom
>    button. Do they run automatically, or does someone have to press it? We're planning to let
>    customers add a stand themselves, and I'd rather reuse this than invent a second mechanism.
>
> **Shipping method text**
>
> 9. The store stores `FedEx Ground / FedEx 3-Days / FedEx 2-Days / FedEx 1-Day`, but
>    `changeExpress` writes `2-day Shipping`, which isn't any of them. Was it always like that, or
>    did the store's naming change later? It hasn't caused damage — that write is still switched
>    off on our side — but it needs fixing before we turn intake on.
> 10. Is the **3-6pm ET express cutoff** (3-day upgraded to 2-day for free) still in force? We're
>    about to let customers buy that same step, so right now we hide the 3-Day upgrade on any
>    order that hasn't been routed yet, to avoid charging for something they'd have got free. If
>    the rule is retired, we can drop that.
>
> **Coexistence**
>
> 11. What's the timeline for switching the old bot off? While both run, our gate can't hold it back.
> 12. ShipStation store ids exist for GA, NJ and TX only. CA seems to go to a separate OrderDesk
>    store — **where do CA and NV labels get printed?**
>
> Thanks,
> Kai
