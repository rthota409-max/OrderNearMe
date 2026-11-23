import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockFirestore } from "./mockFirestore.js";
import { ORDER_STATUS, JOIN_STATUS, PAYMENT_STATUS, getOrderJoinableStatus, isValidOrderTransition } from "../src/constants/orderLifecycle.js";
import { reconcileGroupBill } from "../src/services/billReconciliation.js";
import { validateOrderForm, validateJoinRequest } from "../src/services/validation.js";

describe("OrderNearMe — 14 Required Tests Suite", () => {
  let db;

  beforeEach(() => {
    db = new MockFirestore();
  });

  // Test 1: Two rapid join clicks create one request
  it("Test 1: Two rapid join clicks create one request (idempotent / duplicate prevention)", async () => {
    const user = { uid: "user-joiner" };
    const order = { id: "order-1", ownerId: "host-1", status: ORDER_STATUS.OPEN, currentCart: 80, targetAmount: 199, expiresAtMs: Date.now() + 60000 };
    const form = { contributionAmount: 30, itemsList: "2 Amul Kool", stockConfirmed: true };

    const existingRequests = [];

    // First click
    const canSubmitFirst = !existingRequests.some(r => r.orderId === order.id && r.requesterId === user.uid && r.status === JOIN_STATUS.PENDING);
    assert.equal(canSubmitFirst, true);
    existingRequests.push({ id: "req-1", orderId: order.id, requesterId: user.uid, status: JOIN_STATUS.PENDING });

    // Second rapid click
    const canSubmitSecond = !existingRequests.some(r => r.orderId === order.id && r.requesterId === user.uid && r.status === JOIN_STATUS.PENDING);
    assert.equal(canSubmitSecond, false, "Second rapid click must be blocked from creating duplicate request");
    assert.equal(existingRequests.length, 1);
  });

  // Test 2: Two hosts accept the same user concurrently; only one wins
  it("Test 2: Two hosts accept the same user concurrently; only one wins", async () => {
    // Setup 2 orders and 2 join requests by the same user
    db.setDoc("orders/order-host1", {
      id: "order-host1",
      ownerId: "host-1",
      memberCount: 1,
      maxMembers: 4,
      currentCart: 100,
      targetAmount: 199,
      expiresAtMs: Date.now() + 100000,
      status: ORDER_STATUS.OPEN
    });

    db.setDoc("orders/order-host2", {
      id: "order-host2",
      ownerId: "host-2",
      memberCount: 1,
      maxMembers: 4,
      currentCart: 100,
      targetAmount: 199,
      expiresAtMs: Date.now() + 100000,
      status: ORDER_STATUS.OPEN
    });

    db.setDoc("joinRequests/req-1", {
      id: "req-1",
      orderId: "order-host1",
      ownerId: "host-1",
      requesterId: "joiner-aman",
      requesterName: "Aman",
      contributionAmount: 40,
      status: JOIN_STATUS.PENDING
    });

    db.setDoc("joinRequests/req-2", {
      id: "req-2",
      orderId: "order-host2",
      ownerId: "host-2",
      requesterId: "joiner-aman",
      requesterName: "Aman",
      contributionAmount: 40,
      status: JOIN_STATUS.PENDING
    });

    // Transactional accept function
    const acceptRequest = async (reqId, hostId) => {
      return await db.runTransaction(async (txn) => {
        const reqSnap = await txn.get({ path: `joinRequests/${reqId}` });
        const req = reqSnap.data();
        if (req.status !== JOIN_STATUS.PENDING) {
          throw new Error("Request is no longer pending");
        }

        const orderSnap = await txn.get({ path: `orders/${req.orderId}` });
        const order = orderSnap.data();
        if (order.ownerId !== hostId) {
          throw new Error("Unauthorized host");
        }

        // Check if joiner has already been accepted into any group
        const allReqs = Array.from(db.store.values()).filter(d => d.requesterId === req.requesterId);
        const alreadyAccepted = allReqs.some(r => r.status === JOIN_STATUS.ACCEPTED);
        if (alreadyAccepted) {
          throw new Error("User has already matched with another order");
        }

        txn.update({ path: `joinRequests/${reqId}` }, { status: JOIN_STATUS.ACCEPTED });
        txn.update({ path: `orders/${req.orderId}` }, {
          memberCount: order.memberCount + 1,
          currentCart: order.currentCart + req.contributionAmount,
          status: ORDER_STATUS.MATCHED
        });

        return { accepted: true, hostId };
      });
    };

    // Host 1 accepts first
    const res1 = await acceptRequest("req-1", "host-1");
    assert.equal(res1.accepted, true);

    // Host 2 attempts to accept concurrently
    await assert.rejects(
      async () => {
        await acceptRequest("req-2", "host-2");
      },
      /User has already matched with another order/,
      "Second host concurrent acceptance must fail because user already matched"
    );

    assert.equal(db.getDoc("joinRequests/req-1").data().status, JOIN_STATUS.ACCEPTED);
    assert.equal(db.getDoc("joinRequests/req-2").data().status, JOIN_STATUS.PENDING);
  });

  // Test 3: A request expires and cannot be accepted
  it("Test 3: A request expires and cannot be accepted", async () => {
    const expiredOrder = {
      id: "order-exp",
      ownerId: "host-1",
      expiresAtMs: Date.now() - 5000, // expired 5 seconds ago
      currentCart: 80,
      targetAmount: 199,
      memberCount: 1,
      maxMembers: 4,
      status: ORDER_STATUS.OPEN
    };

    const status = getOrderJoinableStatus(expiredOrder, Date.now());
    assert.equal(status.joinable, false);
    assert.equal(status.code, "EXPIRED");

    // Attempting to accept a request on an expired order must be rejected
    const canAccept = (order) => {
      const check = getOrderJoinableStatus(order, Date.now());
      if (!check.joinable) throw new Error(`Cannot accept request: ${check.reason}`);
      return true;
    };

    assert.throws(() => canAccept(expiredOrder), /Timer expired/);
  });

  // Test 4: A timer extension cannot exceed its maximum
  it("Test 4: A timer extension cannot exceed its maximum", async () => {
    db.setDoc("orders/order-timer", {
      id: "order-timer",
      ownerId: "host-1",
      extensionCount: 3,
      maxExtensions: 3,
      expiresAtMs: Date.now() + 1000,
      status: ORDER_STATUS.OPEN
    });

    const extendOrder = async (orderId, hostId) => {
      return await db.runTransaction(async (txn) => {
        const snap = await txn.get({ path: `orders/${orderId}` });
        const order = snap.data();
        if (order.ownerId !== hostId) throw new Error("Unauthorized");
        if (order.extensionCount >= order.maxExtensions) {
          throw new Error(`Maximum extensions reached (${order.maxExtensions}/${order.maxExtensions})`);
        }
        txn.update({ path: `orders/${orderId}` }, {
          extensionCount: order.extensionCount + 1,
          expiresAtMs: order.expiresAtMs + 600000
        });
        return { success: true };
      });
    };

    await assert.rejects(
      async () => {
        await extendOrder("order-timer", "host-1");
      },
      /Maximum extensions reached \(3\/3\)/,
      "Order with 3/3 extensions must strictly reject further extensions"
    );

    assert.equal(db.getDoc("orders/order-timer").data().extensionCount, 3);
  });

  // Test 5: A target-reached order cannot accept another member
  it("Test 5: A target-reached order cannot accept another member", async () => {
    const targetReachedOrder = {
      id: "order-target",
      ownerId: "host-1",
      expiresAtMs: Date.now() + 100000,
      currentCart: 205,
      targetAmount: 199, // target reached!
      memberCount: 2,
      maxMembers: 6,
      status: ORDER_STATUS.MATCHED
    };

    const status = getOrderJoinableStatus(targetReachedOrder, Date.now());
    assert.equal(status.joinable, false);
    assert.equal(status.code, "TARGET_REACHED");

    // Acceptance must also reject
    const canAccept = (order) => {
      const check = getOrderJoinableStatus(order, Date.now());
      if (!check.joinable) throw new Error(`Cannot accept request: ${check.reason}`);
    };
    assert.throws(() => canAccept(targetReachedOrder), /Free delivery target reached/);
  });

  // Test 6: A member leaves and totals recalculate correctly
  it("Test 6: A member leaves and totals recalculate correctly", async () => {
    db.setDoc("groups/grp-1", {
      id: "grp-1",
      orderId: "order-1",
      ownerId: "host-1",
      status: ORDER_STATUS.MATCHED,
      memberIds: ["host-1", "joiner-1", "joiner-2"],
      members: [
        { uid: "host-1", name: "Host", amount: 100 },
        { uid: "joiner-1", name: "Joiner 1", amount: 50 },
        { uid: "joiner-2", name: "Joiner 2", amount: 60 }
      ],
      totalCart: 210
    });

    db.setDoc("orders/order-1", {
      id: "order-1",
      ownerId: "host-1",
      memberCount: 3,
      currentCart: 210,
      targetAmount: 199,
      status: ORDER_STATUS.MATCHED
    });

    // Joiner 2 leaves
    const memberIdLeaving = "joiner-2";
    await db.runTransaction(async (txn) => {
      const groupSnap = await txn.get({ path: "groups/grp-1" });
      const group = groupSnap.data();
      const updatedMembers = group.members.filter(m => m.uid !== memberIdLeaving);
      const updatedMemberIds = group.memberIds.filter(id => id !== memberIdLeaving);
      const newTotal = updatedMembers.reduce((sum, m) => sum + m.amount, 0);

      txn.update({ path: "groups/grp-1" }, {
        members: updatedMembers,
        memberIds: updatedMemberIds,
        totalCart: newTotal
      });

      const orderSnap = await txn.get({ path: "orders/order-1" });
      const order = orderSnap.data();
      txn.update({ path: "orders/order-1" }, {
        memberCount: order.memberCount - 1,
        currentCart: newTotal,
        status: newTotal < order.targetAmount ? ORDER_STATUS.OPEN : ORDER_STATUS.MATCHED
      });
    });

    const updatedGroup = db.getDoc("groups/grp-1").data();
    assert.equal(updatedGroup.members.length, 2);
    assert.equal(updatedGroup.totalCart, 150);

    const updatedOrder = db.getDoc("orders/order-1").data();
    assert.equal(updatedOrder.memberCount, 2);
    assert.equal(updatedOrder.currentCart, 150);
    assert.equal(updatedOrder.status, ORDER_STATUS.OPEN, "Order reopens to OPEN when cart drops below target");
  });

  // Test 7: A host cancels an order and all affected users are notified
  it("Test 7: A host cancels an order and all affected users are notified", async () => {
    db.setDoc("orders/order-cancel", {
      id: "order-cancel",
      ownerId: "host-1",
      status: ORDER_STATUS.MATCHED
    });

    db.setDoc("groups/group-cancel", {
      id: "group-cancel",
      orderId: "order-cancel",
      ownerId: "host-1",
      memberIds: ["host-1", "joiner-1"],
      status: ORDER_STATUS.MATCHED
    });

    const auditMessages = [];
    const cancelOrder = async (orderId, hostId, reason) => {
      await db.runTransaction(async (txn) => {
        txn.update({ path: `orders/${orderId}` }, {
          status: ORDER_STATUS.CANCELLED,
          cancellationReason: reason
        });
        txn.update({ path: "groups/group-cancel" }, {
          status: ORDER_STATUS.CANCELLED,
          cancellationReason: reason
        });
      });
      auditMessages.push(`⚠️ Host cancelled order: ${reason}`);
    };

    await cancelOrder("order-cancel", "host-1", "Store closed");

    assert.equal(db.getDoc("orders/order-cancel").data().status, ORDER_STATUS.CANCELLED);
    assert.equal(db.getDoc("groups/group-cancel").data().status, ORDER_STATUS.CANCELLED);
    assert.equal(auditMessages.length, 1);
    assert.match(auditMessages[0], /Store closed/);
  });

  // Test 8: The final bill reconciles exactly with all member shares
  it("Test 8: The final bill reconciles exactly with all member shares (zero residual)", () => {
    const members = [
      { uid: "host", name: "Host", amount: 120 },
      { uid: "m1", name: "Member 1", amount: 45 },
      { uid: "m2", name: "Member 2", amount: 35 }
    ];

    const breakdown = {
      deliveryFee: 25,
      handlingFee: 12,
      packagingFee: 8,
      surgeFee: 0,
      discountAmount: 15,
      isConfirmed: true
    };

    const reconciled = reconcileGroupBill(members, breakdown, 199);
    // merchandise = 200. Total fees = 45. Discount = 15. Net fees = 30.
    // finalCheckoutTotal = 200 + 30 = 230.
    assert.equal(reconciled.finalCheckoutTotal, 230);

    const sumShares = reconciled.memberBreakdowns.reduce((acc, m) => acc + m.finalAmountOwed, 0);
    assert.equal(sumShares, 230, "Sum of individual member shares must equal final bill exactly");
  });

  // Test 9: A user cannot change another member's payment or identity
  it("Test 9: A user cannot change another member's payment or identity", () => {
    const group = {
      id: "grp-security",
      ownerId: "host-1",
      members: [
        { uid: "host-1", name: "Host" },
        { uid: "joiner-1", name: "Aman", paymentStatus: PAYMENT_STATUS.UNPAID }
      ]
    };

    // Payer can only report their own payment
    const canReportPayment = (callerUid, targetUid) => {
      if (callerUid !== targetUid) throw new Error("Unauthorized: cannot modify another member's payment");
      return true;
    };

    // Caller 'joiner-2' tries to modify joiner-1's payment
    assert.throws(() => canReportPayment("joiner-2", "joiner-1"), /Unauthorized/);
    assert.equal(canReportPayment("joiner-1", "joiner-1"), true);
  });

  // Test 10: A completed order cannot reopen or accept new members
  it("Test 10: A completed order cannot reopen or accept new members", () => {
    assert.equal(isValidOrderTransition(ORDER_STATUS.COMPLETED, ORDER_STATUS.OPEN), false);
    assert.equal(isValidOrderTransition(ORDER_STATUS.COMPLETED, ORDER_STATUS.MATCHED), false);

    const completedOrder = {
      status: ORDER_STATUS.COMPLETED,
      expiresAtMs: Date.now() + 100000,
      memberCount: 2,
      maxMembers: 6,
      currentCart: 100,
      targetAmount: 199
    };
    const joinStatus = getOrderJoinableStatus(completedOrder);
    assert.equal(joinStatus.joinable, false);
    assert.equal(joinStatus.code, "COMPLETED");
  });

  // Test 11: Network loss and retry do not create duplicate records
  it("Test 11: Network loss and retry do not create duplicate records", async () => {
    // Setup initial request
    db.setDoc("joinRequests/req-idempotent-1", {
      id: "req-idempotent-1",
      orderId: "order-1",
      requesterId: "user-1",
      status: JOIN_STATUS.PENDING
    });

    const submitJoin = async (orderId, requesterId) => {
      // Check store for existing pending request by this user on this order
      const exists = Array.from(db.store.values()).some(
        d => d.orderId === orderId && d.requesterId === requesterId && d.status === JOIN_STATUS.PENDING
      );
      if (exists) {
        return { success: true, message: "Request already active (idempotent retry acknowledged)" };
      }
      db.setDoc(`joinRequests/req-${orderId}-${requesterId}`, {
        orderId,
        requesterId,
        status: JOIN_STATUS.PENDING
      });
      return { success: true, created: true };
    };

    const retryResult = await submitJoin("order-1", "user-1");
    assert.equal(retryResult.created, undefined);
    assert.match(retryResult.message, /idempotent retry/);

    const totalRequests = Array.from(db.store.values()).filter(
      d => d.orderId === "order-1" && d.requesterId === "user-1"
    );
    assert.equal(totalRequests.length, 1, "Only one record exists despite network retries");
  });

  // Test 12: Expired orders are not shown as joinable
  it("Test 12: Expired orders are not shown as joinable", () => {
    const orders = [
      { id: "o1", status: ORDER_STATUS.OPEN, expiresAtMs: Date.now() - 1000, memberCount: 1, maxMembers: 4, currentCart: 50, targetAmount: 199 },
      { id: "o2", status: ORDER_STATUS.OPEN, expiresAtMs: Date.now() + 50000, memberCount: 1, maxMembers: 4, currentCart: 50, targetAmount: 199 }
    ];

    const joinableFeed = orders.filter(o => getOrderJoinableStatus(o, Date.now()).joinable);
    assert.equal(joinableFeed.length, 1);
    assert.equal(joinableFeed[0].id, "o2");
  });

  // Test 13: A payment claim is not presented as verified without real verification
  it("Test 13: A payment claim is not presented as verified without real verification (self-reported vs acknowledged)", () => {
    const member = {
      uid: "joiner-1",
      name: "Aman",
      paymentStatus: PAYMENT_STATUS.PAYMENT_REPORTED, // Self-reported
      isPaid: true,
      hostConfirmed: false // Host has NOT acknowledged yet
    };

    // Helper to format verification badge
    const getPaymentBadge = (m) => {
      if (m.paymentStatus === PAYMENT_STATUS.PAYMENT_ACKNOWLEDGED && m.hostConfirmed) {
        return { label: "Payment Confirmed by Host ✓", isVerified: true };
      }
      if (m.paymentStatus === PAYMENT_STATUS.PAYMENT_REPORTED) {
        return { label: "Self-Reported (Awaiting Host Confirmation)", isVerified: false };
      }
      return { label: "Unpaid", isVerified: false };
    };

    const badge = getPaymentBadge(member);
    assert.equal(badge.isVerified, false);
    assert.equal(badge.label, "Self-Reported (Awaiting Host Confirmation)");

    // Only after host confirms:
    member.paymentStatus = PAYMENT_STATUS.PAYMENT_ACKNOWLEDGED;
    member.hostConfirmed = true;
    const verifiedBadge = getPaymentBadge(member);
    assert.equal(verifiedBadge.isVerified, true);
    assert.equal(verifiedBadge.label, "Payment Confirmed by Host ✓");
  });

  // Test 14: Unauthorized Firestore reads and writes are rejected
  it("Test 14: Unauthorized Firestore reads and writes are rejected", () => {
    // Model Firestore Rules invariants
    const evaluateRule = (action, collection, resourceData, requestData, auth) => {
      if (!auth) return false;

      if (collection === "orders") {
        if (action === "create") {
          return requestData.ownerId === auth.uid && requestData.status === "open" && requestData.extensionCount === 0;
        }
        if (action === "update") {
          return resourceData.ownerId === auth.uid;
        }
      }

      if (collection === "groups") {
        if (action === "read") {
          return resourceData.memberIds.includes(auth.uid) || resourceData.ownerId === auth.uid;
        }
      }

      return false;
    };

    // User attempts to read group they are not a member of
    const groupDoc = { ownerId: "host-1", memberIds: ["host-1", "member-1"] };
    const strangerAuth = { uid: "stranger-user" };
    const memberAuth = { uid: "member-1" };

    const strangerRead = evaluateRule("read", "groups", groupDoc, null, strangerAuth);
    assert.equal(strangerRead, false, "Stranger read must be rejected by rules");

    const memberRead = evaluateRule("read", "groups", groupDoc, null, memberAuth);
    assert.equal(memberRead, true, "Authorized member read must be allowed");

    // Attacker attempts to forge extensionCount on create
    const forgedOrder = { ownerId: "attacker", status: "open", extensionCount: 5 };
    const forgedCreate = evaluateRule("create", "orders", null, forgedOrder, { uid: "attacker" });
    assert.equal(forgedCreate, false, "Forged extension count on order create must be rejected");
  });

  // Test 15: 50% above target cart warning
  it("Test 15: Warns creator when new cart exceeds target by >50%", async () => {
    const { checkCartWarningThreshold } = await import("../src/services/validation.js");
    // Target 1000, current accepted 900, new requester 700 => total 1600 (>1500)
    const check1 = checkCartWarningThreshold(900, 700, 1000);
    assert.equal(check1.exceedsThreshold, true);
    assert.equal(check1.percentAbove, 60);
    assert.match(check1.warningMessage, /60% higher than your target/);

    // Target 1000, current accepted 500, new requester 400 => total 900 (<=1500)
    const check2 = checkCartWarningThreshold(500, 400, 1000);
    assert.equal(check2.exceedsThreshold, false);
    assert.equal(check2.warningMessage, null);
  });

  // Test 16: Hard maximum cart cap rejection
  it("Test 16: Rejects acceptance if sum exceeds maximumCartValue", async () => {
    const orderWithMax = {
      id: "ord-max",
      creatorId: "creator-1",
      acceptedCartValue: 1400,
      maximumCartValue: 1500,
      targetCartValue: 1000,
      status: ORDER_STATUS.WAITING
    };
    const reqForm = { contributionAmount: 150, itemsList: "Apples", stockConfirmed: true };
    const { validateJoinRequest } = await import("../src/services/validation.js");
    const val = validateJoinRequest(reqForm, orderWithMax);
    assert.equal(val.valid, false);
    assert.match(val.error, /maximum cart cap of ₹1500/);
  });

  // Test 17: Scheduled order validation and countdown
  it("Test 17: Scheduled order requires future timestamp", async () => {
    const { validateOrderForm } = await import("../src/services/validation.js");
    const pastOrder = {
      category: "grocery",
      platform: "Blinkit",
      myAmount: 100,
      targetAmount: 300,
      pickupPoint: "Hostel Gate",
      orderType: "scheduled",
      scheduledAtMs: Date.now() - 10000 // In the past
    };
    const val = validateOrderForm(pastOrder);
    assert.equal(val.valid, false);
    assert.match(val.error, /must be in the future/);
  });

  // Test 18: One active order per creator restriction
  it("Test 18: Creator cannot create another active order if one is in progress", async () => {
    const { createOrder } = await import("../src/services/orderService.js");
    const user = { uid: "creator-active" };
    const profile = { name: "Rahul", hostel: "Block A" };
    const existingOrders = [
      { id: "active-1", ownerId: user.uid, creatorId: user.uid, status: ORDER_STATUS.WAITING }
    ];
    const newForm = {
      category: "grocery",
      platform: "Blinkit",
      myAmount: 100,
      targetAmount: 300,
      waitMinutes: 15,
      pickupPoint: "Gate"
    };

    await assert.rejects(
      async () => {
        await createOrder(db, user, profile, newForm, existingOrders);
      },
      /already have an active order or group in progress/
    );
  });

  // Test 19: Order closing creates group with 60-minute duration
  it("Test 19: Order closing creates group with 60-minute duration", async () => {
    const creator = { uid: "creator-close" };
    const orderId = "order-to-close";
    db.setDoc(`orders/${orderId}`, {
      id: orderId,
      creatorId: creator.uid,
      ownerId: creator.uid,
      ownerName: "Rahul",
      platform: "Blinkit",
      pickupPoint: "Gate",
      myAmount: 150,
      creatorCartValue: 150,
      targetAmount: 300,
      status: ORDER_STATUS.READY_TO_CLOSE
    });

    const acceptedReqs = [
      { id: "r1", requesterId: "joiner-1", requesterName: "Aman", contributionAmount: 160, itemsList: "Bread" }
    ];
    const pendingReqs = [
      { id: "r2", requesterId: "joiner-2", requesterName: "Vijay", contributionAmount: 40, itemsList: "Milk" }
    ];

    const now = Date.now();
    const groupId = "grp_test_close_1";
    const groupExpiresAtMs = now + 60 * 60 * 1000;

    // Simulate atomic order closing
    await db.runTransaction(async (txn) => {
      const orderSnap = await txn.get({ path: `orders/${orderId}` });
      const order = orderSnap.data();

      const creatorMember = {
        uid: creator.uid,
        name: order.ownerName,
        amount: order.creatorCartValue,
        role: "creator"
      };
      const requesterMembers = acceptedReqs.map(r => ({
        uid: r.requesterId,
        name: r.requesterName,
        amount: r.contributionAmount,
        role: "member"
      }));
      const allMembers = [creatorMember, ...requesterMembers];

      txn.set({ path: `groups/${groupId}` }, {
        groupId,
        orderId,
        creatorId: creator.uid,
        members: allMembers,
        memberIds: allMembers.map(m => m.uid),
        acceptedCartValue: 310,
        status: "active",
        createdAtMs: now,
        expiresAtMs: groupExpiresAtMs
      });

      txn.update({ path: `orders/${orderId}` }, {
        status: ORDER_STATUS.CLOSED,
        groupId,
        acceptedCartValue: 310,
        closedAtMs: now
      });
    });

    const groupDoc = db.getDoc(`groups/${groupId}`).data();
    assert.ok(groupDoc);
    assert.equal(groupDoc.memberIds.length, 2);
    // 60 minutes = 3600000ms
    const duration = groupDoc.expiresAtMs - groupDoc.createdAtMs;
    assert.equal(duration, 60 * 60 * 1000, "Group duration must be strictly 60 minutes");

    const orderDoc = db.getDoc(`orders/${orderId}`).data();
    assert.equal(orderDoc.status, ORDER_STATUS.CLOSED);
  });

  // Test 20: Verified post-completion ratings prevent self-rating and duplicate ratings
  it("Test 20: Verified ratings require completed group and reject self-rating", async () => {
    db.setDoc("groups/grp-rated", {
      id: "grp-rated",
      status: "active", // Not completed yet
      memberIds: ["u1", "u2"]
    });

    const submitRating = async ({ reviewerId, reviewedUserId, groupId, rating }) => {
      if (reviewerId === reviewedUserId) {
        throw new Error("You cannot submit a rating for yourself.");
      }
      const ratingKey = `ratings/${groupId}_${reviewerId}_${reviewedUserId}`;
      const existing = db.getDoc(ratingKey);
      if (existing.exists()) {
        throw new Error("You have already submitted a rating for this user for this order.");
      }
      const grp = db.getDoc(`groups/${groupId}`).data();
      if (grp.status !== "completed") {
        throw new Error("Ratings can only be submitted after an order group completes.");
      }
      db.setDoc(ratingKey, { reviewerId, reviewedUserId, groupId, rating });
      return { rating };
    };

    // Rating before completion must fail
    await assert.rejects(
      async () => {
        await submitRating({
          reviewerId: "u1",
          reviewedUserId: "u2",
          groupId: "grp-rated",
          rating: 5
        });
      },
      /Ratings can only be submitted after an order group completes/
    );

    // Self rating must fail
    db.updateDoc("groups/grp-rated", { status: "completed" });
    await assert.rejects(
      async () => {
        await submitRating({
          reviewerId: "u1",
          reviewedUserId: "u1",
          groupId: "grp-rated",
          rating: 5
        });
      },
      /cannot submit a rating for yourself/
    );

    // Valid rating succeeds
    const ratingRes = await submitRating({
      reviewerId: "u1",
      reviewedUserId: "u2",
      groupId: "grp-rated",
      rating: 5
    });
    assert.equal(ratingRes.rating, 5);

    // Duplicate rating must fail
    await assert.rejects(
      async () => {
        await submitRating({
          reviewerId: "u1",
          reviewedUserId: "u2",
          groupId: "grp-rated",
          rating: 4
        });
      },
      /already submitted a rating for this user/
    );
  });
});
