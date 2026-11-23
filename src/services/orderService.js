/**
 * Authoritative Order Management Service
 * 
 * Conforms to OrderNearMe Master Project Specification.
 * Enforces:
 * - One active order per creator lifecycle rule.
 * - Immediate vs Scheduled orders.
 * - Authoritative expiration timestamp.
 * - Extension rule: 5 minutes per extension, max 2 extensions (+10 mins max).
 * - Atomic closing of orders and idempotent group creation with 60-minute lifecycle.
 */

import {
  collection,
  doc,
  addDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "firebase/firestore";
import {
  ORDER_STATUS,
  GROUP_STATUS,
  REQUEST_STATUS,
  NOTIFICATION_TYPES,
  isValidOrderTransition
} from "../constants/orderLifecycle.js";
import {
  validateOrderForm,
  MAX_EXTENSIONS_LIMIT,
  EXTENSION_DURATION_MINUTES,
  GROUP_LIFECYCLE_MINUTES
} from "./validation.js";
import { sendNotification } from "./notificationService.js";

/**
 * Creates an authoritative Order document in Firestore.
 * Enforces: One active order per creator rule.
 */
export async function createOrder(db, user, profile, orderForm, existingUserOrders = []) {
  if (!user || !user.uid) {
    throw new Error("Authentication required to post an order.");
  }

  // Enforce Section 6 & 14: One active order per creator
  const nowTime = Date.now();
  const GROUP_LIFESPAN_MS = (GROUP_LIFECYCLE_MINUTES || 60) * 60 * 1000;

  const activeOrders = existingUserOrders.filter((o) => {
    const isOwner = o.ownerId === user.uid || o.creatorId === user.uid;
    if (!isOwner) return false;

    // Terminal statuses never block
    if ([
      ORDER_STATUS.COMPLETED,
      ORDER_STATUS.CANCELLED,
      ORDER_STATUS.ALONE,
      ORDER_STATUS.EXPIRED,
      ORDER_STATUS.CLOSED_WITHOUT_GROUP
    ].includes(o.status)) {
      return false;
    }

    // Any order older than the 60-minute lifecycle is expired and never blocks
    const orderAge = nowTime - Number(o.createdAtMs || 0);
    if (o.createdAtMs && orderAge >= GROUP_LIFESPAN_MS) {
      return false;
    }

    // If order was closed to form a group, check if the 60-minute group duration has passed
    if (o.status === ORDER_STATUS.CLOSED) {
      const closedAt = Number(o.closedAtMs || o.createdAtMs || 0);
      if (closedAt > 0 && nowTime - closedAt >= GROUP_LIFESPAN_MS) {
        return false; // Group 60-minute window has expired
      }
    }

    // If order waiting timer expired
    const expTime = Number(o.expiresAtMs || o.requestExpiresAtMs || 0);
    if (expTime > 0 && nowTime >= expTime && o.status !== ORDER_STATUS.READY_TO_CLOSE && o.status !== ORDER_STATUS.MATCHED) {
      return false;
    }

    return true;
  });

  if (activeOrders.length > 0) {
    throw new Error("You already have an active order or group in progress. You can create another once it completes, expires, or is cancelled.");
  }

  const valResult = validateOrderForm(orderForm);
  if (!valResult.valid) {
    throw new Error(valResult.error);
  }

  const myCartVal = Math.round(Number(orderForm.myAmount));
  const targetVal = Math.round(Number(orderForm.targetAmount));
  const maxCartVal = orderForm.maximumCartValue ? Math.round(Number(orderForm.maximumCartValue)) : null;
  const orderType = (orderForm.orderType || "immediate").toLowerCase();
  const now = Date.now();

  let waitMinutes = 15;
  let expiresAtMs = 0;
  let scheduledAtMs = null;
  let initialStatus = ORDER_STATUS.WAITING;

  if (orderType === "scheduled") {
    scheduledAtMs = Number(orderForm.scheduledAtMs || orderForm.scheduledAt);
    initialStatus = ORDER_STATUS.SCHEDULED;
    // Scheduled orders request closing time (default 15 mins before scheduled time or custom)
    const requestClosingMinutes = Number(orderForm.requestClosingMinutes || 15);
    expiresAtMs = scheduledAtMs - (requestClosingMinutes * 60 * 1000);
    if (expiresAtMs <= now) {
      expiresAtMs = scheduledAtMs;
    }
  } else {
    waitMinutes = Number(orderForm.waitMinutes || 15);
    expiresAtMs = now + waitMinutes * 60 * 1000;
    initialStatus = ORDER_STATUS.WAITING;
  }

  const maxMembers = Number(orderForm.maxMembers || 6);

  const orderData = {
    creatorId: user.uid,
    ownerId: user.uid, // backward compatible
    ownerName: profile?.name || user.displayName || "Host",
    ownerPhoto: profile?.photo || user.photoURL || "",
    ownerVerified: !!profile?.verifiedStudent,
    ownerRating:
      profile?.ratingCount > 0
        ? (profile.ratingSum / profile.ratingCount).toFixed(1)
        : "5.0",
    completedOrdersCount: profile?.completedOrdersCount || 0,
    college: profile?.college || "Campus Community",
    hostel: orderForm.hostel || profile?.hostel || profile?.address || "Campus Block",
    address: orderForm.address || orderForm.hostel || profile?.address || profile?.hostel || "Campus Block",
    lat: orderForm.lat ?? profile?.lat ?? null,
    lng: orderForm.lng ?? profile?.lng ?? null,
    category: "grocery",
    platform: orderForm.platform,
    orderMode: orderForm.orderMode || "meet",
    orderType,
    scheduledAtMs,
    placeOrNote: (orderForm.placeOrNote || "").trim(),
    description: (orderForm.description || orderForm.placeOrNote || "").trim(),
    pickupPoint: (orderForm.pickupPoint || "Hostel Gate").trim(),
    
    // Explicit cart separation (Spec Section 11):
    creatorCartValue: myCartVal,
    myAmount: myCartVal, // backward compatible
    targetCartValue: targetVal,
    targetAmount: targetVal, // backward compatible
    maximumCartValue: maxCartVal,
    acceptedCartValue: myCartVal,
    currentCart: myCartVal, // backward compatible
    pendingPotentialCartValue: 0,
    
    participantCount: 1,
    memberCount: 1, // backward compatible
    pendingRequestCount: 0,
    acceptedRequesterIds: [],
    
    deliveryFee: Math.max(0, Number(orderForm.deliveryFee) || 30),
    waitMinutes,
    expiresAtMs,
    requestExpiresAtMs: expiresAtMs,
    extensionCount: 0,
    maxExtensions: MAX_EXTENSIONS_LIMIT, // 2 extensions max
    maxMembers,
    status: initialStatus,
    groupId: null,
    createdAtMs: now,
    createdAt: serverTimestamp()
  };

  const docRef = await addDoc(collection(db, "orders"), orderData);

  // Update user's activeOrderId pointer
  try {
    const userRef = doc(db, "users", user.uid);
    await setDoc(userRef, { activeOrderId: docRef.id, updatedAtMs: now }, { merge: true });
  } catch (err) {
    console.error("Error setting activeOrderId on user:", err);
  }

  return { id: docRef.id, ...orderData };
}

/**
 * Atomically extends an order's waiting timer by 5 minutes.
 * Spec Section 17: Maximum 2 extensions (5 + 5 = 10 mins extra time).
 */
export async function extendOrderAtomic(db, orderId, userId, maxExtensions = MAX_EXTENSIONS_LIMIT) {
  if (!orderId || !userId) {
    throw new Error("Order ID and User ID are required.");
  }

  const orderRef = doc(db, "orders", orderId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists()) {
      throw new Error("Order does not exist.");
    }

    const order = snap.data();
    if (order.creatorId !== userId && order.ownerId !== userId) {
      throw new Error("Only the creator can extend this order.");
    }

    if ([ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED, ORDER_STATUS.ALONE, ORDER_STATUS.CLOSED].includes(order.status)) {
      throw new Error(`Cannot extend an order with status '${order.status}'.`);
    }

    const curCount = Number(order.extensionCount || 0);
    const limit = Number(order.maxExtensions || maxExtensions);

    if (curCount >= limit) {
      throw new Error(`Maximum extensions reached (${limit}/${limit}). No further extension allowed.`);
    }

    const baseTime = Math.max(Number(order.expiresAtMs || 0), Date.now());
    const newExpiresAtMs = baseTime + EXTENSION_DURATION_MINUTES * 60 * 1000;
    const newCount = curCount + 1;

    txn.update(orderRef, {
      expiresAtMs: newExpiresAtMs,
      requestExpiresAtMs: newExpiresAtMs,
      extensionCount: newCount,
      status: ORDER_STATUS.WAITING
    });

    return {
      orderId,
      newExpiresAtMs,
      extensionCount: newCount,
      maxExtensions: limit
    };
  });
}

/**
 * Atomically cancels an order and resets active pointers.
 */
export async function cancelOrderAtomic(db, orderId, userId, reason = "Creator cancelled order") {
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", userId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists()) {
      throw new Error("Order does not exist.");
    }
    const order = snap.data();
    if (order.creatorId !== userId && order.ownerId !== userId) {
      throw new Error("Only the creator can cancel this order.");
    }
    if (order.status === ORDER_STATUS.COMPLETED) {
      throw new Error("Cannot cancel a completed order.");
    }

    txn.update(orderRef, {
      status: ORDER_STATUS.CANCELLED,
      cancellationReason: reason,
      closedAtMs: Date.now()
    });

    txn.update(userRef, { activeOrderId: null });

    return { orderId, status: ORDER_STATUS.CANCELLED };
  });
}

/**
 * Creator marks order to proceed alone directly on retailer app.
 */
export async function proceedAloneAtomic(db, orderId, userId) {
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", userId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists()) throw new Error("Order does not exist.");
    const order = snap.data();
    if (order.creatorId !== userId && order.ownerId !== userId) throw new Error("Only creator can order alone.");

    txn.update(orderRef, {
      status: ORDER_STATUS.ALONE,
      closedAtMs: Date.now()
    });

    txn.update(userRef, { activeOrderId: null });

    return { orderId, status: ORDER_STATUS.ALONE };
  });
}

/**
 * Atomically closes an order and creates the associated group exactly once (Spec Section 13 & 19).
 * - Sets order status to CLOSED (or CLOSED_WITHOUT_GROUP if no accepted requesters).
 * - Resolves pending requests to EXPIRED.
 * - Idempotently creates groups/{groupId} with a strict 60-minute duration.
 */
export async function closeOrderAndCreateGroupAtomic(db, orderId, userId, acceptedRequests = [], pendingRequests = []) {
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", userId);

  const result = await runTransaction(db, async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists()) throw new Error("Order does not exist.");
    const order = snap.data();

    if (order.creatorId !== userId && order.ownerId !== userId) {
      throw new Error("Only the creator can close this order.");
    }

    if (order.status === ORDER_STATUS.CLOSED && order.groupId) {
      return { alreadyClosed: true, groupId: order.groupId };
    }

    const now = Date.now();
    const hasAccepted = acceptedRequests.length > 0;

    if (!hasAccepted) {
      // Close without group
      txn.update(orderRef, {
        status: ORDER_STATUS.CLOSED_WITHOUT_GROUP,
        closedAtMs: now
      });
      txn.update(userRef, { activeOrderId: null });
      return { closedWithoutGroup: true };
    }

    // Build authoritative members list: Creator + Accepted requesters
    const creatorMember = {
      uid: userId,
      name: order.ownerName || "Creator",
      photo: order.ownerPhoto || "",
      amount: order.creatorCartValue || order.myAmount || 0,
      merchandiseAmount: order.creatorCartValue || order.myAmount || 0,
      items: order.description || order.placeOrNote || "Host items",
      role: "creator",
      joinedAtMs: order.createdAtMs || now,
      status: "active"
    };

    const requesterMembers = acceptedRequests.map((r) => ({
      uid: r.requesterId,
      name: r.requesterName,
      photo: r.requesterPhoto || "",
      amount: Number(r.contributionAmount || 0),
      merchandiseAmount: Number(r.contributionAmount || 0),
      items: r.itemsList || "Requested items",
      role: "member",
      joinedAtMs: r.respondedAtMs || now,
      status: "active"
    }));

    const allMembers = [creatorMember, ...requesterMembers];
    const memberIds = allMembers.map((m) => m.uid);
    const totalAcceptedCart = allMembers.reduce((sum, m) => sum + Number(m.amount || 0), 0);

    // Group 60-Minute Lifecycle: Spec Section 19
    const groupExpiresAtMs = now + GROUP_LIFECYCLE_MINUTES * 60 * 1000;
    const groupRef = doc(collection(db, "groups"));
    const groupId = groupRef.id;

    const groupData = {
      groupId,
      orderId,
      creatorId: userId,
      ownerId: userId, // backward compatible
      ownerName: order.ownerName || "Creator",
      ownerPhoto: order.ownerPhoto || "",
      platform: order.platform,
      pickupPoint: order.pickupPoint || "Hostel Gate",
      orderMode: order.orderMode || "meet",
      category: order.category || "grocery",
      members: allMembers,
      memberIds,
      acceptedCartValue: totalAcceptedCart,
      totalCart: totalAcceptedCart, // backward compatible
      targetCartValue: order.targetCartValue || order.targetAmount || 199,
      deliveryFee: order.deliveryFee || 30,
      status: GROUP_STATUS.ACTIVE,
      createdAtMs: now,
      expiresAtMs: groupExpiresAtMs,
      createdAt: serverTimestamp()
    };

    txn.set(groupRef, groupData);

    txn.update(orderRef, {
      status: ORDER_STATUS.CLOSED,
      groupId,
      acceptedCartValue: totalAcceptedCart,
      currentCart: totalAcceptedCart,
      closedAtMs: now
    });

    txn.update(userRef, {
      activeOrderId: null,
      activeGroupId: groupId
    });

    return {
      success: true,
      groupId,
      memberIds,
      groupExpiresAtMs
    };
  });

  // Post-transaction: update pending requests to EXPIRED and notify members
  if (result.success) {
    for (const pending of pendingRequests) {
      try {
        const reqRef = doc(db, "joinRequests", pending.id);
        await setDoc(reqRef, {
          status: REQUEST_STATUS.EXPIRED,
          respondedAtMs: Date.now(),
          expirationReason: "Order closed and formed group"
        }, { merge: true });

        await sendNotification(db, {
          recipientId: pending.requesterId,
          type: NOTIFICATION_TYPES.ORDER_CLOSED,
          title: "Order Closed",
          body: `The order was closed by the creator. Your pending request has expired.`,
          orderId
        });
      } catch (e) {
        console.error("Error expiring pending request:", e);
      }
    }

    // Notify accepted members about group creation
    for (const member of acceptedRequests) {
      await sendNotification(db, {
        recipientId: member.requesterId,
        type: NOTIFICATION_TYPES.GROUP_CREATED,
        title: "Order Group Created!",
        body: `Order was closed and your group is now active! Coordinate purchase in the group room.`,
        orderId,
        groupId: result.groupId
      });
    }
  }

  return result;
}
