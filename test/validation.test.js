import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateOrderForm, validateJoinRequest } from "../src/services/validation.js";
import { getOrderJoinableStatus, isValidOrderTransition, ORDER_STATUS } from "../src/constants/orderLifecycle.js";

describe("validation and lifecycle services", () => {
  it("rejects non-grocery platform requests", () => {
    const invalidOrder = {
      category: "other",
      platform: "OtherApp",
      myAmount: 80,
      targetAmount: 199,
      waitMinutes: 15,
      pickupPoint: "Hostel Gate"
    };
    const res = validateOrderForm(invalidOrder);
    assert.equal(res.valid, false);
    assert.match(res.error, /only grocery orders/i);
  });

  it("rejects amounts below MIN_CART_AMOUNT", () => {
    const res = validateOrderForm({
      category: "grocery",
      platform: "Blinkit",
      myAmount: 10,
      targetAmount: 199,
      waitMinutes: 15,
      pickupPoint: "Hostel Gate"
    });
    assert.equal(res.valid, false);
    assert.match(res.error, /at least ₹15/i);
  });

  it("validates join requests require stockConfirmed = true", () => {
    const order = { id: "o1", currentCart: 80, myAmount: 80, targetAmount: 199 };
    const res = validateJoinRequest({
      contributionAmount: 30,
      itemsList: "1 Bingo Mad Angles",
      stockConfirmed: false
    }, order);
    assert.equal(res.valid, false);
    assert.match(res.error, /stock/i);
  });

  it("accurately identifies expired orders and target-reached orders as non-joinable", () => {
    const now = 100000;
    const expiredOrder = {
      status: ORDER_STATUS.OPEN,
      expiresAtMs: 99999, // in past
      memberCount: 1,
      maxMembers: 6,
      currentCart: 80,
      targetAmount: 199
    };
    const status1 = getOrderJoinableStatus(expiredOrder, now);
    assert.equal(status1.joinable, false);
    assert.equal(status1.code, "EXPIRED");

    // Test 5: Target-reached order cannot accept another member
    const targetReachedOrder = {
      status: ORDER_STATUS.OPEN,
      expiresAtMs: 120000,
      memberCount: 2,
      maxMembers: 6,
      currentCart: 205,
      targetAmount: 199
    };
    const status2 = getOrderJoinableStatus(targetReachedOrder, now);
    assert.equal(status2.joinable, false);
    assert.equal(status2.code, "TARGET_REACHED");
  });

  it("prevents illegal order transitions like reopening a completed order", () => {
    assert.equal(isValidOrderTransition(ORDER_STATUS.COMPLETED, ORDER_STATUS.OPEN), false);
    assert.equal(isValidOrderTransition(ORDER_STATUS.CHECKOUT, ORDER_STATUS.OPEN), false);
    assert.equal(isValidOrderTransition(ORDER_STATUS.OPEN, ORDER_STATUS.MATCHED), true);
    assert.equal(isValidOrderTransition(ORDER_STATUS.MATCHED, ORDER_STATUS.CHECKOUT), true);
    assert.equal(isValidOrderTransition(ORDER_STATUS.CHECKOUT, ORDER_STATUS.ORDERED), true);
    assert.equal(isValidOrderTransition(ORDER_STATUS.ORDERED, ORDER_STATUS.DELIVERED), true);
    assert.equal(isValidOrderTransition(ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED), true);
  });
});
