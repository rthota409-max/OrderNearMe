import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileGroupBill } from "../src/services/billReconciliation.js";

describe("billReconciliation service", () => {
  it("reconciles merchandise subtotal, threshold check, and exact zero-residual sum with 3 members", () => {
    const members = [
      { uid: "host-1", name: "Rahul (Host)", amount: 100, items: "Milk & Eggs" },
      { uid: "joiner-1", name: "Aman", amount: 60, items: "Maggi & Chips" },
      { uid: "joiner-2", name: "Priya", amount: 40, items: "Biscuits" }
    ];

    const breakdown = {
      deliveryFee: 0,
      handlingFee: 10,
      packagingFee: 5,
      surgeFee: 0,
      discountAmount: 4,
      isConfirmed: true
    };

    const result = reconcileGroupBill(members, breakdown, 199);

    assert.equal(result.merchandiseSubtotal, 200);
    assert.equal(result.freeDeliveryThreshold, 199);
    assert.equal(result.thresholdReached, true);
    assert.equal(result.amountNeededForFreeDelivery, 0);
    assert.equal(result.totalFees, 15);
    assert.equal(result.discountAmount, 4);
    // Net adjustment = 15 - 4 = 11.
    // finalCheckoutTotal = 200 + 11 = 211.
    assert.equal(result.finalCheckoutTotal, 211);

    // Sum of member breakdowns must equal 211 exactly
    const sumAllocated = result.memberBreakdowns.reduce((acc, m) => acc + m.finalAmountOwed, 0);
    assert.equal(sumAllocated, 211, "Individual contributions must sum exactly to the final bill");
  });

  it("handles odd fee remainders without leaving any unassigned cents or rupees", () => {
    const members = [
      { uid: "u1", name: "User 1", amount: 45 },
      { uid: "u2", name: "User 2", amount: 45 },
      { uid: "u3", name: "User 3", amount: 45 },
      { uid: "u4", name: "User 4", amount: 45 }
    ];

    // Shared net fee = 15. 15 / 4 = 3 remainder 3.
    const breakdown = {
      deliveryFee: 15,
      handlingFee: 0,
      discountAmount: 0,
      isConfirmed: true
    };

    const result = reconcileGroupBill(members, breakdown, 199);
    assert.equal(result.merchandiseSubtotal, 180);
    assert.equal(result.finalCheckoutTotal, 195);

    const sumAllocated = result.memberBreakdowns.reduce((acc, m) => acc + m.finalAmountOwed, 0);
    assert.equal(sumAllocated, 195, "Even with remainders, sum must equal 195 exactly");
  });

  it("applies threshold strictly to eligible merchandise, not delivery fees or taxes", () => {
    const members = [
      { uid: "u1", name: "User 1", amount: 180 }
    ];

    // Total fees = 30. Total = 210, BUT merchandise is 180 < 199.
    const breakdown = {
      deliveryFee: 30,
      isConfirmed: false
    };

    const result = reconcileGroupBill(members, breakdown, 199);
    assert.equal(result.thresholdReached, false, "Merchandise of 180 does not reach 199 threshold");
    assert.equal(result.amountNeededForFreeDelivery, 19);
  });
});
